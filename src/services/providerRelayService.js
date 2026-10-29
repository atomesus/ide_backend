/**
 * Stateless relay for provider OAuth token exchange / refresh.
 *
 * Guarantees:
 *  - touches no database and no cache;
 *  - never logs request or response bodies (only provider id + status);
 *  - responses carry Cache-Control: no-store (set by the route).
 */
const { getProvider } = require("../config/providers");
const { config } = require("../config/env");
const { fetchWithTimeout } = require("../lib/http");
const { badRequest, notFound, HttpError, unavailable } = require("../lib/errors");
const logger = require("../lib/logger");

function requireProvider(id) {
  if (!config.PROVIDER_RELAY_ENABLED) throw unavailable("Provider sign-in relay is disabled.", "relay_disabled");
  const p = getProvider(id);
  if (!p) throw notFound(`Unknown provider "${id}".`, "unknown_provider");
  return p;
}

function assertRedirectUri(provider, redirectUri) {
  if (!redirectUri) return provider.redirectUris[0];
  const okUri = provider.redirectUris.some((allowed) => redirectUri === allowed || (allowed.startsWith("http://localhost") && redirectUri.startsWith("http://localhost")) || (allowed.startsWith("http://127.0.0.1") && redirectUri.startsWith("http://127.0.0.1")));
  if (!okUri) throw badRequest("redirect_uri is not allowed for this provider.", "invalid_redirect_uri");
  return redirectUri;
}

/** Builds the browser URL for the IDE to open. Pure function of inputs. */
function buildAuthorizeUrl(providerId, { codeChallenge, state, redirectUri, nonce }) {
  const p = requireProvider(providerId);
  const uri = assertRedirectUri(p, redirectUri);
  if (p.pkce !== false && !codeChallenge) throw badRequest("codeChallenge is required.", "missing_code_challenge");
  if (!state) throw badRequest("state is required.", "missing_state");
  const params = new URLSearchParams({ response_type: "code", redirect_uri: uri, state, ...p.extraAuthorizeParams });
  if (p.clientId) params.set("client_id", p.clientId);
  if (p.scopes.length) params.set("scope", p.scopes.join(" "));
  if (p.pkce !== false) {
    params.set("code_challenge", codeChallenge);
    params.set("code_challenge_method", "S256");
  }
  if (nonce) params.set("nonce", nonce);
  return { url: `${p.authorizeUrl}?${params}`, redirectUri: uri };
}

function normalizeTokenResponse(p, json) {
  const expiresIn = Number(json.expires_in ?? json.expiresIn ?? 0);
  const data = json.data || json; // cline wraps in { success, data }
  return {
    provider: p.id,
    ideProvider: p.ideProvider,
    accessToken: data.access_token ?? data.accessToken ?? null,
    refreshToken: data.refresh_token ?? data.refreshToken ?? null,
    idToken: data.id_token ?? data.idToken ?? null,
    tokenType: data.token_type ?? "Bearer",
    scope: data.scope ?? null,
    expiresAt: data.expiresAt ? Number(data.expiresAt) : expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
    account: data.userInfo ?? data.account ?? null,
    raw: json,
  };
}

async function postToken(p, url, payload, mode) {
  const init = { method: "POST", headers: { accept: "application/json" } };
  if (mode === "form") {
    init.headers["content-type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(payload);
  } else {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(payload);
  }
  let res;
  try {
    res = await fetchWithTimeout(url, init, config.PROVIDER_RELAY_TIMEOUT_MS);
  } catch (err) {
    logger.warn("provider relay upstream unreachable", { provider: p.id, error: err.message });
    throw new HttpError(502, `${p.label} did not respond.`, "provider_unreachable");
  }
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  logger.info("provider relay", { provider: p.id, status: res.status });
  if (!res.ok) {
    const message = json.error_description || json.error?.message || json.message || (typeof json.error === "string" ? json.error : null) || `${p.label} rejected the request (${res.status}).`;
    throw new HttpError(res.status === 400 || res.status === 401 ? 400 : 502, message, "provider_rejected", { providerStatus: res.status, providerError: json.error ?? null });
  }
  return json;
}

async function exchangeCode(providerId, { code, codeVerifier, redirectUri, state }) {
  const p = requireProvider(providerId);
  if (!code) throw badRequest("code is required.", "missing_code");
  let authCode = String(code).trim();
  let authState = state;
  if (p.codeMayContainState && authCode.includes("#")) {
    const [c, s] = authCode.split("#");
    authCode = c;
    authState = authState || s;
  }
  const uri = assertRedirectUri(p, redirectUri);

  if (p.tokenRequest === "cline") {
    const json = await postToken(p, p.tokenUrl, { grant_type: "authorization_code", code: authCode, client_type: "extension", redirect_uri: uri, provider: "workos" }, "json");
    return normalizeTokenResponse(p, json);
  }
  if (!codeVerifier) throw badRequest("codeVerifier is required.", "missing_code_verifier");
  const payload = { grant_type: "authorization_code", client_id: p.clientId, code: authCode, code_verifier: codeVerifier, redirect_uri: uri };
  if (authState && p.tokenRequest === "json") payload.state = authState;
  const json = await postToken(p, p.tokenUrl, payload, p.tokenRequest);
  return normalizeTokenResponse(p, json);
}

async function refreshToken(providerId, { refreshToken: rt }) {
  const p = requireProvider(providerId);
  if (!p.supportsRefresh) throw badRequest("This provider does not support refresh.", "refresh_unsupported");
  if (!rt) throw badRequest("refreshToken is required.", "missing_refresh_token");
  if (p.tokenRequest === "cline") {
    const json = await postToken(p, p.refreshUrl || p.tokenUrl, { grantType: "refresh_token", refreshToken: rt }, "json");
    return normalizeTokenResponse(p, json);
  }
  const payload = { grant_type: "refresh_token", client_id: p.clientId, refresh_token: rt };
  if (p.scopes.length && p.tokenRequest === "json") payload.scope = p.scopes.join(" ");
  const json = await postToken(p, p.tokenUrl, payload, p.tokenRequest);
  return normalizeTokenResponse(p, json);
}

module.exports = { buildAuthorizeUrl, exchangeCode, refreshToken, requireProvider };
