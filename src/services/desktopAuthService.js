/**
 * Desktop sign-in (docs/desktop-sign-in.md in the IDE repo):
 *
 *   IDE opens   GET {this server}/desktop/login?client=desktop
 *                   &redirect_uri=atomesus://auth-callback?editor_state=X
 *                   &code_challenge=C&code_challenge_method=S256
 *               -> 302 to {WEB_APP_URL}/desktop/login with the same query
 *   website     signs the user in (or finds them signed in), asks
 *               "Continue as <account>?", then calls
 *               POST /api/auth/desktop/approve  (Bearer platform JWT)
 *               -> { redirectTo: redirect_uri + &code=<one-time> }
 *               and sends the browser there (Cancel -> &error=access_denied).
 *   IDE calls   POST /api/auth/desktop/exchange { code, codeVerifier }
 *               -> { token: "sk_...", session: { expiresAt }, user }
 */
const { kv } = require("../db/redis");
const { config } = require("../config/env");
const { randomId } = require("../lib/tokens");
const { isValidChallenge, verifyChallenge } = require("../lib/pkce");
const { badRequest } = require("../lib/errors");
const apiKeys = require("./apiKeyService");
const users = require("./userService");

const codeKey = (code) => `desktop:code:${code}`;

/** redirect_uri must be <scheme>://auth-callback with an editor_state query. */
function parseRedirectUri(raw) {
  let url;
  try {
    url = new URL(String(raw || ""));
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (!config.DESKTOP_REDIRECT_SCHEMES.includes(scheme)) return null;
  if (url.host !== "auth-callback" && url.pathname.replace(/^\/+/, "") !== "auth-callback" && url.href.indexOf("auth-callback") < 0) return null;
  const editorState = url.searchParams.get("editor_state");
  if (!editorState || !/^[A-Za-z0-9_-]{8,128}$/.test(editorState)) return null;
  return { href: url.href, scheme, editorState };
}

/** Validates the query the IDE sends; throws 400 with a code the page can show. */
function validateRequest({ redirectUri, codeChallenge, codeChallengeMethod, client }) {
  if (client && client !== "desktop") throw badRequest("Unsupported client.", "unsupported_client");
  const parsed = parseRedirectUri(redirectUri);
  if (!parsed) throw badRequest("redirect_uri must be the desktop callback link.", "invalid_redirect_uri");
  if ((codeChallengeMethod || "S256") !== "S256" || !isValidChallenge(codeChallenge)) throw badRequest("A PKCE S256 code_challenge is required.", "invalid_code_challenge");
  return parsed;
}

function appendParams(href, params) {
  const url = new URL(href);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.href;
}

/** Where the website hosts the sign-in page for this request. */
function websiteUrl(screen, query) {
  const url = new URL(`${config.WEB_APP_URL}/desktop/${screen === "signup" ? "signup" : "login"}`);
  for (const [k, v] of Object.entries(query || {})) if (typeof v === "string" && v) url.searchParams.set(k, v);
  return url.href;
}

/** The signed-in user confirmed on the website: mint the one-time code. */
async function approve(user, params) {
  const parsed = validateRequest(params);
  const code = randomId(32);
  await kv.setJSON(codeKey(code), { userId: user.id, codeChallenge: params.codeChallenge, redirectUri: parsed.href }, config.AUTH_CODE_TTL_SEC);
  return { redirectTo: appendParams(parsed.href, { code, editor_state: parsed.editorState }) };
}

/** The user declined on the website; nothing is stored. */
function deny(params) {
  const parsed = validateRequest(params);
  return { redirectTo: appendParams(parsed.href, { error: "access_denied", editor_state: parsed.editorState }) };
}

/** POST /api/auth/desktop/exchange */
async function exchange({ code, codeVerifier }, { userAgent, ip, platform }) {
  if (!code || typeof code !== "string") throw badRequest("code is required.", "invalid_code");
  const record = await kv.take(codeKey(code));
  const data = typeof record === "string" ? JSON.parse(record) : record;
  if (!data) throw badRequest("Code is invalid or already used.", "invalid_code");
  if (!verifyChallenge(codeVerifier, data.codeChallenge)) throw badRequest("PKCE verification failed.", "invalid_code_verifier");
  const user = await users.findById(data.userId);
  if (!user) throw badRequest("Account no longer exists.", "account_missing");
  const { plaintext, row, expiresAt } = await apiKeys.issueDeviceKey(user, { name: "Atomesus IDE", platform, userAgent, ip });
  return { token: plaintext, session: { expiresAt: expiresAt.toISOString() }, user: users.desktopUser(user), apiKey: row };
}

module.exports = { parseRedirectUri, validateRequest, websiteUrl, approve, deny, exchange };
