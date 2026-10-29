const express = require("express");
const { z } = require("zod");
const { config } = require("../config/env");
const auth = require("../services/authService");
const oauthWeb = require("../services/oauthWebService");
const desktop = require("../services/desktopAuthService");
const users = require("../services/userService");
const apiKeys = require("../services/apiKeyService");
const { recordLogin } = require("../services/loginEventService");
const { requireAuth } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { loginChain, otpRequestChain, otpVerifyChain } = require("../middleware/rateLimit");
const { getClientIp } = require("../middleware/clientIp");
const { signSessionToken } = require("../lib/tokens");
const { badRequest } = require("../lib/errors");

const router = express.Router();
const ok = (res, data, message = "OK", status = 200) => res.status(status).json({ success: true, code: status, message, data });

function setSessionCookie(res, user) {
  res.cookie(config.SESSION_COOKIE_NAME, signSessionToken(user), { httpOnly: true, secure: config.isProd, sameSite: "lax", maxAge: 30 * 24 * 60 * 60 * 1000, path: "/" });
}

const email = z.string().trim().min(3).max(254);
const password = z.string().min(1).max(128);

// ---- email + OTP sign-up --------------------------------------------------
router.post("/signup/request-otp", ...otpRequestChain, validate({ body: z.object({ email, name: z.string().trim().max(120).optional(), password }) }), async (req, res) => {
  await auth.requestSignupOtp(req.body);
  ok(res, null, "Verification code sent");
});

router.post("/signup/verify-otp", ...otpVerifyChain, validate({ body: z.object({ email, otp: z.string().regex(/^\d{6}$/) }) }), async (req, res) => {
  const user = await auth.verifySignupOtp(req.body);
  await recordLogin(req, { userId: user.id, method: "otp", client: "web" });
  await users.touchLogin(user);
  setSessionCookie(res, user);
  ok(res, auth.sessionFor(user), "Account created", 201);
});

// ---- email + password login -----------------------------------------------
router.post("/login", ...loginChain, validate({ body: z.object({ email, password }) }), async (req, res) => {
  let user;
  try {
    user = await auth.loginWithPassword(req.body);
  } catch (err) {
    throw err;
  }
  await recordLogin(req, { userId: user.id, method: "password", client: "web" });
  await users.touchLogin(user);
  setSessionCookie(res, user);
  ok(res, auth.sessionFor(user), "Logged in");
});

// ---- Google ID token (one-tap / mobile) -----------------------------------
router.post("/login/google", ...loginChain, validate({ body: z.object({ idToken: z.string().min(10) }) }), async (req, res) => {
  const user = await auth.loginWithGoogleIdToken(req.body);
  await recordLogin(req, { userId: user.id, method: "google", client: "web" });
  await users.touchLogin(user);
  setSessionCookie(res, user);
  ok(res, auth.sessionFor(user), "Logged in");
});

// ---- browser OAuth (GitHub / Google) --------------------------------------
for (const provider of ["github", "google"]) {
  router.get(`/${provider}`, async (req, res) => {
    const flowId = req.query.flow ? String(req.query.flow) : null;
    const returnTo = req.query.return_to ? String(req.query.return_to) : null;
    const { url } = await oauthWeb.beginAuthorization(provider, { flowId, returnTo });
    res.redirect(url);
  });

  router.get(`/${provider}/callback`, async (req, res, next) => {
    try {
      if (req.query.error) throw badRequest(`${provider} sign-in was cancelled.`, "oauth_denied");
      const { user, ctx } = await oauthWeb.completeAuthorization(provider, { code: String(req.query.code || ""), state: String(req.query.state || "") });
      await recordLogin(req, { userId: user.id, method: provider, client: ctx.flowId ? "desktop" : "web" });
      await users.touchLogin(user);
      setSessionCookie(res, user);
      if (ctx.flowId) return res.redirect(`/desktop/confirm?flow=${encodeURIComponent(ctx.flowId)}`);
      const target = ctx.returnTo && /^\/[^/\\]/.test(ctx.returnTo) ? `${config.WEB_APP_URL}${ctx.returnTo}` : config.WEB_APP_URL;
      res.redirect(target);
    } catch (err) {
      // If this started from the desktop page, land back there with the message.
      const state = String(req.query.state || "");
      if (err.status && err.status < 500 && state) {
        return res.status(err.status).send(require("../views/page").errorPage(err.message));
      }
      next(err);
    }
  });
}

// ---- desktop code exchange (IDE contract) ---------------------------------
router.post("/desktop/exchange", ...loginChain, validate({ body: z.object({ code: z.string().min(10), codeVerifier: z.string().min(43).max(128) }) }), async (req, res) => {
  const platform = String(req.get("x-atomesus-platform") || req.get("sec-ch-ua-platform") || "").slice(0, 64) || null;
  const result = await desktop.exchange(req.body, { userAgent: req.get("user-agent"), ip: getClientIp(req), platform });
  await recordLogin(req, { userId: result.user.id, method: "device_key", client: "desktop", apiKeyId: result.apiKey.id });
  res.set("Cache-Control", "no-store");
  res.json({ token: result.token, session: result.session, user: result.user });
});

// IDE sign-out revokes its own device key.
router.delete("/api-keys/current", requireAuth(true), async (req, res) => {
  if (req.auth?.kind !== "device_key") throw badRequest("Current credential is not a device key.", "not_device_key");
  await apiKeys.revokeByPlaintext(req.auth.token);
  res.status(204).end();
});

// ---- session --------------------------------------------------------------
router.get("/me", requireAuth(true), async (req, res) => {
  const user = await users.ensureBillingPeriod(req.user);
  ok(res, { user: users.safeUser(user), auth: { kind: req.auth.kind } });
});

router.post("/logout", requireAuth(false), async (req, res) => {
  if (req.auth?.kind === "device_key") await apiKeys.revokeByPlaintext(req.auth.token);
  res.clearCookie(config.SESSION_COOKIE_NAME, { path: "/" });
  ok(res, null, "Logged out");
});

// ---- password reset / change ---------------------------------------------
router.post("/forgot-password", ...otpRequestChain, validate({ body: z.object({ email }) }), async (req, res) => {
  await auth.requestPasswordReset(req.body);
  ok(res, null, "If that email has an account, a code was sent");
});

router.post("/verify-otp", ...otpVerifyChain, validate({ body: z.object({ email, otp: z.string().regex(/^\d{6}$/) }) }), async (req, res) => {
  const resetToken = await auth.verifyPasswordResetOtp(req.body);
  ok(res, { resetToken }, "Code verified");
});

router.post("/reset-password", ...loginChain, validate({ body: z.object({ resetToken: z.string().min(10), password }) }), async (req, res) => {
  const user = await auth.resetPassword(req.body);
  await apiKeys.revokeAllForUser(user.id); // a reset signs every device out
  ok(res, null, "Password updated");
});

router.post("/change-password", requireAuth(true), validate({ body: z.object({ currentPassword: z.string().max(128).optional(), newPassword: password }) }), async (req, res) => {
  await auth.changePassword(req.user, req.body);
  ok(res, null, "Password updated");
});

module.exports = router;
