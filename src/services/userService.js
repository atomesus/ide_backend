const { User } = require("../models/sql");
const { config } = require("../config/env");

/**
 * Platform accounts are owned by zero_thought_node. This module only reads
 * them and shapes them for the IDE; nothing here writes the Users table.
 */

const PUBLIC_FIELDS = ["id", "email", "name", "country", "planType", "subscriptionStatus", "planExpiryDate", "emailVerifiedAt", "createdAt"];

/** Whitelist-based response shape; nothing secret can leak by accident. */
function safeUser(user) {
  if (!user) return null;
  const plain = typeof user.toJSON === "function" ? user.toJSON() : user;
  const out = {};
  for (const k of PUBLIC_FIELDS) if (plain[k] !== undefined) out[k] = plain[k];
  out.plan = planOf(plain);
  return out;
}

/**
 * Plan label as the IDE shows it. The platform's planType is free text written
 * by several payment channels; anything that is not "free" is a paid plan, and
 * a lapsed subscription counts as free.
 */
function planOf(user) {
  const raw = String(user?.planType || "free").trim().toLowerCase();
  if (!raw || raw === "free") return "free";
  if (user?.planExpiryDate && new Date(user.planExpiryDate) < new Date()) return "free";
  return raw;
}

function monthlyCreditsFor(plan) {
  return plan === "free" ? config.FREE_PLAN_MONTHLY_CREDITS : config.PRO_PLAN_MONTHLY_CREDITS;
}

/** Shape the IDE expects from /api/auth/desktop/exchange and /api/auth/me. */
function desktopUser(user) {
  return { id: user.id, email: user.email, name: user.name || user.email, image: null, githubLogin: null, plan: planOf(user) };
}

async function findById(id) {
  if (!id) return null;
  return User.findByPk(id);
}

module.exports = { safeUser, desktopUser, planOf, monthlyCreditsFor, findById };
