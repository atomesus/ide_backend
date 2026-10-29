/**
 * Minimal structured logger with secret redaction. One JSON line per event in
 * production, readable lines elsewhere. Anything under a key that looks like a
 * credential is replaced before it is written, so provider tokens that pass
 * through the relay can never end up in a log file.
 */
const { config } = require("../config/env");

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.LOG_LEVEL] ?? LEVELS.info;

const SECRET_KEY_RE = /(token|secret|password|passwd|authorization|cookie|api[_-]?key|code_verifier|codeverifier|refresh|otp|client_secret)/i;

function redact(value, key = "", depth = 0) {
  if (depth > 6) return "[depth]";
  if (SECRET_KEY_RE.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((v) => redact(v, "", depth + 1));
  if (value instanceof Error) return { name: value.name, message: value.message, code: value.code, stack: config.isProd ? undefined : value.stack };
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k, depth + 1)]));
  }
  if (typeof value === "string" && value.length > 2000) return `${value.slice(0, 2000)}…`;
  return value;
}

function write(level, msg, fields) {
  if (LEVELS[level] < threshold) return;
  if (config.isTest && level !== "error") return;
  const record = { level, time: new Date().toISOString(), msg, ...(fields ? redact(fields) : {}) };
  const line = config.isProd ? JSON.stringify(record) : `[${level}] ${msg}${fields ? " " + JSON.stringify(redact(fields)) : ""}`;
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
}

const logger = {
  debug: (msg, fields) => write("debug", msg, fields),
  info: (msg, fields) => write("info", msg, fields),
  warn: (msg, fields) => write("warn", msg, fields),
  error: (msg, fields) => write("error", msg, fields),
  redact,
};

module.exports = logger;
