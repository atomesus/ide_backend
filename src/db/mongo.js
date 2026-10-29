/** Mongo holds append-only / document data: login history, IDE settings, usage events. */
const dns = require("dns");
const mongoose = require("mongoose");
const { config } = require("../config/env");
const logger = require("../lib/logger");

if (config.DNS_SERVERS.length) {
  try {
    dns.setServers(config.DNS_SERVERS);
  } catch (err) {
    logger.warn("DNS_SERVERS ignored", { error: err.message });
  }
}

mongoose.set("strictQuery", true);

let connectPromise = null;

async function connectMongo() {
  if (!config.MONGO_URI) {
    if (config.MONGO_REQUIRED) throw new Error("MONGO_URI is required");
    logger.warn("Mongo not configured; login history, settings and usage will not persist");
    return null;
  }
  if (connectPromise) return connectPromise;
  connectPromise = mongoose
    .connect(config.MONGO_URI, {
      dbName: config.MONGO_DB_NAME,
      maxPoolSize: config.MONGO_POOL_MAX,
      minPoolSize: config.MONGO_POOL_MIN,
      maxIdleTimeMS: 30000,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      w: "majority",
      wtimeoutMS: 5000,
    })
    .then((m) => {
      logger.info("MongoDB connected", { db: config.MONGO_DB_NAME });
      return m;
    })
    .catch((err) => {
      connectPromise = null;
      if (config.MONGO_REQUIRED) throw err;
      logger.warn("MongoDB unavailable; continuing because MONGO_REQUIRED=false", { error: err.message });
      return null;
    });
  return connectPromise;
}

function isMongoReady() {
  return mongoose.connection.readyState === 1;
}

async function disconnectMongo() {
  connectPromise = null;
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
}

module.exports = { mongoose, connectMongo, disconnectMongo, isMongoReady };
