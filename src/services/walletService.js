const { Op } = require("sequelize");
const { IdeWallet, IdeTopUp, IdeWalletTopUp } = require("../models/sql");
const { sequelize } = require("../db/sql");
const { planOf, monthlyCreditsFor } = require("./userService");
const logger = require("../lib/logger");

const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Adds every paid platform top-up (IdeTopUps, written by zero_thought_node)
 * that this wallet has not received yet. The ledger row's primary key makes
 * each top-up count once even when two requests race; a lost race is silent.
 * Top-up credits never expire with the billing period.
 */
async function applyPaidTopUps(wallet) {
  const applied = await IdeWalletTopUp.findAll({ where: { userId: wallet.userId }, attributes: ["topUpId"] });
  const seen = applied.map((r) => r.topUpId);
  const pending = await IdeTopUp.findAll({ where: { userId: wallet.userId, status: "paid", ...(seen.length ? { id: { [Op.notIn]: seen } } : {}) } });
  let added = 0;
  for (const topUp of pending) {
    try {
      await sequelize.transaction(async (transaction) => {
        await IdeWalletTopUp.create({ topUpId: topUp.id, userId: wallet.userId, credits: topUp.walletCredits }, { transaction });
        await IdeWallet.increment("topUpCredits", { by: topUp.walletCredits, where: { userId: wallet.userId }, transaction });
      });
      added += topUp.walletCredits;
    } catch (err) {
      if (!/unique|constraint|duplicate/i.test(err.message)) logger.warn("top-up not applied", { topUpId: topUp.id, error: err.message });
    }
  }
  if (added) await wallet.reload();
  return added;
}

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
  await applyPaidTopUps(wallet);
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

module.exports = { ensureWallet, available, deduct, addTopUp, applyPaidTopUps };
