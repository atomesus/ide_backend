const { bootTestApp, shutdownTestApp, createPlatformUser, request } = require("./helpers");
const gateway = require("../src/services/modelGatewayService");
const { IdeWallet } = require("../src/models/sql");
const wallets = require("../src/services/walletService");

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

describe("model gateway", () => {
  it("streams SSE through and bills credits from the usage chunk", async () => {
    const { token } = await createPlatformUser(app);
    let captured;
    global.fetch = jest.fn(async (url, init) => {
      captured = { url, body: JSON.parse(init.body), headers: init.headers };
      return new Response(sse([
        'data: {"id":"1","choices":[{"delta":{"content":"Hello"}}]}',
        'data: {"id":"1","choices":[],"usage":{"prompt_tokens":2000,"completion_tokens":1000,"prompt_tokens_details":{"cached_tokens":0}}}',
        "data: [DONE]",
      ]), { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const res = await request(app).post("/api/v1/chat/completions").set("authorization", `Bearer ${token}`).send({ model: "ethos-6", messages: [{ role: "user", content: "hi" }], stream: true }).expect(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(res.text).toMatch(/Hello/);
    expect(res.text).toMatch(/\[DONE\]/);
    expect(captured.url).toBe("http://upstream.test/v1/chat/completions");
    expect(captured.body.stream_options.include_usage).toBe(true);
    // 2k input *1 /1000 = 2, 1k output *3 /1000 = 3 => 5 credits
    await new Promise((r) => setTimeout(r, 50));
    const usage = await request(app).get("/api/usage").set("authorization", `Bearer ${token}`).expect(200);
    expect(usage.body.wallet.availableCredits).toBe("5");
  });

  it("answers 402 with insufficient_credits when the wallet is empty", async () => {
    const { token, user } = await createPlatformUser(app);
    await wallets.ensureWallet(user);
    await IdeWallet.update({ subscriptionCredits: 0, topUpCredits: 0 }, { where: { userId: user.id } });
    const res = await request(app).post("/api/v1/chat/completions").set("authorization", `Bearer ${token}`).send({ model: "ethos-6", messages: [{ role: "user", content: "hi" }] }).expect(402);
    expect(res.body.error.code).toBe("insufficient_credits");
  });

  it("maps upstream 429 to usage_limit_exceeded and unknown models to 400", async () => {
    const { token } = await createPlatformUser(app);
    global.fetch = jest.fn(async () => new Response("busy", { status: 429 }));
    const r = await request(app).post("/api/v1/chat/completions").set("authorization", `Bearer ${token}`).send({ model: "ethos-6", messages: [{ role: "user", content: "hi" }] }).expect(429);
    expect(r.body.error.code).toBe("usage_limit_exceeded");
    await request(app).post("/api/v1/chat/completions").set("authorization", `Bearer ${token}`).send({ model: "gpt-9", messages: [{ role: "user", content: "hi" }] }).expect(400);
  });

  it("computes credits with the cached-token discount", () => {
    expect(gateway.extractUsage('data: {"usage":{"prompt_tokens":5}}')).toEqual({ prompt_tokens: 5 });
    expect(gateway.extractUsage("data: [DONE]")).toBeNull();
    const { creditsFor } = require("../src/services/usageService");
    expect(creditsFor({ promptTokens: 1000, cachedTokens: 0, completionTokens: 0 })).toBe(1);
    expect(creditsFor({ promptTokens: 1000, cachedTokens: 1000, completionTokens: 0 })).toBe(1); // 0.1 rounded up
  });
});
