/**
 * Desktop sign-in (docs/desktop-sign-in.md in the IDE repo):
 *
 *   IDE opens  GET /desktop/login?client=desktop&redirect_uri=atomesus://auth-callback?editor_state=X
 *                                 &code_challenge=C&code_challenge_method=S256
 *   user signs in on the page (GitHub / Google / email)
 *   page redirects to redirect_uri + &code=<one-time>
 *   IDE calls  POST /api/auth/desktop/exchange { code, codeVerifier }
 *              -> { token: "sk_...", session: { expiresAt }, user }
 */
const { kv } = require("../db/redis");
const { config } = require("../config/env");
const { randomId } = require("../lib/tokens");
const { isValidChallenge, verifyChallenge } = require("../lib/pkce");
const { badRequest } = require("../lib/errors");
const apiKeys = require("./apiKeyService");
const users = require("./userService");

const flowKey = (id) => `desktop:flow:${id}`;
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

async function createFlow({ screen, redirectUri, codeChallenge, codeChallengeMethod, client }) {
  if (client && client !== "desktop") throw badRequest("Unsupported client.", "unsupported_client");
  const parsed = parseRedirectUri(redirectUri);
  if (!parsed) throw badRequest("redirect_uri must be the desktop callback link.", "invalid_redirect_uri");
  if ((codeChallengeMethod || "S256") !== "S256" || !isValidChallenge(codeChallenge)) throw badRequest("A PKCE S256 code_challenge is required.", "invalid_code_challenge");
  const id = randomId(18);
  const flow = { id, screen: screen === "signup" ? "signup" : "login", redirectUri: parsed.href, editorState: parsed.editorState, codeChallenge, createdAt: Date.now() };
  await kv.setJSON(flowKey(id), flow, config.DESKTOP_FLOW_TTL_SEC);
  return flow;
}

async function getFlow(id) {
  if (!id || !/^[A-Za-z0-9_-]{10,64}$/.test(id)) return null;
  return kv.getJSON(flowKey(id));
}

function appendParams(href, params) {
  const url = new URL(href);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.href;
}

/** User confirmed on the page: mint the one-time code and finish the flow. */
async function approveFlow(flowId, user) {
  const flow = await getFlow(flowId);
  if (!flow) throw badRequest("Sign-in request expired. Go back to Atomesus and try again.", "flow_expired");
  const code = randomId(32);
  await kv.setJSON(codeKey(code), { userId: user.id, codeChallenge: flow.codeChallenge, flowId: flow.id }, config.AUTH_CODE_TTL_SEC);
  await kv.del(flowKey(flowId));
  return { redirectTo: appendParams(flow.redirectUri, { code, editor_state: flow.editorState }) };
}

async function denyFlow(flowId) {
  const flow = await getFlow(flowId);
  if (!flow) return { redirectTo: null };
  await kv.del(flowKey(flowId));
  return { redirectTo: appendParams(flow.redirectUri, { error: "access_denied", editor_state: flow.editorState }) };
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
  await users.touchLogin(user);
  return { token: plaintext, session: { expiresAt: expiresAt.toISOString() }, user: users.desktopUser(user), apiKey: row };
}

module.exports = { createFlow, getFlow, approveFlow, denyFlow, exchange, parseRedirectUri };
