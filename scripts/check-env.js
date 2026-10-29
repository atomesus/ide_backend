#!/usr/bin/env node
// Validates .env and prints what is on/off. Exit 1 on hard errors.
const { config, auditConfig } = require("../src/config/env");
const { errors, warnings } = auditConfig(config);
const on = (v) => (v ? "on " : "off");
console.log(`env: ${config.NODE_ENV}  port: ${config.PORT}  api: ${config.API_PUBLIC_URL}  website: ${config.WEB_APP_URL}`);
console.log(`mongo ${on(config.MONGO_URI)}  sql ${config.DB_DIALECT}@${config.DB_HOST}/${config.DB_NAME} (platform Users)  redis ${on(config.REDIS_URL || config.REDIS_HOST)}`);
console.log(`provider-relay ${on(config.PROVIDER_RELAY_ENABLED)}  model-gateway ${on(config.ATOMESUS_BASE_URL)}`);
for (const w of warnings) console.warn(`⚠️  ${w}`);
for (const e of errors) console.error(`❌ ${e}`);
process.exit(errors.length ? 1 : 0);
