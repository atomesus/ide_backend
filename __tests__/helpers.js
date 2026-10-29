const request = require("supertest");
const { connectSql, disconnectSql } = require("../src/db/sql");
const { connectMongo, disconnectMongo, isMongoReady, mongoose } = require("../src/db/mongo");
const { createApp } = require("../src/app");
const { kv } = require("../src/db/redis");

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

/** Creates a verified user through the real OTP flow (console mailer) and returns { user, token, agent }. */
async function signupUser(app, { email = `u${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.com`, password = "correct-horse-battery" } = {}) {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    await request(app).post("/api/auth/signup/request-otp").send({ email, name: "Test", password }).expect(200);
  } finally {
    console.log = orig;
  }
  const otp = logs.join("\n").match(/is: (\d{6})/)?.[1];
  if (!otp) throw new Error("OTP not captured from console mailer");
  const res = await request(app).post("/api/auth/signup/verify-otp").send({ email, otp }).expect(201);
  return { email, password, token: res.body.data.token, user: res.body.data.user, cookie: res.headers["set-cookie"] };
}

module.exports = { bootTestApp, shutdownTestApp, signupUser, request };
