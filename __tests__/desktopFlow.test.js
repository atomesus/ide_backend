const jwt = require("jsonwebtoken");
const { bootTestApp, shutdownTestApp, createPlatformUser, request } = require("./helpers");
const pkce = require("../src/lib/pkce");
const { ApiKey } = require("../src/models/sql");

let app;
beforeAll(async () => { app = await bootTestApp(); });
afterAll(shutdownTestApp);

const REDIRECT = "atomesus://auth-callback?editor_state=abcdef0123456789abcdef0123456789";
const query = (challenge) => ({ client: "desktop", redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" });

describe("platform session + desktop sign-in", () => {
  it("accepts the platform's JWT and refuses admin/reset tokens", async () => {
    const { token, email } = await createPlatformUser(app);
    const me = await request(app).get("/api/auth/me").set("authorization", `Bearer ${token}`).expect(200);
    expect(me.body.data.user.email).toBe(email);
    expect(me.body.data.auth.kind).toBe("platform_session");
    const admin = jwt.sign({ id: "507f1f77bcf86cd799439011", email }, process.env.JWT_SECRET);
    await request(app).get("/api/auth/me").set("authorization", `Bearer ${admin}`).expect(401);
    const reset = jwt.sign({ email, purpose: "password_reset" }, process.env.JWT_SECRET);
    await request(app).get("/api/auth/me").set("authorization", `Bearer ${reset}`).expect(401);
    const unknown = jwt.sign({ id: "00000000-0000-4000-8000-000000000000", email }, process.env.JWT_SECRET);
    await request(app).get("/api/auth/me").set("authorization", `Bearer ${unknown}`).expect(401);
  });

  it("forwards the IDE's /desktop/login to the website with the same query", async () => {
    const res = await request(app).get("/desktop/login").query(query("c".repeat(43))).expect(302);
    const url = new URL(res.headers.location);
    expect(url.origin + url.pathname).toBe("http://localhost:3000/desktop/login");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("code_challenge")).toBe("c".repeat(43));
    const bad = await request(app).get("/desktop/signup").query({ ...query("c".repeat(43)), redirect_uri: "https://evil.example/cb?editor_state=abcdef0123456789abcdef0123456789" }).expect(302);
    expect(new URL(bad.headers.location).searchParams.get("error")).toBe("invalid_redirect_uri");
  });

  it("runs the PKCE desktop flow and issues a device key once", async () => {
    const { token } = await createPlatformUser(app);
    const verifier = pkce.generateVerifier();
    const challenge = pkce.challengeFor(verifier);

    await request(app).post("/api/auth/desktop/approve").send(query(challenge)).expect(401); // website session required
    const approved = await request(app).post("/api/auth/desktop/approve").set("authorization", `Bearer ${token}`).send(query(challenge)).expect(200);
    const url = new URL(approved.body.data.redirectTo);
    expect(url.protocol).toBe("atomesus:");
    expect(url.searchParams.get("editor_state")).toBe("abcdef0123456789abcdef0123456789");
    const code = url.searchParams.get("code");
    expect(code).toBeTruthy();

    await request(app).post("/api/auth/desktop/exchange").send({ code, codeVerifier: pkce.generateVerifier() }).expect(400); // wrong verifier burns the code
    const again = await request(app).post("/api/auth/desktop/approve").set("authorization", `Bearer ${token}`).send(query(challenge)).expect(200);
    const code2 = new URL(again.body.data.redirectTo).searchParams.get("code");

    const ex = await request(app).post("/api/auth/desktop/exchange").send({ code: code2, codeVerifier: verifier }).expect(200);
    expect(ex.body.token).toMatch(/^sk_/);
    expect(Date.parse(ex.body.session.expiresAt)).toBeGreaterThan(Date.now());
    expect(ex.body.user).toMatchObject({ id: expect.any(String), email: expect.any(String), plan: "free", image: null, githubLogin: null });
    await request(app).post("/api/auth/desktop/exchange").send({ code: code2, codeVerifier: verifier }).expect(400);

    const sk = ex.body.token;
    const models = await request(app).get("/api/v1/models").set("authorization", `Bearer ${sk}`).expect(200);
    expect(models.body.data[0].id).toBe("ethos-6");
    const usage = await request(app).get("/api/usage").set("authorization", `Bearer ${sk}`).expect(200);
    expect(usage.body.wallet.availableCredits).toBe("0.00"); // free plan: nothing
    expect(usage.body.entitlements).toMatchObject({ paid: false, byok: false, hostedModels: false });
    const devices = await request(app).get("/api/account/devices").set("authorization", `Bearer ${sk}`).expect(200);
    expect(devices.body.data.devices).toHaveLength(1);
    // a device key cannot approve further desktop sign-ins
    await request(app).post("/api/auth/desktop/approve").set("authorization", `Bearer ${sk}`).send(query(challenge)).expect(400);

    await request(app).delete("/api/auth/api-keys/current").set("authorization", `Bearer ${sk}`).expect(204);
    await request(app).get("/api/v1/models").set("authorization", `Bearer ${sk}`).expect(401);
    const keyRow = await ApiKey.findOne({ where: { keyPrefix: sk.slice(0, 10) } });
    expect(keyRow.revokedAt).toBeTruthy();
    expect(keyRow.keyHash).not.toContain(sk.slice(3, 20));
  });

  it("deny returns the deep link with error=access_denied without storing anything", async () => {
    const res = await request(app).post("/api/auth/desktop/deny").send(query("c".repeat(43))).expect(200);
    expect(res.body.data.redirectTo).toMatch(/error=access_denied/);
  });

  it("each IDE plan gets its rupee budget and BYOK; chat plans and lapsed IDE plans get nothing", async () => {
    const in299 = await createPlatformUser(app, { idePlan: "ide_299" });
    const u1 = await request(app).get("/api/usage").set("authorization", `Bearer ${in299.token}`).expect(200);
    expect(u1.body).toMatchObject({ currency: "INR", limits: { plan: "ide_299", monthlyCredits: "172.00" }, wallet: { availableCredits: "172.00" } });
    expect(u1.body.entitlements).toMatchObject({ paid: true, byok: true, hostedModels: true });
    const in999 = await createPlatformUser(app, { idePlan: "ide_999" });
    expect((await request(app).get("/api/usage").set("authorization", `Bearer ${in999.token}`)).body.limits.monthlyCredits).toBe("576.00");
    const us4 = await createPlatformUser(app, { idePlan: "ide_299", region: "INTL" });
    expect((await request(app).get("/api/usage").set("authorization", `Bearer ${us4.token}`)).body.limits).toMatchObject({ plan: "ide_299_intl", monthlyCredits: "220.00" });
    const us10 = await createPlatformUser(app, { idePlan: "ide_999", region: "INTL" });
    expect((await request(app).get("/api/usage").set("authorization", `Bearer ${us10.token}`)).body.limits.monthlyCredits).toBe("580.00");
    const chatPlan = await createPlatformUser(app, { planType: "prime" });
    const u2 = await request(app).get("/api/usage").set("authorization", `Bearer ${chatPlan.token}`).expect(200);
    expect(u2.body.entitlements).toMatchObject({ plan: "free", byok: false, hostedModels: false });
    const lapsed = await createPlatformUser(app, { idePlan: "ide_999", periodEndsInDays: -1 });
    const u3 = await request(app).get("/api/usage").set("authorization", `Bearer ${lapsed.token}`).expect(200);
    expect(u3.body.entitlements).toMatchObject({ plan: "free", byok: false, hostedModels: false });
    const halted = await createPlatformUser(app, { idePlan: "ide_299", status: "halted" });
    expect((await request(app).get("/api/auth/me").set("authorization", `Bearer ${halted.token}`)).body.data.user.entitlements.paid).toBe(false);
  });
});
