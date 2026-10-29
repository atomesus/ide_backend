const { Op } = require("sequelize");
const { User, IdeSubscription } = require("../models/sql");
const { config } = require("../config/env");

/**
 * Platform accounts are owned by zero_thought_node. This module only reads
 * them (and their IDE subscription) and shapes them for the IDE; nothing here
 * writes the Users or IdeSubscriptions tables.
 *
 * The IDE plan is separate from the website's chat plan: it comes only from an
 * IDE subscription (Rs 299 / Rs 999 in India, $4 / $10 elsewhere).
 */

const PUBLIC_FIELDS = ["id", "email", "name", "country", "emailVerifiedAt", "createdAt"];

/** The IDE subscription that gives access right now, or null. */
async function currentIdeSubscription(userId) {
  return IdeSubscription.findOne({
    where: { userId, status: { [Op.in]: IdeSubscription.ACCESS_STATUSES }, currentPeriodEnd: { [Op.gt]: new Date() } },
    order: [["currentPeriodEnd", "DESC"]],
  });
}

/**
 * IDE plan key: "free", or the plan with its region ("ide_299", "ide_999_intl", ...).
 * Reads `user.ideSubscription`, which findById attaches.
 */
function planOf(user) {
  const sub = user?.ideSubscription;
  if (!sub || !sub.currentPeriodEnd || new Date(sub.currentPeriodEnd) <= new Date()) return "free";
  return sub.region === "IN" ? sub.plan : `${sub.plan}_intl`;
}

/** Whitelist-based response shape; nothing secret can leak by accident. */
function safeUser(user) {
  if (!user) return null;
  const plain = typeof user.toJSON === "function" ? user.toJSON() : user;
  const out = {};
  for (const k of PUBLIC_FIELDS) if (plain[k] !== undefined) out[k] = plain[k];
  out.plan = planOf(user);
  out.entitlements = entitlements(user);
  const sub = user.ideSubscription;
  out.ideSubscription = sub && out.plan !== "free"
    ? { plan: sub.plan, region: sub.region, status: sub.status, currentPeriodEnd: sub.currentPeriodEnd, cancelAtPeriodEnd: Boolean(sub.cancelAtPeriodEnd) }
    : null;
  return out;
}
/** 1 credit = Rs 0.0001, so wallets stay integers while tiny requests are still billed exactly. */
const CREDITS_PER_RUPEE = 10000;

function isPaid(user) {
  return planOf(user) !== "free";
}

/** Monthly hosted-model budget in rupees for the user's plan (0 = no hosted models). */
function monthlyAllowanceInr(plan) {
  if (!plan || plan === "free") return 0;
  return config.planAllowancesInr?.[plan] ?? 0;
}

function monthlyCreditsFor(plan) {
  return Math.round(monthlyAllowanceInr(plan) * CREDITS_PER_RUPEE);
}

/**
 * What the account may use in the IDE. Free accounts get nothing: no hosted
 * models and no bring-your-own-key. Paid plans always get BYOK (it runs from the
 * IDE straight to the user's provider); hosted models need a budget for the plan.
 */
function entitlements(user) {
  const plan = planOf(user);
  return { plan, paid: plan !== "free", byok: plan !== "free", hostedModels: monthlyAllowanceInr(plan) > 0 };
}

/** Shape the IDE expects from /api/auth/desktop/exchange and /api/auth/me. */
function desktopUser(user) {
  return { id: user.id, email: user.email, name: user.name || user.email, image: null, githubLogin: null, plan: planOf(user), entitlements: entitlements(user) };
}

/** Loads a platform user with its current IDE subscription attached as `user.ideSubscription`. */
async function findById(id) {
  if (!id) return null;
  const user = await User.findByPk(id);
  if (user) user.ideSubscription = await currentIdeSubscription(id);
  return user;
}

module.exports = { safeUser, desktopUser, planOf, isPaid, entitlements, monthlyAllowanceInr, monthlyCreditsFor, findById, currentIdeSubscription, CREDITS_PER_RUPEE };
