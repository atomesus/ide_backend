const { User } = require("../models/sql");
const { normalizeEmail } = require("../lib/email");
const { config } = require("../config/env");

const PUBLIC_FIELDS = ["id", "email", "name", "image", "role", "plan", "subscriptionStatus", "planExpiresAt", "githubLogin", "country", "emailVerifiedAt", "lastLoginAt", "createdAt"];

/** Whitelist-based response shape; nothing secret can leak by accident. */
function safeUser(user) {
  if (!user) return null;
  const plain = typeof user.toJSON === "function" ? user.toJSON() : user;
  const out = {};
  for (const k of PUBLIC_FIELDS) if (plain[k] !== undefined) out[k] = plain[k];
  out.hasPassword = Boolean(plain.passwordHash);
  out.linked = { google: Boolean(plain.googleId), github: Boolean(plain.githubId) };
  return out;
}

/** Shape the IDE expects from /api/auth/desktop/exchange and /api/auth/me. */
function desktopUser(user) {
  return { id: user.id, email: user.email, name: user.name || user.email, image: user.image || null, githubLogin: user.githubLogin || null, plan: user.plan || "free" };
}

async function findByEmail(email) {
  return User.findOne({ where: { email: normalizeEmail(email) } });
}

async function findById(id) {
  return User.findByPk(id);
}

function monthlyCreditsFor(plan) {
  return plan === "pro" || plan === "team" ? config.PRO_PLAN_MONTHLY_CREDITS : config.FREE_PLAN_MONTHLY_CREDITS;
}

/**
 * Rolls the billing period forward when a month has passed and tops the
 * subscription wallet back up to the plan allowance. Idempotent.
 */
async function ensureBillingPeriod(user) {
  const now = new Date();
  const start = user.billingPeriodStart ? new Date(user.billingPeriodStart) : null;
  const expired = !start || now - start >= 30 * 24 * 60 * 60 * 1000;
  if (!expired) return user;
  user.billingPeriodStart = now;
  user.subscriptionCredits = monthlyCreditsFor(user.plan);
  await user.save();
  return user;
}

async function createUser({ email, name, passwordHash, googleId, githubId, githubLogin, image, emailVerified }) {
  const user = await User.create({
    email: normalizeEmail(email),
    name: String(name || "").trim() || normalizeEmail(email).split("@")[0],
    passwordHash: passwordHash || null,
    googleId: googleId || null,
    githubId: githubId || null,
    githubLogin: githubLogin || null,
    image: image || null,
    emailVerifiedAt: emailVerified ? new Date() : null,
    plan: "free",
    billingPeriodStart: new Date(),
    subscriptionCredits: monthlyCreditsFor("free"),
  });
  return user;
}

/** Find-or-create for an OAuth identity; links by verified email when the id is new. */
async function upsertOAuthUser(provider, { providerId, email, name, image, login }) {
  const idField = provider === "google" ? "googleId" : "githubId";
  let user = await User.findOne({ where: { [idField]: providerId } });
  if (!user && email) {
    user = await findByEmail(email);
    if (user) {
      user[idField] = providerId;
      if (!user.emailVerifiedAt) user.emailVerifiedAt = new Date();
      if (!user.image && image) user.image = image;
      if (provider === "github" && login) user.githubLogin = login;
      await user.save();
    }
  }
  if (!user) {
    if (!email) {
      const err = new Error(`${provider} account has no verified email`);
      err.status = 400;
      err.code = "email_required";
      throw err;
    }
    user = await createUser({ email, name, image, emailVerified: true, [idField]: providerId, githubLogin: provider === "github" ? login : undefined });
  }
  return user;
}

async function touchLogin(user) {
  user.lastLoginAt = new Date();
  await user.save({ fields: ["lastLoginAt"] });
}

module.exports = { safeUser, desktopUser, findByEmail, findById, createUser, upsertOAuthUser, touchLogin, ensureBillingPeriod, monthlyCreditsFor };
