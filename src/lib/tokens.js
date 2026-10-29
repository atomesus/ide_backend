const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { config } = require("../config/env");

function requireSecret() {
  if (!config.JWT_SECRET) throw new Error("JWT_SECRET is not configured");
  return config.JWT_SECRET;
}

/** Web/API session JWT for a platform user. */
function signSessionToken(user, extra = {}) {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role || "user", typ: "session", ...extra }, requireSecret(), {
    expiresIn: config.JWT_TTL,
  });
}

function verifySessionToken(token) {
  const decoded = jwt.verify(token, requireSecret());
  if (!decoded || decoded.typ !== "session" || !decoded.sub) {
    const err = new Error("Invalid session token");
    err.code = "INVALID_TOKEN";
    throw err;
  }
  return decoded;
}

/** Purpose-bound short-lived tokens (password reset, email verification). */
function signPurposeToken(purpose, payload, ttl) {
  return jwt.sign({ ...payload, typ: purpose }, requireSecret(), { expiresIn: ttl });
}

function verifyPurposeToken(purpose, token) {
  const decoded = jwt.verify(token, requireSecret());
  if (!decoded || decoded.typ !== purpose) {
    const err = new Error("Invalid token");
    err.code = "INVALID_TOKEN";
    throw err;
  }
  return decoded;
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

function generateOtp() {
  return crypto.randomInt(100000, 1000000).toString();
}

module.exports = {
  signSessionToken,
  verifySessionToken,
  signPurposeToken,
  verifyPurposeToken,
  generateDeviceKey,
  isDeviceKey,
  hashToken,
  randomId,
  generateOtp,
  DEVICE_KEY_PREFIX,
};
