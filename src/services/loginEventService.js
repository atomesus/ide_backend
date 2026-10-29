const { isMongoReady } = require("../db/mongo");
const { LoginEvent } = require("../models/mongo");
const logger = require("../lib/logger");
const { getClientIp } = require("../middleware/clientIp");

/** Records a platform sign-in. Never throws: auditing must not break login. */
async function recordLogin(req, { userId, method, client, outcome = "success", apiKeyId }) {
  if (!isMongoReady()) return;
  try {
    await LoginEvent.create({ userId, method, client, outcome, apiKeyId, ip: getClientIp(req), userAgent: String(req.get("user-agent") || "").slice(0, 512) });
  } catch (err) {
    logger.warn("login event not recorded", { error: err.message });
  }
}

async function listLogins(userId, limit = 50) {
  if (!isMongoReady()) return [];
  return LoginEvent.find({ userId }).sort({ at: -1 }).limit(limit).lean();
}

module.exports = { recordLogin, listLogins };
