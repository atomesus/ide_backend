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
    expect(Object.keys(byId["opus-5.5"].orbit).sort()).toEqual(["displayName", "supportsReasoning", "supportsTools"]);
    expect(byId["gpt-6.1-sol"].orbit).toMatchObject({ displayName: "GPT-6.1 Sol", supportsReasoning: true });
    // Nothing that names the provider, prices a token or sizes the model leaves the server.
    expect(res.body.data.every((m) => m.owned_by === "atomesus")).toBe(true);
    expect(res.text).not.toMatch(/haiku|luna|upstreamModel|anthropic|openai|claude|gpt-6-|Multiplier|price|contextWindow|token/i);
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
    // 167.50 of 172 left -> 97%; the IDE only ever sees the percentage.
    expect(usage.body.limits).toMatchObject({ plan: "ide_299", remainingPercent: 97, status: "ok", hasTopUp: false });
    expect(JSON.stringify(usage.body)).not.toMatch(/credit|rupee|wallet|token|167|172/i);
  });

  it("sends the IDE no token counts, fingerprints, provider ids or upstream names", async () => {
    const { token } = await createPlatformUser(app, { idePlan: "ide_299" });
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ id: "msg_01abc", model: "claude-haiku-5-5", system_fingerprint: "fp_x", choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop", logprobs: null }], usage: { prompt_tokens: 10, completion_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } }));
    const res = await chat(token, "opus-5.5", { stream: false }).expect(200);
    expect(res.body).toMatchObject({ object: "chat.completion", model: "opus-5.5", choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }] });
    expect(res.body.id).toMatch(/^chatcmpl-[0-9a-f]{24}$/);
    expect(res.text).not.toMatch(/usage|fingerprint|msg_01|haiku|logprobs|tokens/);

    // vLLM-style stream: extras on every chunk, a usage-only chunk, and a line split across reads.
    const line = 'data: {"id":"chatcmpl-96c3","model":"gpt-6-luna","system_fingerprint":"vllm-0.29.0-tp4","service_tier":null,"choices":[{"index":0,"delta":{"content":"Yo"},"token_ids":null,"routed_experts":null,"stop_reason":null}]}\n\n';
    const usageLine = 'data: {"id":"chatcmpl-96c3","choices":[],"usage":{"prompt_tokens":14,"total_tokens":19,"completion_tokens":5}}\n\n';
    const enc = new TextEncoder();
    global.fetch = jest.fn(async () => new Response(new ReadableStream({
      start(c) { c.enqueue(enc.encode(line.slice(0, 25))); c.enqueue(enc.encode(line.slice(25) + usageLine)); c.enqueue(enc.encode("data: [DONE]")); c.close(); },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const res2 = await chat(token, "gpt-6.1-sol").expect(200);
    const events = res2.text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
    expect(events[events.length - 1]).toBe("[DONE]");
    expect(events.length).toBe(2);
    expect(JSON.parse(events[0])).toEqual({ id: expect.stringMatching(/^chatcmpl-/), object: "chat.completion.chunk", created: expect.any(Number), model: "gpt-6.1-sol", choices: [{ index: 0, delta: { content: "Yo" }, finish_reason: null }] });
    expect(res2.text).not.toMatch(/vllm|fingerprint|usage|token|luna|96c3|experts|service_tier/);
  });

  it("hides provider tool-call ids and restores them when the IDE sends them back", async () => {
    const { token } = await createPlatformUser(app, { idePlan: "ide_299" });
    const bodies = [];
    global.fetch = jest.fn(async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(sse([
        'data: {"id":"1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"toolu_01ABCdef","type":"function","function":{"name":"read_file","arguments":""}}]}}]}',
        'data: {"id":"1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"a\\"}"}}]},"finish_reason":"tool_calls"}]}',
        "data: [DONE]",
      ]), { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const res = await chat(token, "opus-5.5").expect(200);
    expect(res.text).not.toMatch(/toolu_/);
    const first = JSON.parse(res.text.split("\n").find((l) => l.includes("tool_calls")).slice(6));
    const publicId = first.choices[0].delta.tool_calls[0].id;
    expect(publicId).toMatch(/^call_at/);
    expect(first.choices[0].delta.tool_calls[0].function.name).toBe("read_file");
    // The next turn carries the opaque id; the provider gets its own id back.
    await chat(token, "opus-5.5", { messages: [
      { role: "user", content: "read a" },
      { role: "assistant", content: null, tool_calls: [{ id: publicId, type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }] },
      { role: "tool", tool_call_id: publicId, content: "PAPAYA" },
    ] }).expect(200);
    expect(bodies[1].messages[1].tool_calls[0].id).toBe("toolu_01ABCdef");
    expect(bodies[1].messages[2].tool_call_id).toBe("toolu_01ABCdef");
  });

  it("lets a slow reply stream past the start-up limit, and reports a reply that goes silent", async () => {
    const { config } = require("../src/config/env");
    const saved = { first: config.CHAT_UPSTREAM_TIMEOUT_MS, idle: config.CHAT_STREAM_IDLE_MS };
    config.CHAT_UPSTREAM_TIMEOUT_MS = 100;
    config.CHAT_STREAM_IDLE_MS = 150;
    const enc = new TextEncoder();
    // Streams `n` chunks `gapMs` apart, then optionally stalls; errors when the gateway aborts it.
    const slowStream = (n, gapMs, stallAfter) => jest.fn(async (url, init) => new Response(new ReadableStream({
      async start(c) {
        init.signal.addEventListener("abort", () => { try { c.error(new Error("aborted")); } catch { /* closed */ } });
        for (let i = 0; i < n; i++) {
          if (init.signal.aborted) return;
          c.enqueue(enc.encode(`data: {"choices":[{"index":0,"delta":{"content":"w${i} "}}]}\n\n`));
          await new Promise((r) => setTimeout(r, gapMs));
        }
        if (stallAfter) return; // never closes: the gateway must notice the silence
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }));
    try {
      const { token } = await createPlatformUser(app, { idePlan: "ide_299" });
      // 8 chunks 60ms apart = ~480ms in total, far past the 100ms start-up limit.
      global.fetch = slowStream(8, 60, false);
      const ok = await chat(token, "ethos-6").expect(200);
      expect(ok.text).toMatch(/w7 /);
      expect(ok.text).toMatch(/\[DONE\]/);
      expect(ok.text).not.toMatch(/error/);
      // Two chunks, then silence longer than the idle limit: the IDE gets an error, not a silent end.
      global.fetch = slowStream(2, 10, true);
      const stalled = await chat(token, "ethos-6").expect(200);
      expect(stalled.text).toMatch(/w1 /);
      expect(stalled.text).toMatch(/"error":\{"message":"Ethos 6 stopped responding\. Try again\."\}/);
    } finally {
      config.CHAT_UPSTREAM_TIMEOUT_MS = saved.first;
      config.CHAT_STREAM_IDLE_MS = saved.idle;
    }
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
    const gpt = gateway.findModel("gpt-6.1-sol");
    const tools = [{ type: "function", function: { name: "read_file", parameters: {} } }];
    // OpenAI refuses tools + reasoning_effort on chat completions for gpt-6-luna.
    expect(gateway.adaptBody(gpt, { messages: [], tools, reasoning_effort: "medium" }, true)).toMatchObject({ model: "gpt-6-luna", reasoning_effort: "none", tools });
    expect(gateway.adaptBody(gpt, { messages: [], reasoning_effort: "medium" }, true).reasoning_effort).toBe("medium");
    expect(gateway.adaptBody(gpt, { messages: [], tools }, true).reasoning_effort).toBe("none");
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
