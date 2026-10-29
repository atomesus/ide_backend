const request = require("supertest");
const { connectSql, disconnectSql } = require("../src/db/sql");
const { connectMongo, disconnectMongo, isMongoReady, mongoose } = require("../src/db/mongo");
const { createApp } = require("../src/app");
const { kv } = require("../src/db/redis");
const { User } = require("../src/models/sql");
const { signPlatformToken } = require("../src/lib/tokens");

async function bootTestApp() {
  await connectSql();
  await connectMongo().catch(() => null);
  if (isMongoReady()) await mongoose.connection.db.dropDatabase();
  return createApp();
}

async function shutdownTestApp() {
  await disconnectSql();
  await disconnectMongo();
  kv._memory.clear();
}

/**
 * Seeds a row the way the platform would (tests sync the read-only Users
 * model into SQLite) and signs the same JWT zero_thought_node issues.
 */
async function createPlatformUser(_app, { email = `u${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.com`, name = "Test User", planType = "free", ...rest } = {}) {
  const user = await User.create({ id: require("crypto").randomUUID(), email, name, planType, emailVerifiedAt: new Date(), ...rest });
  return { user, email, token: signPlatformToken(user) };
}

module.exports = { bootTestApp, shutdownTestApp, createPlatformUser, request };
