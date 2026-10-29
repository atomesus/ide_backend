const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");
const { RedisStore } = require("rate-limit-redis");
const { getRedisClient, isRedisEnabled } = require("../db/redis");
const { config } = require("../config/env");

const message = (text) => ({ success: false, code: 429, message: text, error: { code: "rate_limited", message: text } });

function clientIpKey(req) {
  return ipKeyGenerator(req.ip || req.socket?.remoteAddress || "unknown");
}

function create(options) {
  const { prefix, ...rest } = options;
  const base = { standardHeaders: true, legacyHeaders: false, ...rest, validate: { ...(rest.validate || {}), creationStack: false } };
  const redis = getRedisClient();
  if (isRedisEnabled() && redis) {
    return rateLimit({
      ...base,
      store: new RedisStore({ sendCommand: (...args) => redis.sendCommand(args), prefix: `${config.REDIS_KEY_PREFIX}rl:${prefix || ""}` }),
    });
  }
  return rateLimit(base);
}

/** Built on first request so Redis has had a chance to connect. */
function lazy(options) {
  let limiter = null;
  return (req, res, next) => {
    if (config.isTest && process.env.RATE_LIMITS_IN_TESTS !== "true") return next();
    if (!limiter) limiter = create(options);
    return limiter(req, res, next);
  };
}

const MIN15 = 15 * 60 * 1000;

const limiters = {
  loginIp: lazy({ windowMs: MIN15, max: config.LOGIN_IP_MAX_PER_15MIN, keyGenerator: clientIpKey, prefix: "login:ip:", message: message("Too many sign-in attempts from this network. Try again later.") }),
  desktopApprove: lazy({ windowMs: MIN15, max: config.DESKTOP_APPROVE_USER_MAX_PER_15MIN, keyGenerator: clientIpKey, prefix: "approve:ip:", message: message("Too many desktop sign-ins. Try again later.") }),
  providerRelay: lazy({ windowMs: MIN15, max: config.PROVIDER_RELAY_IP_MAX_PER_15MIN, keyGenerator: clientIpKey, prefix: "relay:ip:", message: message("Too many provider sign-in attempts. Try again later.") }),
  chat: lazy({ windowMs: 60 * 1000, max: config.CHAT_IP_MAX_PER_MIN, keyGenerator: (req) => (req.user?.id ? `user:${req.user.id}` : `ip:${clientIpKey(req)}`), prefix: "chat:", message: message("Too many requests. Slow down.") }),
  generic: lazy({ windowMs: 60 * 1000, max: 300, keyGenerator: clientIpKey, prefix: "generic:", message: message("Too many requests.") }),
};

module.exports = { limiters, lazyRateLimit: lazy };
