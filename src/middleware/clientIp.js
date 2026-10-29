const { config } = require("../config/env");

/**
 * Express `trust proxy` value. Same reasoning as zero_thought_node: an explicit
 * hop count wins; otherwise production trusts loopback + private ranges only,
 * so a client cannot forge X-Forwarded-For to dodge per-IP limits.
 */
function resolveTrustProxy() {
  const raw = String(config.TRUST_PROXY_HOPS || "").trim();
  if (raw !== "" && Number.isFinite(Number.parseInt(raw, 10))) return Number.parseInt(raw, 10);
  return config.isProd ? "loopback, uniquelocal" : 1;
}

function getClientIp(req) {
  let ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (ip === "::1") ip = "127.0.0.1";
  return ip;
}

module.exports = { resolveTrustProxy, getClientIp };
