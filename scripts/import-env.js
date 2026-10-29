#!/usr/bin/env node
/**
 * Copies the [shared] keys from another .env (by default ../zero_thought_node/.env)
 * into this project's .env without touching keys that are already set here.
 *
 *   npm run env:import -- ../zero_thought_node/.env [--overwrite] [--dry-run] [--dest path/to/.env]
 *
 * Only the allow-listed keys below are read; the source file is never printed.
 */
const fs = require("fs");
const path = require("path");

const SHARED_KEYS = [
  "NODE_ENV", "TRUST_PROXY_HOPS", "CORS_ALLOWED_ORIGINS", "HEALTH_TOKEN",
  "JWT_SECRET",
  "MONGO_URI", "MONGO_REQUIRED", "MONGO_POOL_MIN", "MONGO_POOL_MAX", "DNS_SERVERS",
  "DB_HOST", "DB_PORT", "DB_USER", "DB_PASS", "DB_NAME", "DB_POOL_MIN", "DB_POOL_MAX",
  "REDIS_URL", "REDIS_HOST", "REDIS_PORT", "REDIS_USERNAME", "REDIS_PASSWORD", "REDIS_TLS", "REDIS_REQUIRED",
  "LOGIN_IP_MAX_PER_15MIN",
  "ATOMESUS_BASE_URL", "ATOMESUS_MODEL", "ATOMESUS_HOSTED_CHAT_API_KEY", "ATOMESUS_MAX_CONTEXT_TOKENS",
];
// DB_NAME IS shared on purpose: accounts live in the platform database (its Users table).
// Intentionally NOT shared: PORT, MONGO_DB_NAME (this service keeps its own Mongo database).

function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    const hash = val.search(/\s#/);
    if (hash > -1 && !/^["']/.test(val)) val = val.slice(0, hash).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const overwrite = args.includes("--overwrite");
  const dryRun = args.includes("--dry-run");
  const destFlag = args.indexOf("--dest");
  const destArg = destFlag > -1 ? args[destFlag + 1] : null;
  const positional = args.filter((a, i) => !a.startsWith("--") && i !== destFlag + 1);
  const src = path.resolve(positional[0] || path.join(__dirname, "..", "..", "zero_thought_node", ".env"));
  const dest = path.resolve(destArg || path.join(__dirname, "..", ".env"));
  const example = path.resolve(__dirname, "..", ".env.example");

  if (!fs.existsSync(src)) {
    console.error(`source not found: ${src}`);
    process.exit(1);
  }
  const source = parseEnv(fs.readFileSync(src, "utf8"));
  const destText = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : fs.readFileSync(example, "utf8");
  const current = parseEnv(destText);

  const updates = {};
  for (const key of SHARED_KEYS) {
    const value = source[key];
    if (value == null || value === "") continue;
    const existing = current[key];
    const isPlaceholder = !existing || existing === "" || /change-me/.test(existing);
    if (overwrite || isPlaceholder) updates[key] = value;
  }

  if (Object.keys(updates).length === 0) {
    console.log("nothing to import (all shared keys already set; use --overwrite to replace)");
    return;
  }

  let text = destText;
  for (const [key, value] of Object.entries(updates)) {
    const re = new RegExp(`^${key}=.*$`, "m");
    const line = `${key}=${/[\s#"']/.test(value) ? JSON.stringify(value) : value}`;
    text = re.test(text) ? text.replace(re, line) : `${text.replace(/\s*$/, "")}\n${line}\n`;
  }
  console.log(`${dryRun ? "would import" : "imported"} ${Object.keys(updates).length} keys from ${path.basename(path.dirname(src))}/.env:`);
  for (const key of Object.keys(updates)) console.log(`  ${key}`);
  if (!dryRun) {
    fs.writeFileSync(dest, text, { mode: 0o600 });
    console.log(`wrote ${dest}`);
  }
}

main();
