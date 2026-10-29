const { config } = require("../config/env");

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.net", "guerrillamail.org", "sharklasers.com", "yopmail.com",
  "yopmail.fr", "tempmail.com", "temp-mail.org", "temp-mail.io", "10minutemail.com", "trashmail.com", "getnada.com",
  "maildrop.cc", "dispostable.com", "fakeinbox.com", "mintemail.com", "mailnesia.com", "throwaway.email", "emailondeck.com",
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return EMAIL_RE.test(normalizeEmail(email)) && email.length <= 254;
}

function isDisposableBlocked(email) {
  const flag = config.DISPOSABLE_EMAIL_BLOCK;
  const enabled = flag ? ["1", "true", "yes"].includes(flag.toLowerCase()) : config.isProd;
  if (!enabled) return false;
  const domain = normalizeEmail(email).split("@")[1] || "";
  const parts = domain.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    if (DISPOSABLE_DOMAINS.has(parts.slice(i).join("."))) return true;
  }
  return false;
}

module.exports = { normalizeEmail, isValidEmail, isDisposableBlocked };
