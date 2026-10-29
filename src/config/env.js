/**
 * Loads .env once and validates the variables the service relies on.
 * Everything downstream imports `config` from here instead of reading
 * process.env ad hoc, so a typo in .env fails at boot, not at 3am.
 *
 * Accounts live in the Atomesus platform database (zero_thought_node); this
 * service reads that `Users` table and trusts the platform's JWT, so DB_* and
 * JWT_SECRET must be the platform's values.
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
  // The website (atomesis_frontend) that hosts /desktop/login and the account pages.
  WEB_APP_URL: str("http://localhost:3000"),
  TRUST_PROXY_HOPS: str(""),
  CORS_ALLOWED_ORIGINS: list(),
  HEALTH_TOKEN: str(""),
  LOG_LEVEL: str("info"),

  // Shared with zero_thought_node: verifies the platform's { id, email } session tokens.
  JWT_SECRET: str(""),

  MONGO_URI: str(""),
  MONGO_DB_NAME: str("atomesus_ide"),
  MONGO_REQUIRED: bool(true),
  MONGO_POOL_MIN: int(5),
  MONGO_POOL_MAX: int(50),
  DNS_SERVERS: list(),

  // The platform database. `Users` is read here; ide_* tables are owned here.
  DB_DIALECT: z.enum(["mysql", "mariadb", "sqlite"]).default("mysql"),
  DB_HOST: str("127.0.0.1"),
  DB_PORT: int(3306),
  DB_USER: str("root"),
  DB_PASS: str(""),
  DB_NAME: str("atomesusdb"),
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

  DESKTOP_REDIRECT_SCHEMES: list(),
  DEVICE_KEY_TTL_DAYS: int(30),
  AUTH_CODE_TTL_SEC: int(300),

  DESKTOP_APPROVE_USER_MAX_PER_15MIN: int(20),
  LOGIN_IP_MAX_PER_15MIN: int(20),
  PROVIDER_RELAY_IP_MAX_PER_15MIN: int(60),
  CHAT_IP_MAX_PER_MIN: int(120),

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
    (c.isProd ? errors : warnings).push("JWT_SECRET must be the platform's secret (same value as zero_thought_node) so website sessions verify here");
  }
  if (!c.MONGO_URI && c.MONGO_REQUIRED) errors.push("MONGO_URI is required (or set MONGO_REQUIRED=false for local dev)");
  if (c.DB_DIALECT !== "sqlite" && !c.DB_HOST) errors.push("DB_HOST is required");
  if (c.DB_DIALECT !== "sqlite" && !c.DB_NAME) errors.push("DB_NAME must be the platform database that holds the Users table");
  if (c.isProd && !c.REDIS_URL && !c.REDIS_HOST) warnings.push("Redis not configured: rate limits and sign-in codes are per-process only");
  if (c.isProd && c.REDIS_REQUIRED === false) warnings.push("REDIS_REQUIRED=false in production; multi-instance deployments need Redis");
  if (!c.ATOMESUS_BASE_URL) warnings.push("ATOMESUS_BASE_URL unset: /api/v1/chat/completions will answer 503");
  if (c.isProd && !c.API_PUBLIC_URL.startsWith("https://")) errors.push("API_PUBLIC_URL must be https in production");
  if (c.isProd && !c.WEB_APP_URL.startsWith("https://")) errors.push("WEB_APP_URL must be the https website that hosts /desktop/login");
  return { errors, warnings };
}

const config = loadConfig();

module.exports = { config, loadConfig, auditConfig, schema };
