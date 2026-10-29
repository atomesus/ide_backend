const { bootTestApp, shutdownTestApp, signupUser, request } = require("./helpers");
const pkce = require("../src/lib/pkce");
const { User, ApiKey } = require("../src/models/sql");

let app;
beforeAll(async () => { app = await bootTestApp(); });
afterAll(shutdownTestApp);

const REDIRECT = "atomesus://auth-callback?editor_state=abcdef0123456789abcdef0123456789";

describe("platform auth + desktop sign-in", () => {
  it("creates a verified user through OTP and logs in with the password", async () => {
    const { email, password, token } = await signupUser(app);
    const me = await request(app).get("/api/auth/me").set("authorization", `Bearer ${token}`).expect(200);
    expect(me.body.data.user.email).toBe(email);
    expect(me.body.data.user.passwordHash).toBeUndefined();
    await request(app).post("/api/auth/login").send({ email, password: "nope-nope-nope" }).expect(401);
    const login = await request(app).post("/api/auth/login").send({ email, password }).expect(200);
    expect(login.body.data.token).toBeTruthy();
    const row = await User.findOne({ where: { email } });
    expect(row.emailVerifiedAt).toBeTruthy();
  });

  it("refuses a duplicate verified account", async () => {
    const { email } = await signupUser(app);
    await request(app).post("/api/auth/signup/request-otp").send({ email, name: "X", password: "correct-horse-battery" }).expect(409);
  });

  it("runs the PKCE desktop flow and issues a device key once", async () => {
    const { cookie } = await signupUser(app);
    const verifier = pkce.generateVerifier();
    const challenge = pkce.challengeFor(verifier);

    const page = await request(app).get("/desktop/login").query({ client: "desktop", redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" }).set("cookie", cookie).expect(200);
    expect(page.text).toMatch(/Sign in to Atomesus desktop\?/);
    const flow = page.text.match(/name="flow" value="([^"]+)"/)[1];

    const done = await request(app).post("/desktop/approve").type("form").send({ flow }).set("cookie", cookie).expect(200);
    const href = done.text.match(/href="(atomesus:\/\/[^"]+)"/)[1].replace(/&amp;/g, "&");
    const url = new URL(href);
    expect(url.searchParams.get("editor_state")).toBe("abcdef0123456789abcdef0123456789");
    const code = url.searchParams.get("code");
    expect(code).toBeTruthy();

    await request(app).post("/api/auth/desktop/exchange").send({ code, codeVerifier: pkce.generateVerifier() }).expect(400); // wrong verifier burns the code
    const page2 = await request(app).get("/desktop/login").query({ client: "desktop", redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" }).set("cookie", cookie).expect(200);
    const flow2 = page2.text.match(/name="flow" value="([^"]+)"/)[1];
    const done2 = await request(app).post("/desktop/approve").type("form").send({ flow: flow2 }).set("cookie", cookie).expect(200);
    const code2 = new URL(done2.text.match(/href="(atomesus:\/\/[^"]+)"/)[1].replace(/&amp;/g, "&")).searchParams.get("code");

    const ex = await request(app).post("/api/auth/desktop/exchange").send({ code: code2, codeVerifier: verifier }).expect(200);
    expect(ex.body.token).toMatch(/^sk_/);
    expect(Date.parse(ex.body.session.expiresAt)).toBeGreaterThan(Date.now());
    expect(ex.body.user).toMatchObject({ id: expect.any(String), email: expect.any(String), plan: "free" });
    await request(app).post("/api/auth/desktop/exchange").send({ code: code2, codeVerifier: verifier }).expect(400);

    const sk = ex.body.token;
    const models = await request(app).get("/api/v1/models").set("authorization", `Bearer ${sk}`).expect(200);
    expect(models.body.data[0].id).toBe("ethos-6");
    const usage = await request(app).get("/api/usage").set("authorization", `Bearer ${sk}`).expect(200);
    expect(usage.body.wallet.availableCredits).toBe("10");
    const devices = await request(app).get("/api/account/devices").set("authorization", `Bearer ${sk}`).expect(200);
    expect(devices.body.data.devices).toHaveLength(1);

    await request(app).delete("/api/auth/api-keys/current").set("authorization", `Bearer ${sk}`).expect(204);
    await request(app).get("/api/v1/models").set("authorization", `Bearer ${sk}`).expect(401);
    const keyRow = await ApiKey.findOne({ where: { keyPrefix: sk.slice(0, 10) } });
    expect(keyRow.revokedAt).toBeTruthy();
    expect(keyRow.keyHash).not.toContain(sk.slice(3, 20));
  });

  it("rejects a redirect_uri that is not the desktop deep link", async () => {
    await request(app).get("/desktop/login").query({ client: "desktop", redirect_uri: "https://evil.example/cb?editor_state=abcdef0123456789abcdef0123456789", code_challenge: "c".repeat(43), code_challenge_method: "S256" }).expect(400);
  });

  it("cancel redirects with error=access_denied", async () => {
    const page = await request(app).get("/desktop/login").query({ client: "desktop", redirect_uri: REDIRECT, code_challenge: "c".repeat(43), code_challenge_method: "S256" }).expect(200);
    const flow = page.text.match(/name="flow" value="([^"]+)"/)[1];
    const done = await request(app).post("/desktop/cancel").type("form").send({ flow }).expect(200);
    expect(done.text).toMatch(/error=access_denied/);
  });

  it("password reset signs every device out", async () => {
    const { email, token } = await signupUser(app);
    const logs = [];
    const orig = console.log;
    console.log = (...a) => logs.push(a.join(" "));
    try {
      await request(app).post("/api/auth/forgot-password").send({ email }).expect(200);
    } finally {
      console.log = orig;
    }
    const otp = logs.join("\n").match(/is: (\d{6})/)[1];
    const v = await request(app).post("/api/auth/verify-otp").send({ email, otp }).expect(200);
    await request(app).post("/api/auth/reset-password").send({ resetToken: v.body.data.resetToken, password: "new-password-123" }).expect(200);
    await request(app).post("/api/auth/login").send({ email, password: "new-password-123" }).expect(200);
    expect(token).toBeTruthy();
  });
});
