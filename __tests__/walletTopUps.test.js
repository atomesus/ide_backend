const { randomUUID } = require("crypto");
const { bootTestApp, shutdownTestApp, createPlatformUser, request } = require("./helpers");
const { IdeWallet, IdeTopUp, IdeWalletTopUp } = require("../src/models/sql");
const wallets = require("../src/services/walletService");
const users = require("../src/services/userService");

let app;
beforeAll(async () => { app = await bootTestApp(); });
afterAll(shutdownTestApp);

/** What the platform writes after a paid top-up checkout (zero_thought_node src/ideBilling). */
const paidTopUp = (userId, walletCredits, extra = {}) => IdeTopUp.create({
  id: randomUUID(), userId, provider: "razorpay", currency: "INR", amountMinor: 10000, walletCredits, status: "paid", paidAt: new Date(), ...extra,
});

describe("wallet top-ups", () => {
  it("adds each paid platform top-up to the wallet once and reports it in /api/usage", async () => {
    const { token, user } = await createPlatformUser(app, { idePlan: "ide_299" });
    await paidTopUp(user.id, 575300);
    await paidTopUp(user.id, 100000);
    await IdeTopUp.create({ id: randomUUID(), userId: user.id, provider: "razorpay", currency: "INR", amountMinor: 10000, walletCredits: 999999, status: "created" });
    const first = await request(app).get("/api/usage").set("authorization", `Bearer ${token}`).expect(200);
    // Rs 172 plan + Rs 67.53 of top-ups, nothing spent: 100% left, with a top-up in the wallet.
    expect(first.body.limits).toMatchObject({ remainingPercent: 100, status: "ok", hasTopUp: true });
    expect(await IdeWallet.findByPk(user.id)).toMatchObject({ subscriptionCredits: 1720000, topUpCredits: 675300 });
    expect(first.body.topUpUrl).toBe("https://www.atomesus.com/code#topup");
    const again = await request(app).get("/api/usage").set("authorization", `Bearer ${token}`).expect(200);
    expect((await IdeWallet.findByPk(user.id)).topUpCredits).toBe(675300);
    expect(again.body.limits.hasTopUp).toBe(true);
    expect(await IdeWalletTopUp.count({ where: { userId: user.id } })).toBe(2);
  });

  it("spends subscription credits first, then top-ups, and top-ups survive the monthly refill", async () => {
    const { user } = await createPlatformUser(app, { idePlan: "ide_299" });
    const u = await users.findById(user.id);
    await paidTopUp(user.id, 50000);
    let wallet = await wallets.ensureWallet(u);
    await wallets.deduct(wallet, 1720000 + 20000);
    wallet = await IdeWallet.findByPk(user.id);
    expect(wallet.subscriptionCredits).toBe(0);
    expect(wallet.topUpCredits).toBe(30000);
    // Period over: the plan budget refills, the remaining top-up stays.
    await IdeWallet.update({ billingPeriodStart: new Date(Date.now() - 31 * 86400000) }, { where: { userId: user.id } });
    wallet = await wallets.ensureWallet(u);
    expect(wallet.subscriptionCredits).toBe(1720000);
    expect(wallet.topUpCredits).toBe(30000);
  });

  it("a top-up paid while the account is free waits in the wallet and is usable once a plan exists", async () => {
    const { token, user } = await createPlatformUser(app);
    await paidTopUp(user.id, 10000);
    const usage = await request(app).get("/api/usage").set("authorization", `Bearer ${token}`).expect(200);
    expect((await IdeWallet.findByPk(user.id)).topUpCredits).toBe(10000);
    expect(usage.body.limits).toMatchObject({ remainingPercent: 0, status: "none", hasTopUp: true });
    expect(usage.body.entitlements.paid).toBe(false);
    global.fetch = jest.fn();
    const chat = await request(app).post("/api/v1/chat/completions").set("authorization", `Bearer ${token}`).send({ model: "opus-5.5", messages: [{ role: "user", content: "hi" }] }).expect(402);
    expect(chat.body.error.code).toBe("plan_required");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("reports only the share of the budget left, falling to low and then exhausted", async () => {
    const { token, user } = await createPlatformUser(app, { idePlan: "ide_299" });
    const pct = async () => (await request(app).get("/api/usage").set("authorization", `Bearer ${token}`).expect(200)).body.limits;
    expect(await pct()).toMatchObject({ remainingPercent: 100, status: "ok" });
    await IdeWallet.update({ subscriptionCredits: 860000 }, { where: { userId: user.id } });
    expect(await pct()).toMatchObject({ remainingPercent: 50, status: "ok" });
    await IdeWallet.update({ subscriptionCredits: 100000 }, { where: { userId: user.id } });
    expect(await pct()).toMatchObject({ remainingPercent: 5, status: "low" });
    await IdeWallet.update({ subscriptionCredits: 1 }, { where: { userId: user.id } });
    expect(await pct()).toMatchObject({ remainingPercent: 1, status: "low" });
    await IdeWallet.update({ subscriptionCredits: 0 }, { where: { userId: user.id } });
    expect(await pct()).toMatchObject({ remainingPercent: 0, status: "exhausted" });
    // A top-up while the plan budget is gone: everything left is top-up.
    await paidTopUp(user.id, 860000);
    expect(await pct()).toMatchObject({ remainingPercent: 33, status: "ok", hasTopUp: true });
    const limits = await pct();
    expect(new Date(limits.resetsAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("tells the IDE to show rupees in India and dollars elsewhere, like the platform's payment routing", async () => {
    const indian = await createPlatformUser(app, { idePlan: "ide_299" });
    const usageFrom = async (u, country) => {
      const r = request(app).get("/api/usage").set("authorization", `Bearer ${u.token}`);
      if (country) r.set("cf-ipcountry", country);
      return (await r.expect(200)).body;
    };
    expect(await usageFrom(indian, "IN")).toMatchObject({ region: "IN", currency: "INR" });
    // The IP country wins over the account country, as at checkout.
    expect(await usageFrom(indian, "US")).toMatchObject({ region: "INTL", currency: "USD" });
    // No usable IP country: the account's country, and India for old accounts without one.
    const american = await createPlatformUser(app, { country: "United States" });
    expect(await usageFrom(american)).toMatchObject({ region: "INTL", currency: "USD" });
    expect(await usageFrom(american, "XX")).toMatchObject({ region: "INTL", currency: "USD" });
    expect(await usageFrom(await createPlatformUser(app))).toMatchObject({ region: "IN", currency: "INR" });
    expect(await usageFrom(await createPlatformUser(app, { country: "India" }))).toMatchObject({ region: "IN", currency: "INR" });

    // The plan-required message names the prices in the user's currency.
    global.fetch = jest.fn();
    const send = (u, country) => request(app).post("/api/v1/chat/completions").set("authorization", `Bearer ${u.token}`).set("cf-ipcountry", country).send({ model: "ethos-6", messages: [{ role: "user", content: "hi" }] }).expect(402);
    expect((await send(american, "US")).body.message).toMatch(/\$4 or \$10/);
    expect((await send(american, "IN")).body.message).toMatch(/₹299 or ₹999/);
  });

  it("the budget message points at top-ups", async () => {
    const { token, user } = await createPlatformUser(app, { idePlan: "ide_299" });
    await wallets.ensureWallet(await users.findById(user.id));
    await IdeWallet.update({ subscriptionCredits: 0, topUpCredits: 0 }, { where: { userId: user.id } });
    const res = await request(app).post("/api/v1/chat/completions").set("authorization", `Bearer ${token}`).send({ model: "opus-5.5", messages: [{ role: "user", content: "hi" }] }).expect(402);
    expect(res.body.error.code).toBe("insufficient_credits");
    expect(res.body.message).toMatch(/atomesus\.com\/code#topup/);
  });

  it("deleting IDE data drops the wallet and its top-up ledger", async () => {
    const { token, user } = await createPlatformUser(app, { idePlan: "ide_299" });
    await paidTopUp(user.id, 10000);
    await request(app).get("/api/usage").set("authorization", `Bearer ${token}`).expect(200);
    await request(app).delete("/api/account/ide-data").set("authorization", `Bearer ${token}`).send({ confirm: "DELETE" }).expect(200);
    expect(await IdeWallet.findByPk(user.id)).toBeNull();
    expect(await IdeWalletTopUp.count({ where: { userId: user.id } })).toBe(0);
  });

  it("still serves the wallet when the platform's IdeTopUps table does not exist yet", async () => {
    const { token } = await createPlatformUser(app, { idePlan: "ide_299" });
    await IdeTopUp.drop();
    try {
      const res = await request(app).get("/api/usage").set("authorization", `Bearer ${token}`).expect(200);
      expect(res.body.limits).toMatchObject({ remainingPercent: 100, status: "ok", hasTopUp: false });
    } finally {
      await IdeTopUp.sync();
    }
  });
});
