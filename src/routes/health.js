const express = require("express");
const crypto = require("crypto");
const { config, auditConfig } = require("../config/env");
const { mongoose, isMongoReady } = require("../db/mongo");
const { sequelize } = require("../db/sql");
const { getRedisClient, isRedisEnabled } = require("../db/redis");
const { listProviders } = require("../config/providers");

const router = express.Router();
const pkg = require("../../package.json");

function hasHealthToken(req) {
  if (!config.HEALTH_TOKEN) return false;
  const a = Buffer.from(String(req.get("x-health-token") || ""));
  const b = Buffer.from(config.HEALTH_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Liveness. Public answer is `{ ok: true }`; details need X-Health-Token. */
router.get("/health", (req, res) => {
  if (!hasHealthToken(req)) return res.json({ ok: true });
  const { warnings } = auditConfig(config);
  res.json({
    ok: true,
    service: pkg.name,
    version: pkg.version,
    uptimeSeconds: Math.floor(process.uptime()),
    mongo: { state: ["disconnected", "connected", "connecting", "disconnecting"][mongoose.connection.readyState] ?? "unknown" },
    sql: { dialect: sequelize.getDialect() },
    redis: { configured: isRedisEnabled(), connected: Boolean(getRedisClient()) },
    config: {
      github: Boolean(config.GITHUB_CLIENT_ID),
      google: Boolean(config.GOOGLE_CLIENT_ID),
      providerRelay: config.PROVIDER_RELAY_ENABLED ? listProviders().map((p) => p.id) : [],
      modelGateway: Boolean(config.ATOMESUS_BASE_URL),
    },
    warnings,
  });
});

/** Readiness for load balancers. */
router.get("/health/ready", async (req, res) => {
  if (config.MONGO_URI && !isMongoReady()) return res.status(503).json({ ok: false, reason: "mongo_not_connected" });
  try {
    await sequelize.authenticate();
  } catch (err) {
    return res.status(503).json({ ok: false, reason: "sql_unavailable", detail: config.isProd ? undefined : err.message });
  }
  if (config.REDIS_REQUIRED) {
    const redis = getRedisClient();
    if (!redis) return res.status(503).json({ ok: false, reason: "redis_not_connected" });
    try {
      await redis.ping();
    } catch (err) {
      return res.status(503).json({ ok: false, reason: "redis_unavailable", detail: config.isProd ? undefined : err.message });
    }
  }
  res.json({ ok: true });
});

module.exports = router;
