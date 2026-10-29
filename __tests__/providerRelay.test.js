const relay = require("../src/services/providerRelayService");
const { listProviders } = require("../src/config/providers");

describe("provider relay (no records)", () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it("lists providers without secrets and with recordsKept=false", () => {
    const list = listProviders();
    expect(list.map((p) => p.id).sort()).toEqual(["claude", "cline", "openai-codex", "xai-grok"]);
    for (const p of list) expect(p.recordsKept).toBe(false);
    expect(JSON.stringify(list)).not.toMatch(/secret/i);
  });

  it("builds a Codex authorize URL with PKCE", () => {
    const { url } = relay.buildAuthorizeUrl("openai-codex", { codeChallenge: "c".repeat(43), state: "state1234" });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://auth.openai.com/oauth/authorize");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
  });

  it("rejects a redirect_uri the provider does not allow", () => {
    expect(() => relay.buildAuthorizeUrl("claude", { codeChallenge: "c".repeat(43), state: "s12345678", redirectUri: "https://evil.example/cb" })).toThrow(/redirect_uri/);
  });

  it("exchanges a Claude code#state as JSON and normalizes the reply", async () => {
    let captured;
    global.fetch = jest.fn(async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600, token_type: "Bearer" }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const out = await relay.exchangeCode("claude", { code: "abc#xyz", codeVerifier: "v".repeat(43) });
    expect(captured.url).toBe("https://console.anthropic.com/v1/oauth/token");
    const body = JSON.parse(captured.init.body);
    expect(body).toMatchObject({ grant_type: "authorization_code", code: "abc", state: "xyz", code_verifier: "v".repeat(43), redirect_uri: "https://console.anthropic.com/oauth/code/callback" });
    expect(out.accessToken).toBe("at");
    expect(out.refreshToken).toBe("rt");
    expect(out.expiresAt).toBeGreaterThan(Date.now());
    expect(out.ideProvider).toBe("anthropic");
  });

  it("exchanges a Codex code as form-encoded", async () => {
    let captured;
    global.fetch = jest.fn(async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ access_token: "a", refresh_token: "r", id_token: "i", expires_in: 10 }), { status: 200 });
    });
    const out = await relay.exchangeCode("openai-codex", { code: "code", codeVerifier: "v".repeat(43) });
    expect(captured.init.headers["content-type"]).toMatch(/x-www-form-urlencoded/);
    expect(String(captured.init.body)).toMatch(/grant_type=authorization_code/);
    expect(out.idToken).toBe("i");
  });

  it("surfaces provider rejections as 400 with the provider error code", async () => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "bad code" }), { status: 400 }));
    await expect(relay.exchangeCode("xai-grok", { code: "x", codeVerifier: "v".repeat(43) })).rejects.toMatchObject({ status: 400, code: "provider_rejected", extra: { providerError: "invalid_grant" } });
  });

  it("refreshes through the provider refresh endpoint", async () => {
    let captured;
    global.fetch = jest.fn(async (url, init) => { captured = { url, init }; return new Response(JSON.stringify({ success: true, data: { accessToken: "n", refreshToken: "m", expiresAt: Date.now() + 1000 } }), { status: 200 }); });
    const out = await relay.refreshToken("cline", { refreshToken: "old" });
    expect(captured.url).toBe("https://api.cline.bot/api/v1/auth/refresh");
    expect(out.accessToken).toBe("n");
  });
});
