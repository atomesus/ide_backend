const express = require("express");
const { z } = require("zod");
const { config } = require("../config/env");
const desktop = require("../services/desktopAuthService");
const auth = require("../services/authService");
const oauthWeb = require("../services/oauthWebService");
const users = require("../services/userService");
const { recordLogin } = require("../services/loginEventService");
const { signSessionToken } = require("../lib/tokens");
const { requireAuth } = require("../middleware/auth");
const { loginChain, otpRequestChain, otpVerifyChain } = require("../middleware/rateLimit");
const views = require("../views/page");

const router = express.Router();
const form = express.urlencoded({ extended: false, limit: "16kb" });

function setSessionCookie(res, user) {
  res.cookie(config.SESSION_COOKIE_NAME, signSessionToken(user), {
    httpOnly: true,
    secure: config.isProd,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

const startQuery = z.object({
  client: z.string().optional(),
  redirect_uri: z.string().min(1),
  code_challenge: z.string().min(1),
  code_challenge_method: z.string().optional(),
});

async function renderFlow(req, res, flow, error) {
  // Already signed in on this browser? Ask to confirm instead of showing the form.
  if (req.user && !error) return res.send(views.confirmPage({ flow, user: users.safeUser(req.user) }));
  res.status(error ? 400 : 200).send(views.signInPage({ flow, error, github: oauthWeb.isConfigured("github"), google: oauthWeb.isConfigured("google") }));
}

async function start(screen) {
  return async (req, res) => {
    const existing = req.query.flow ? await desktop.getFlow(String(req.query.flow)) : null;
    let flow = existing;
    if (!flow) {
      const parsed = startQuery.safeParse(req.query);
      if (!parsed.success) return res.status(400).send(views.errorPage("This link is missing the desktop sign-in parameters. Click Log in inside Atomesus again."));
      const q = parsed.data;
      flow = await desktop.createFlow({ screen, redirectUri: q.redirect_uri, codeChallenge: q.code_challenge, codeChallengeMethod: q.code_challenge_method, client: q.client });
    } else if (flow.screen !== screen) {
      flow.screen = screen;
    }
    return renderFlow(req, res, flow);
  };
}

router.get("/login", requireAuth(false), (req, res, next) => start("login").then((h) => h(req, res)).catch(next));
router.get("/signup", requireAuth(false), (req, res, next) => start("signup").then((h) => h(req, res)).catch(next));

// Returns here after GitHub/Google or a successful form login with a session cookie set.
router.get("/confirm", requireAuth(false), async (req, res) => {
  const flow = await desktop.getFlow(String(req.query.flow || ""));
  if (!flow) return res.status(400).send(views.errorPage("Sign-in request expired. Go back to Atomesus and click Log in again."));
  if (!req.user) return renderFlow(req, res, flow);
  res.send(views.confirmPage({ flow, user: users.safeUser(req.user) }));
});

router.post("/login", form, ...loginChain, requireAuth(false), async (req, res, next) => {
  const flow = await desktop.getFlow(String(req.body.flow || ""));
  if (!flow) return res.status(400).send(views.errorPage("Sign-in request expired. Go back to Atomesus and click Log in again."));
  try {
    const user = await auth.loginWithPassword({ email: req.body.email, password: req.body.password });
    await recordLogin(req, { userId: user.id, method: "password", client: "desktop" });
    setSessionCookie(res, user);
    res.send(views.confirmPage({ flow, user: users.safeUser(user) }));
  } catch (err) {
    if (err.status && err.status < 500) return res.status(err.status).send(views.signInPage({ flow, error: err.message, github: oauthWeb.isConfigured("github"), google: oauthWeb.isConfigured("google") }));
    next(err);
  }
});

router.post("/signup", form, ...otpRequestChain, ...otpVerifyChain, async (req, res, next) => {
  const flow = await desktop.getFlow(String(req.body.flow || ""));
  if (!flow) return res.status(400).send(views.errorPage("Sign-in request expired. Go back to Atomesus and click Sign up again."));
  const render = (status, error) => res.status(status).send(views.signInPage({ flow: { ...flow, screen: "signup" }, error, github: oauthWeb.isConfigured("github"), google: oauthWeb.isConfigured("google") }));
  try {
    if (!req.body.otp) {
      await auth.requestSignupOtp({ email: req.body.email, name: req.body.name, password: req.body.password });
      return render(200, `We emailed a 6-digit code to ${req.body.email}. Enter it below with the same email and password.`);
    }
    const user = await auth.verifySignupOtp({ email: req.body.email, otp: req.body.otp });
    await recordLogin(req, { userId: user.id, method: "otp", client: "desktop" });
    setSessionCookie(res, user);
    res.send(views.confirmPage({ flow, user: users.safeUser(user) }));
  } catch (err) {
    if (err.status && err.status < 500) return render(err.status, err.message);
    next(err);
  }
});

router.post("/approve", form, requireAuth(false), async (req, res) => {
  if (!req.user) return res.status(401).send(views.errorPage("Your browser session expired. Go back to Atomesus and click Log in again."));
  const { redirectTo } = await desktop.approveFlow(String(req.body.flow || ""), req.user);
  res.send(views.donePage({ ok: true, message: "You can go back to Atomesus now.", redirectTo }));
});

router.post("/cancel", form, async (req, res) => {
  const { redirectTo } = await desktop.denyFlow(String(req.body.flow || ""));
  res.send(views.donePage({ ok: false, message: "No changes were made. You can close this tab.", redirectTo }));
});

router.post("/switch", form, async (req, res) => {
  res.clearCookie(config.SESSION_COOKIE_NAME, { path: "/" });
  res.redirect(`/desktop/login?flow=${encodeURIComponent(String(req.body.flow || ""))}`);
});

module.exports = { router, setSessionCookie };
