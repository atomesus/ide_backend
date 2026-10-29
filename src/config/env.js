/**
 * Loads .env once and validates the variables the service relies on.
 * Everything downstream imports `config` from here instead of reading
 * process.env ad hoc, so a typo in .env fails at boot, not at 3am.
 */
const path = require("path");
const { z } = require("zod");

require("dotenv").config({ path: process.env.DOTENV_PATH || path.resolve(process.cwd(), ".env"), quiet: true });

const bool = (def) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === "" ? def : ["1", "true", "yes", "on"].includes(String(v).toLowerCase())));

const int = (def) =>
  z
    .string()
    .optional()
    .transform((v) => {
      const n = Number.parseInt(String(v ?? ""), 10);
      return Number.isFinite(n) ? n : def;
    });

const str = (def = "") => z.string().optional().transform((v) => (v == null ? def : String(v).trim()));

const list = () =>
  z
    .string()
    .optional()
    .transform((v) =>
      String(v || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: int(4100),
  API_PUBLIC_URL: str("http://localhost:4100"),
  WEB_APP_URL: str("http://localhost:3000"),
  TRUST_PROXY_HOPS: str(""),
  CORS_ALLOWED_ORIGINS: list(),
  HEALTH_TOKEN: str(""),
  LOG_LEVEL: str("info"),

  JWT_SECRET: str(""),
  JWT_TTL: str("30d"),
  SESSION_COOKIE_NAME: str("atomesus_session"),

  MONGO_URI: str(""),
  MONGO_DB_NAME: str("atomesus_ide"),
  MONGO_REQUIRED: bool(true),
  MONGO_POOL_MIN: int(5),
  MONGO_POOL_MAX: int(50),
  DNS_SERVERS: list(),

  DB_DIALECT: z.enum(["mysql", "mariadb", "sqlite"]).default("mysql"),
  DB_HOST: str("127.0.0.1"),
  DB_PORT: int(3306),
  DB_USER: str("root"),
  DB_PASS: str(""),
  DB_NAME: str("atomesus_ide"),
  DB_POOL_MIN: int(5),
  DB_POOL_MAX: int(20),
  DB_SYNC: bool(true),
  DB_STORAGE: str(""),

  REDIS_URL: str(""),
  REDIS_HOST: str(""),
  REDIS_PORT: int(6379),
  REDIS_USERNAME: str(""),
  REDIS_PASSWORD: str(""),
  REDIS_TLS: bool(false),
  REDIS_REQUIRED: bool(false),
  REDIS_KEY_PREFIX: str("ide:"),

  GITHUB_CLIENT_ID: str(""),
  GITHUB_CLIENT_SECRET: str(""),
  GOOGLE_CLIENT_ID: str(""),
  GOOGLE_CLIENT_SECRET: str(""),
  DESKTOP_REDIRECT_SCHEMES: list(),
  DEVICE_KEY_TTL_DAYS: int(30),
  DESKTOP_FLOW_TTL_SEC: int(600),
  AUTH_CODE_TTL_SEC: int(300),
  OTP_TTL_SEC: int(600),
  PASSWORD_RESET_TOKEN_TTL: str("15m"),
  DISPOSABLE_EMAIL_BLOCK: str(""),

  SIGNUP_OTP_EMAIL_MAX_PER_15MIN: int(3),
  SIGNUP_OTP_IP_MAX_PER_15MIN: int(5),
  SIGNUP_OTP_IP_MAX_PER_HOUR: int(10),
  SIGNUP_VERIFY_EMAIL_MAX_PER_15MIN: int(5),
  SIGNUP_VERIFY_IP_MAX_PER_15MIN: int(10),
  SIGNUP_VERIFY_IP_MAX_PER_HOUR: int(15),
  LOGIN_EMAIL_MAX_PER_15MIN: int(10),
  LOGIN_IP_MAX_PER_15MIN: int(20),
  PROVIDER_RELAY_IP_MAX_PER_15MIN: int(60),
  CHAT_IP_MAX_PER_MIN: int(120),

  AWS_REGION: str(""),
  AWS_ACCESS_KEY_ID: str(""),
  AWS_SECRET_ACCESS_KEY: str(""),
  SES_REGION: str(""),
  EMAIL_HOST: str(""),
  EMAIL_PORT: int(465),
  EMAIL_USER: str(""),
  EMAIL_PASS: str(""),
  FROM_EMAIL: str("noreply@atomesus.com"),
  EMAIL_FROM_NAME: str("Atomesus"),

  PROVIDER_RELAY_ENABLED: bool(true),
  OPENAI_CODEX_CLIENT_ID: str(""),
  CLAUDE_OAUTH_CLIENT_ID: str(""),
  XAI_GROK_CLIENT_ID: str(""),
  PROVIDER_RELAY_TIMEOUT_MS: int(20000),

  ATOMESUS_BASE_URL: str(""),
  ATOMESUS_MODEL: str("ethos-6"),
  ATOMESUS_API_KEY: str(""),
  ATOMESUS_HOSTED_CHAT_API_KEY: str(""),
  ATOMESUS_MAX_CONTEXT_TOKENS: int(256000),
  ATOMESUS_MODELS: str(""),
  CHAT_UPSTREAM_TIMEOUT_MS: int(90000),
  FREE_PLAN_MONTHLY_CREDITS: int(200),
  PRO_PLAN_MONTHLY_CREDITS: int(5000),
  INPUT_CREDIT_MULTIPLIER: z.string().optional().transform((v) => (v ? Number(v) || 1 : 1)),
  OUTPUT_CREDIT_MULTIPLIER: z.string().optional().transform((v) => (v ? Number(v) || 3 : 3)),
});

