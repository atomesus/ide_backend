/**
 * Browser OAuth with GitHub and Google (authorization-code flow run by this
 * server). Used by the website and by the desktop sign-in pages. These are
 * platform logins, so the resulting users ARE stored.
 */
const { kv } = require("../db/redis");
const { config } = require("../config/env");
const { randomId } = require("../lib/tokens");
const { fetchWithTimeout } = require("../lib/http");
const { badRequest, unavailable } = require("../lib/errors");
const users = require("./userService");

const STATE_TTL = 600;
const stateKey = (provider, state) => `oauth:${provider}:${state}`;

function callbackUrl(provider) {
  return `${config.API_PUBLIC_URL}/api/auth/${provider}/callback`;
}

function isConfigured(provider) {
  if (provider === "github") return Boolean(config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET);
  if (provider === "google") return Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);
  return false;
}

/** Creates a state token carrying what to do after the callback (desktop flow id or return path). */
async function beginAuthorization(provider, { flowId, returnTo } = {}) {
  if (!isConfigured(provider)) throw unavailable(`${provider} sign-in is not configured.`, `${provider}_not_configured`);
  const state = randomId(24);
  await kv.setJSON(stateKey(provider, state), { flowId: flowId || null, returnTo: returnTo || null }, STATE_TTL);
  const redirectUri = callbackUrl(provider);
  let url;
  if (provider === "github") {
    const p = new URLSearchParams({ client_id: config.GITHUB_CLIENT_ID, redirect_uri: redirectUri, scope: "read:user user:email", state, allow_signup: "true" });
    url = `https://github.com/login/oauth/authorize?${p}`;
  } else {
    const p = new URLSearchParams({ client_id: config.GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type: "code", scope: "openid email profile", state, access_type: "online", prompt: "select_account" });
    url = `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
  }
  return { url, state };
}

async function consumeState(provider, state) {
  if (!state) throw badRequest("Missing OAuth state.", "oauth_state_missing");
  const record = await kv.take(stateKey(provider, state));
  if (!record) throw badRequest("OAuth state expired or already used. Start again.", "oauth_state_invalid");
  return typeof record === "string" ? JSON.parse(record) : record;
}

async function completeGithub(code) {
  const tokenRes = await fetchWithTimeout("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_id: config.GITHUB_CLIENT_ID, client_secret: config.GITHUB_CLIENT_SECRET, code, redirect_uri: callbackUrl("github") }),
  });
  const tokenJson = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenJson.access_token) throw badRequest("GitHub did not accept the sign-in code.", "github_exchange_failed");
  const headers = { authorization: `Bearer ${tokenJson.access_token}`, accept: "application/vnd.github+json", "user-agent": "atomesus-ide-backend" };
  const [profileRes, emailsRes] = await Promise.all([
    fetchWithTimeout("https://api.github.com/user", { headers }),
    fetchWithTimeout("https://api.github.com/user/emails", { headers }),
  ]);
  const profile = await profileRes.json().catch(() => ({}));
  const emails = emailsRes.ok ? await emailsRes.json().catch(() => []) : [];
  if (!profile?.id) throw badRequest("Could not read GitHub profile.", "github_profile_failed");
  const primary = (Array.isArray(emails) ? emails : []).find((e) => e.primary && e.verified) || (Array.isArray(emails) ? emails : []).find((e) => e.verified);
  const email = primary?.email || (profile.email ? profile.email : null);
  return users.upsertOAuthUser("github", { providerId: String(profile.id), email, name: profile.name || profile.login, image: profile.avatar_url, login: profile.login });
}

async function completeGoogle(code) {
  const tokenRes = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: config.GOOGLE_CLIENT_ID, client_secret: config.GOOGLE_CLIENT_SECRET, redirect_uri: callbackUrl("google"), grant_type: "authorization_code" }),
  });
  const tokenJson = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenJson.id_token) throw badRequest("Google did not accept the sign-in code.", "google_exchange_failed");
  const { OAuth2Client } = require("google-auth-library");
  const client = new OAuth2Client(config.GOOGLE_CLIENT_ID);
  const ticket = await client.verifyIdToken({ idToken: tokenJson.id_token, audience: config.GOOGLE_CLIENT_ID });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email_verified) throw badRequest("Google account email is not verified.", "google_email_unverified");
  return users.upsertOAuthUser("google", { providerId: payload.sub, email: payload.email, name: payload.name, image: payload.picture });
}

async function completeAuthorization(provider, { code, state }) {
  const ctx = await consumeState(provider, state);
  if (!code) throw badRequest("Missing authorization code.", "oauth_code_missing");
  const user = provider === "github" ? await completeGithub(code) : await completeGoogle(code);
  return { user, ctx };
}

module.exports = { beginAuthorization, completeAuthorization, isConfigured, callbackUrl };
