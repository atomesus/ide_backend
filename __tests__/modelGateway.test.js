const { bootTestApp, shutdownTestApp, createPlatformUser, request } = require("./helpers");
const gateway = require("../src/services/modelGatewayService");
const { IdeWallet } = require("../src/models/sql");
const wallets = require("../src/services/walletService");
const { creditsFor } = require("../src/services/usageService");
const { kv } = require("../src/db/redis");

let app;
beforeAll(async () => { app = await bootTestApp(); });
afterAll(shutdownTestApp);

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

function sse(lines) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(l + "\n\n"));
      controller.close();
    },
  });
}

const okStream = (usage) => new Response(sse([
  'data: {"id":"1","choices":[{"delta":{"content":"Hello"}}]}',
  `data: ${JSON.stringify({ id: "1", choices: [], usage })}`,
  "data: [DONE]",
]), { status: 200, headers: { "content-type": "text/event-stream" } });

const chat = (token, model, extra = {}) => request(app).post("/api/v1/chat/completions").set("authorization", `Bearer ${token}`).send({ model, messages: [{ role: "user", content: "hi" }], stream: true, ...extra });

describe("model gateway", () => {
  it("lists Ethos and the two catalog models under their catalog names only", async () => {
    const { token } = await createPlatformUser(app, { idePlan: "ide_299" });
    const res = await request(app).get("/api/v1/models").set("authorization", `Bearer ${token}`).expect(200);
    const byId = Object.fromEntries(res.body.data.map((m) => [m.id, m]));
    expect(Object.keys(byId)).toEqual(["ethos-6", "opus-5.5", "gpt-6.1-sol"]);
    expect(byId["opus-5.5"].name).toBe("Opus 5.5");
    expect(byId["opus-5.5"].orbit).toMatchObject({ displayName: "Opus 5.5", provider: "anthropic", contextWindow: 100000 });
    expect(byId["gpt-6.1-sol"].orbit).toMatchObject({ displayName: "GPT-6.1 Sol", provider: "openai", supportsReasoning: true });
    expect(byId["gpt-6.1-sol"].orbit.inputCreditMultiplier * 1e6).toBeCloseTo(0.2);
    expect(byId["gpt-6.1-sol"].orbit.outputCreditMultiplier * 1e6).toBeCloseTo(1);
    // The upstream ids stay on the server.
    expect(res.text).not.toMatch(/haiku|luna|upstreamModel/i);
    expect(res.body.data.every((m) => m.upstreamModel === undefined)).toBe(true);
  });

  it("lists nothing the free account can use and refuses the list without a token", async () => {
    const free = await createPlatformUser(app);
    const me = await request(app).get("/api/v1/models").set("authorization", `Bearer ${free.token}`).expect(200);
    // The list is public to signed-in users (so the IDE can show it with an upgrade hint), but
    // /api/usage says the plan has no hosted models and every chat call is refused below.
    expect(me.body.data.length).toBe(3);
    const usage = await request(app).get("/api/usage").set("authorization", `Bearer ${free.token}`).expect(200);
    expect(usage.body.entitlements).toMatchObject({ plan: "free", paid: false, hostedModels: false });
    await request(app).get("/api/v1/models").expect(401);
  });

  it("refuses free accounts and chat-plan accounts without an IDE plan", async () => {
    const free = await createPlatformUser(app);
    global.fetch = jest.fn();
    const r1 = await chat(free.token, "opus-5.5").expect(402);
    expect(r1.body.error.code).toBe("plan_required");
    const chatOnly = await createPlatformUser(app, { planType: "prime" });
    await chat(chatOnly.token, "opus-5.5").expect(402);
    await chat(free.token, "gpt-6.1-sol").expect(402);
    await chat(free.token, "ethos-6").expect(402);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("sends each catalog model to its upstream model and bills the upstream price in rupees", async () => {
    const { token, user } = await createPlatformUser(app, { idePlan: "ide_299" });
    const calls = [];
    global.fetch = jest.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body, auth: init.headers.authorization });
      return new Response(sse([
        `data: {"id":"1","model":"${body.model}","choices":[{"delta":{"content":"Hello"}}]}`,
        `data: ${JSON.stringify({ id: "1", model: body.model, choices: [], usage: { prompt_tokens: 100000, completion_tokens: 10000, prompt_tokens_details: { cached_tokens: 0 } } })}`,
        "data: [DONE]",
      ]), { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const res = await chat(token, "opus-5.5").expect(200);
    expect(res.text).toMatch(/Hello/);
    // The stream the IDE sees names the catalog model, not the upstream one.
    expect(res.text).toMatch(/"model":"opus-5\.5"/);
    expect(res.text).not.toMatch(/haiku/);
    const res2 = await chat(token, "gpt-6.1-sol", { max_tokens: 500 }).expect(200);
    expect(res2.text).toMatch(/"model":"gpt-6\.1-sol"/);
    expect(res2.text).not.toMatch(/luna/);
    expect(calls[0]).toMatchObject({ url: "http://anthropic.test/v1/chat/completions", auth: "Bearer test-claude-key" });
    expect(calls[0].body).toMatchObject({ model: "claude-haiku-5-5", stream_options: { include_usage: true }, max_tokens: 16384 });
    expect(calls[1]).toMatchObject({ url: "http://openai.test/v1/chat/completions", auth: "Bearer test-openai-key" });
    expect(calls[1].body.model).toBe("gpt-6-luna");
    expect(calls[1].body.max_completion_tokens).toBe(500);
    expect(calls[1].body.max_tokens).toBeUndefined();
    await new Promise((r) => setTimeout(r, 50));
    // Haiku upstream: 100k in * $0.10 + 10k out * $0.50 = $0.015 -> Rs 1.50 at 100/USD
    // Luna upstream:  100k in * $0.20 + 10k out * $1.00 = $0.030 -> Rs 3.00
    const w = await IdeWallet.findByPk(user.id);
    expect(w.subscriptionCredits).toBe(1720000 - 15000 - 30000);
    const usage = await request(app).get("/api/usage").set("authorization", `Bearer ${token}`).expect(200);
    expect(usage.body.wallet.availableCredits).toBe("167.50");
  });

  it("rewrites the upstream model id in non-streamed answers and split stream chunks", async () => {
    const { token } = await createPlatformUser(app, { idePlan: "ide_299" });
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ id: "1", model: "claude-haiku-5-5", choices: [{ message: { role: "assistant", content: "Hi" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } }));
    const res = await chat(token, "opus-5.5", { stream: false }).expect(200);
    expect(res.body.model).toBe("opus-5.5");
    const line = 'data: {"id":"1","model":"gpt-6-luna","choices":[]}\n\n';
    const enc = new TextEncoder();
    global.fetch = jest.fn(async () => new Response(new ReadableStream({
      start(c) { c.enqueue(enc.encode(line.slice(0, 25))); c.enqueue(enc.encode(line.slice(25))); c.enqueue(enc.encode("data: [DONE]")); c.close(); },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const res2 = await chat(token, "gpt-6.1-sol").expect(200);
    expect(res2.text).toBe('data: {"id":"1","model":"gpt-6.1-sol","choices":[]}\n\ndata: [DONE]');
    expect(gateway.publicizeModel({ id: "a", upstreamModel: "b" }, '{"model":"b","x":"b"}')).toBe('{"model":"a","x":"a"}');
  });

  it("answers 402 when the month's budget is used up", async () => {
    const { token, user } = await createPlatformUser(app, { idePlan: "ide_299" });
    await wallets.ensureWallet(await require("../src/services/userService").findById(user.id));
    await IdeWallet.update({ subscriptionCredits: 0, topUpCredits: 0 }, { where: { userId: user.id } });
    const res = await chat(token, "ethos-6").expect(402);
    expect(res.body.error.code).toBe("insufficient_credits");
  });

  it("limits how many requests one user runs at once on the GPU", async () => {
    const { token, user } = await createPlatformUser(app, { idePlan: "ide_999" });
    await kv.set(`inflight:atomesus:${user.id}`, "2", 60);
    global.fetch = jest.fn();
    const res = await chat(token, "ethos-6").expect(429);
    expect(res.body.error.code).toBe("too_many_concurrent_requests");
    expect(global.fetch).not.toHaveBeenCalled();
    await kv.del(`inflight:atomesus:${user.id}`);
  });

  it("maps upstream 429 to usage_limit_exceeded and unknown models to 400", async () => {
    const { token } = await createPlatformUser(app, { idePlan: "ide_299" });
    global.fetch = jest.fn(async () => new Response("busy", { status: 429 }));
    const r = await chat(token, "ethos-6").expect(429);
    expect(r.body.error.code).toBe("usage_limit_exceeded");
    await chat(token, "gpt-9").expect(400);
    // Upstream ids are not accepted from the IDE either.
    await chat(token, "claude-haiku-5-5").expect(400);
    await chat(token, "gpt-6-luna").expect(400);
  });

  it("makes the output limit explicit for Ethos so the gateway does not cap replies at 1024 tokens", () => {
    const ethos = gateway.findModel("ethos-6");
    expect(gateway.adaptBody(ethos, { messages: [], max_completion_tokens: 4096 }, true)).toMatchObject({ model: "ethos-6", max_tokens: 4096, stream: true, stream_options: { include_usage: true } });
    expect(gateway.adaptBody(ethos, { messages: [] }, false).max_tokens).toBe(8192);
    expect(gateway.adaptBody(ethos, { messages: [], max_tokens: 100, max_completion_tokens: 4096 }, false)).toMatchObject({ max_tokens: 100 });
    expect("max_completion_tokens" in gateway.adaptBody(ethos, { messages: [], max_completion_tokens: 4096 }, false)).toBe(false);
  });

  it("prices cached input at the cache rate and long Haiku prompts at the long-context rate", () => {
    expect(gateway.extractUsage('data: {"usage":{"prompt_tokens":5}}')).toEqual({ prompt_tokens: 5 });
    expect(gateway.extractUsage("data: [DONE]")).toBeNull();
    const haiku = gateway.findModel("opus-5.5");
    expect(haiku.upstreamModel).toBe("claude-haiku-5-5");
    // 100k cached of 100k input at $0.01/MTok = $0.001 -> Rs 0.10 -> 1000 credits
    expect(creditsFor({ promptTokens: 100000, cachedTokens: 100000, completionTokens: 0 }, haiku)).toBe(1000);
    // 200k prompt is over 100k: $0.50/MTok -> $0.10 -> Rs 10
    expect(creditsFor({ promptTokens: 200000, cachedTokens: 0, completionTokens: 0 }, haiku)).toBe(100000);
  });
});