function loadConfig(env = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new Error(`Invalid environment:\n  ${issues}`);
  }
  const c = parsed.data;
  c.isProd = c.NODE_ENV === "production";
  c.isTest = c.NODE_ENV === "test";
  if (c.DESKTOP_REDIRECT_SCHEMES.length === 0) c.DESKTOP_REDIRECT_SCHEMES = ["atomesus", "orbit"];
  if (!c.ATOMESUS_API_KEY && c.ATOMESUS_HOSTED_CHAT_API_KEY) c.ATOMESUS_API_KEY = c.ATOMESUS_HOSTED_CHAT_API_KEY;
  c.API_PUBLIC_URL = c.API_PUBLIC_URL.replace(/\/+$/, "");
  c.WEB_APP_URL = c.WEB_APP_URL.replace(/\/+$/, "");
  return c;
}

/**
 * Hard requirements that must stop the process, and soft ones that only warn.
 * Returns { errors, warnings }.
 */
function auditConfig(c) {
  const errors = [];
  const warnings = [];
  if (!c.JWT_SECRET || c.JWT_SECRET.length < 32 || c.JWT_SECRET === "change-me-64-hex") {
    (c.isProd ? errors : warnings).push("JWT_SECRET must be a random string of at least 32 chars (openssl rand -hex 32)");
  }
  if (!c.MONGO_URI && c.MONGO_REQUIRED) errors.push("MONGO_URI is required (or set MONGO_REQUIRED=false for local dev)");
  if (c.DB_DIALECT !== "sqlite" && !c.DB_HOST) errors.push("DB_HOST is required");
  if (c.isProd && !c.REDIS_URL && !c.REDIS_HOST) warnings.push("Redis not configured: rate limits and OTPs are per-process only");
  if (c.isProd && c.REDIS_REQUIRED === false) warnings.push("REDIS_REQUIRED=false in production; multi-instance deployments need Redis");
  if (!c.GITHUB_CLIENT_ID || !c.GITHUB_CLIENT_SECRET) warnings.push("GitHub sign-in disabled: GITHUB_CLIENT_ID/SECRET unset");
  if (!c.GOOGLE_CLIENT_ID) warnings.push("Google sign-in disabled: GOOGLE_CLIENT_ID unset");
  if (!c.ATOMESUS_BASE_URL) warnings.push("ATOMESUS_BASE_URL unset: /api/v1/chat/completions will answer 503");
  if (c.isProd && !c.API_PUBLIC_URL.startsWith("https://")) errors.push("API_PUBLIC_URL must be https in production");
  return { errors, warnings };
}

const config = loadConfig();

module.exports = { config, loadConfig, auditConfig, schema };
