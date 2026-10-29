const { verifyPlatformToken, isDeviceKey } = require("../lib/tokens");
const { resolveDeviceKey } = require("../services/apiKeyService");
const { findById } = require("../services/userService");
const { unauthorized } = require("../lib/errors");
const { getClientIp } = require("./clientIp");

function readBearer(req) {
  const header = req.get("authorization") || "";
  if (header.startsWith("Bearer ")) {
    const token = header.slice(7).trim();
    if (token && token !== "null" && token !== "undefined") return token;
  }
  return null;
}

/**
 * Resolves the caller from either a device key (`sk_...`, issued to IDE
 * installs) or the platform session JWT the website holds (`auth_token`).
 * Sets req.user (platform Users row) and req.auth.
 */
async function resolveRequestUser(req) {
  const bearer = readBearer(req);
  if (!bearer) return null;
  if (isDeviceKey(bearer)) {
    const resolved = await resolveDeviceKey(bearer, { ip: getClientIp(req) });
    if (!resolved) return null;
    return { user: resolved.user, auth: { kind: "device_key", apiKeyId: resolved.apiKey.id, token: bearer } };
  }
  const decoded = verifyPlatformToken(bearer); // throws on invalid/expired/non-user
  const user = await findById(decoded.id);
  if (!user) return null;
  return { user, auth: { kind: "platform_session", token: bearer } };
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
      if (err.name === "TokenExpiredError" || err.name === "JsonWebTokenError" || err.code === "INVALID_TOKEN") {
        return next(unauthorized("Your session has expired. Sign in again.", "invalid_token"));
      }
      next(err);
    }
  };
}

module.exports = { requireAuth, resolveRequestUser, readBearer };
