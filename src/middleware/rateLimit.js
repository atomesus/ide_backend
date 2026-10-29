const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");
const { RedisStore } = require("rate-limit-redis");
const { getRedisClient, isRedisEnabled } = require("../db/redis");
const { config } = require("../config/env");
const { normalizeEmail } = require("../lib/email");

const message = (text) => ({ success: false, code: 429, message: text, error: { code: "rate_limited", message: text } });

function clientIpKey(req) {
  return ipKeyGenerator(req.ip || req.socket?.remoteAddress || "unknown");
}

function clientEmailKey(req) {
  const email = normalizeEmail(req.body?.email);
  return email ? `email:${email}` : `ip:${clientIpKey(req)}`;
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
const HOUR = 60 * 60 * 1000;

const limiters = {
  otpRequestEmail: lazy({ windowMs: MIN15, max: config.SIGNUP_OTP_EMAIL_MAX_PER_15MIN, keyGenerator: clientEmailKey, prefix: "otp:email:", message: message("Too many code requests. Try again in 15 minutes.") }),
  otpRequestIp: lazy({ windowMs: MIN15, max: config.SIGNUP_OTP_IP_MAX_PER_15MIN, keyGenerator: clientIpKey, prefix: "otp:ip15:", message: message("Too many sign-up attempts from this network. Try again in 15 minutes.") }),
  otpRequestIpHourly: lazy({ windowMs: HOUR, max: config.SIGNUP_OTP_IP_MAX_PER_HOUR, keyGenerator: clientIpKey, prefix: "otp:ip1h:", message: message("Too many sign-up attempts from this network. Try again in an hour.") }),
  otpVerifyEmail: lazy({ windowMs: MIN15, max: config.SIGNUP_VERIFY_EMAIL_MAX_PER_15MIN, keyGenerator: clientEmailKey, prefix: "verify:email:", message: message("Too many verification attempts. Try again later.") }),
  otpVerifyIp: lazy({ windowMs: MIN15, max: config.SIGNUP_VERIFY_IP_MAX_PER_15MIN, keyGenerator: clientIpKey, prefix: "verify:ip15:", message: message("Too many verification attempts from this network.") }),
  otpVerifyIpHourly: lazy({ windowMs: HOUR, max: config.SIGNUP_VERIFY_IP_MAX_PER_HOUR, keyGenerator: clientIpKey, prefix: "verify:ip1h:", message: message("Too many verification attempts from this network. Try again in an hour.") }),
  loginEmail: lazy({ windowMs: MIN15, max: config.LOGIN_EMAIL_MAX_PER_15MIN, keyGenerator: clientEmailKey, prefix: "login:email:", message: message("Too many login attempts. Try again later.") }),
  loginIp: lazy({ windowMs: MIN15, max: config.LOGIN_IP_MAX_PER_15MIN, keyGenerator: clientIpKey, prefix: "login:ip:", message: message("Too many login attempts from this network. Try again later.") }),
  providerRelay: lazy({ windowMs: MIN15, max: config.PROVIDER_RELAY_IP_MAX_PER_15MIN, keyGenerator: clientIpKey, prefix: "relay:ip:", message: message("Too many provider sign-in attempts. Try again later.") }),
  chat: lazy({ windowMs: 60 * 1000, max: config.CHAT_IP_MAX_PER_MIN, keyGenerator: (req) => (req.user?.id ? `user:${req.user.id}` : `ip:${clientIpKey(req)}`), prefix: "chat:", message: message("Too many requests. Slow down.") }),
  generic: lazy({ windowMs: 60 * 1000, max: 300, keyGenerator: clientIpKey, prefix: "generic:", message: message("Too many requests.") }),
};

const otpRequestChain = [limiters.otpRequestIpHourly, limiters.otpRequestIp, limiters.otpRequestEmail];
const otpVerifyChain = [limiters.otpVerifyIpHourly, limiters.otpVerifyIp, limiters.otpVerifyEmail];
const loginChain = [limiters.loginIp, limiters.loginEmail];

module.exports = { limiters, otpRequestChain, otpVerifyChain, loginChain, lazyRateLimit: lazy };
