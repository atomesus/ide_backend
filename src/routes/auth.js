const express = require("express");
const { z } = require("zod");
const desktop = require("../services/desktopAuthService");
const users = require("../services/userService");
const apiKeys = require("../services/apiKeyService");
const { recordLogin } = require("../services/loginEventService");
const { requireAuth } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { limiters } = require("../middleware/rateLimit");
const { getClientIp } = require("../middleware/clientIp");
const { badRequest } = require("../lib/errors");

const router = express.Router();
const ok = (res, data, message = "OK", status = 200) => res.status(status).json({ success: true, code: status, message, data });

const desktopRequest = z.object({
  client: z.string().max(32).optional(),
  redirect_uri: z.string().min(1).max(2048),
  code_challenge: z.string().min(1).max(128),
  code_challenge_method: z.string().max(16).optional(),
});
const toParams = (b) => ({ client: b.client, redirectUri: b.redirect_uri, codeChallenge: b.code_challenge, codeChallengeMethod: b.code_challenge_method });

// ---- desktop sign-in, driven by the website page (Bearer = platform JWT) --
router.post("/desktop/approve", limiters.desktopApprove, requireAuth(true), validate({ body: desktopRequest }), async (req, res) => {
  if (req.auth.kind !== "platform_session") throw badRequest("Approve the desktop sign-in from the website session.", "platform_session_required");
  const { redirectTo } = await desktop.approve(req.user, toParams(req.body));
  await recordLogin(req, { userId: req.user.id, method: "website", client: "web" });
  res.set("Cache-Control", "no-store");
  ok(res, { redirectTo, user: users.desktopUser(req.user) }, "Desktop sign-in approved");
});

router.post("/desktop/deny", validate({ body: desktopRequest }), (req, res) => {
  const { redirectTo } = desktop.deny(toParams(req.body));
  ok(res, { redirectTo }, "Desktop sign-in cancelled");
});

// ---- desktop code exchange (IDE contract) ---------------------------------
router.post("/desktop/exchange", limiters.loginIp, validate({ body: z.object({ code: z.string().min(10), codeVerifier: z.string().min(43).max(128) }) }), async (req, res) => {
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
  ok(res, { user: users.safeUser(req.user), auth: { kind: req.auth.kind } });
});

router.post("/logout", requireAuth(false), async (req, res) => {
  if (req.auth?.kind === "device_key") await apiKeys.revokeByPlaintext(req.auth.token);
  ok(res, null, "Logged out");
});

module.exports = router;
