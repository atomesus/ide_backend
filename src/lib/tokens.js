const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { config } = require("../config/env");

function requireSecret() {
  if (!config.JWT_SECRET) throw new Error("JWT_SECRET is not configured");
  return config.JWT_SECRET;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Verifies a session token issued by the Atomesus platform (zero_thought_node
 * `createToken`: `{ id, email }` signed HS256 with the shared JWT_SECRET, 30d).
 * Admin tokens (Mongo ObjectId ids) and password-reset tokens (no id) are refused.
 */
function verifyPlatformToken(token) {
  const decoded = jwt.verify(token, requireSecret(), { algorithms: ["HS256"] });
  if (!decoded || typeof decoded !== "object" || !UUID_RE.test(String(decoded.id || ""))) {
    const err = new Error("Not a platform user session");
    err.code = "INVALID_TOKEN";
    throw err;
  }
  return decoded;
}

/** Same shape the platform signs; used by tests and local tooling only. */
function signPlatformToken(user, expiresIn = "30d") {
  return jwt.sign({ id: user.id, email: user.email }, requireSecret(), { expiresIn });
}

/** Device keys handed to the IDE: `sk_` + 43 url-safe chars. Only the hash is stored. */
const DEVICE_KEY_PREFIX = "sk_";

function generateDeviceKey() {
  return DEVICE_KEY_PREFIX + crypto.randomBytes(32).toString("base64url");
}

function isDeviceKey(token) {
  return typeof token === "string" && token.startsWith(DEVICE_KEY_PREFIX) && token.length >= 20;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function randomId(bytes = 24) {
  return crypto.randomBytes(bytes).toString("base64url");
}

module.exports = { verifyPlatformToken, signPlatformToken, generateDeviceKey, isDeviceKey, hashToken, randomId, DEVICE_KEY_PREFIX, UUID_RE };
