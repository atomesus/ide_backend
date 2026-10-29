const { verifySessionToken, isDeviceKey } = require("../lib/tokens");
const { resolveDeviceKey } = require("../services/apiKeyService");
const { findById } = require("../services/userService");
const { unauthorized } = require("../lib/errors");
const { config } = require("../config/env");
const { getClientIp } = require("./clientIp");

function readBearer(req) {
  const header = req.get("authorization") || "";
  if (header.startsWith("Bearer ")) {
    const token = header.slice(7).trim();
    if (token && token !== "null" && token !== "undefined") return token;
  }
  return null;
}

function readSessionCookie(req) {
  const token = req.cookies?.[config.SESSION_COOKIE_NAME];
  return token && token !== "null" ? token : null;
}

/**
 * Resolves the caller from either a device key (`sk_...`, issued to IDE
 * installs) or a session JWT (website / API). Sets req.user, req.auth.
 */
async function resolveRequestUser(req) {
  const bearer = readBearer(req);
  if (bearer && isDeviceKey(bearer)) {
    const resolved = await resolveDeviceKey(bearer, { ip: getClientIp(req) });
    if (!resolved) return null;
    return { user: resolved.user, auth: { kind: "device_key", apiKeyId: resolved.apiKey.id, token: bearer } };
  }
  const token = bearer || readSessionCookie(req);
  if (!token) return null;
  const decoded = verifySessionToken(token); // throws on invalid/expired
  const user = await findById(decoded.sub);
  if (!user) return null;
  return { user, auth: { kind: "session", token } };
}

/** strict=true rejects anonymous callers; strict=false just sets req.user = null. */
function requireAuth(strict = true) {
  return async (req, res, next) => {
    try {
      const resolved = await resolveRequestUser(req);
      if (!resolved) {
        if (strict) return next(unauthorized("Please sign in.", "not_authenticated"));
        req.user = null;
        req.auth = null;
        return next();
      }
      req.user = resolved.user;
      req.auth = resolved.auth;
      next();
    } catch (err) {
      if (!strict) {
        req.user = null;
        req.auth = null;
        return next();
      }
      next(err);
    }
  };
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) return next(unauthorized("Forbidden", "forbidden"));
    next();
  };
}

module.exports = { requireAuth, requireRole, resolveRequestUser, readBearer };
