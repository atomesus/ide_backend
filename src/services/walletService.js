const { IdeWallet } = require("../models/sql");
const { planOf, monthlyCreditsFor } = require("./userService");

const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Loads (or creates) the user's IDE wallet and rolls the billing period
 * forward when 30 days have passed or the plan changed, refilling the
 * subscription credits to the plan allowance. Idempotent.
 */
async function ensureWallet(user) {
  const plan = planOf(user);
  const [wallet] = await IdeWallet.findOrCreate({
    where: { userId: user.id },
    defaults: { plan, subscriptionCredits: monthlyCreditsFor(plan), topUpCredits: 0, billingPeriodStart: new Date() },
  });
  const start = wallet.billingPeriodStart ? new Date(wallet.billingPeriodStart) : null;
  const expired = !start || Date.now() - start.getTime() >= PERIOD_MS;
  if (expired || wallet.plan !== plan) {
    wallet.plan = plan;
    wallet.subscriptionCredits = monthlyCreditsFor(plan);
    if (expired) wallet.billingPeriodStart = new Date();
    await wallet.save();
  }
  return wallet;
}

function available(wallet) {
  return (wallet.subscriptionCredits || 0) + (wallet.topUpCredits || 0);
}

/** Subscription credits are spent first, then top-ups. Never goes below zero. */
async function deduct(wallet, credits) {
  if (credits <= 0) return wallet;
  const fromSub = Math.min(wallet.subscriptionCredits || 0, credits);
  const fromTop = Math.min(wallet.topUpCredits || 0, credits - fromSub);
  wallet.subscriptionCredits -= fromSub;
  wallet.topUpCredits -= fromTop;
  await wallet.save({ fields: ["subscriptionCredits", "topUpCredits"] });
  return wallet;
}

async function addTopUp(userId, credits) {
  const [wallet] = await IdeWallet.findOrCreate({ where: { userId }, defaults: { plan: "free", subscriptionCredits: 0, topUpCredits: 0, billingPeriodStart: new Date() } });
  await wallet.increment("topUpCredits", { by: credits });
  return wallet.reload();
}

module.exports = { ensureWallet, available, deduct, addTopUp };
