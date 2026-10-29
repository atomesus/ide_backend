/**
 * SQL (MySQL/MariaDB): the Atomesus platform database. `Users` is read-only
 * here (owned by zero_thought_node); the ide_* tables are owned by this service.
 */
const { Sequelize } = require("sequelize");
const { config } = require("../config/env");
const logger = require("../lib/logger");

function buildSequelize() {
  if (config.DB_DIALECT === "sqlite") {
    return new Sequelize({ dialect: "sqlite", storage: config.DB_STORAGE || ":memory:", logging: false });
  }
  return new Sequelize(config.DB_NAME, config.DB_USER, config.DB_PASS, {
    host: config.DB_HOST,
    port: config.DB_PORT,
    dialect: config.DB_DIALECT === "mariadb" ? "mariadb" : "mysql",
    logging: false,
    define: { charset: "utf8mb4", collate: "utf8mb4_unicode_ci" },
    pool: { max: config.DB_POOL_MAX, min: config.DB_POOL_MIN, acquire: 30000, idle: 10000 },
  });
}

const sequelize = buildSequelize();

/** Creates/alters only the ide_* tables. The platform's Users table is never touched. */
async function syncOwnedTables({ alter = false } = {}) {
  const { IDE_OWNED_MODELS, User, IdeSubscription } = require("../models/sql");
  if (config.isTest && config.DB_DIALECT === "sqlite") {
    // tests seed fake platform rows
    await User.sync();
    await IdeSubscription.sync();
  }
  for (const model of IDE_OWNED_MODELS) await model.sync({ alter });
}

let readyPromise = null;

async function connectSql() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    require("../models/sql");
    await sequelize.authenticate();
    if (config.DB_SYNC && !config.isProd) await syncOwnedTables();
    logger.info("SQL connected", { dialect: sequelize.getDialect(), db: config.DB_DIALECT === "sqlite" ? "sqlite" : config.DB_NAME });
    return sequelize;
  })().catch((err) => {
    readyPromise = null;
    throw err;
  });
  return readyPromise;
}

async function disconnectSql() {
  readyPromise = null;
  await sequelize.close();
}

module.exports = { sequelize, connectSql, disconnectSql, syncOwnedTables };
