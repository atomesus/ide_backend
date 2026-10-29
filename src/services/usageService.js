const { isMongoReady } = require("../db/mongo");
const { UsageEvent } = require("../models/mongo");
const { config } = require("../config/env");
const wallets = require("./walletService");
const { planOf, monthlyCreditsFor, entitlements, CREDITS_PER_RUPEE } = require("./userService");
const logger = require("../lib/logger");

/** Provider cost of one request in USD, from the model's list prices. */
function costUsd({ promptTokens = 0, cachedTokens = 0, completionTokens = 0 }, model) {
  let price = model?.priceUsdPerMTok || { input: 0, cachedInput: 0, output: 0 };
  if (model?.longContext && promptTokens > model.longContext.overInputTokens) price = model.longContext.priceUsdPerMTok;
  const cached = Math.min(cachedTokens, promptTokens);
  const cachedPrice = price.cachedInput ?? price.input;
  return ((promptTokens - cached) * price.input + cached * cachedPrice + completionTokens * price.output) / 1e6;
}

/** Wallet credits (Rs 0.0001 each) for a request, rounded up. */
function creditsFor(tokens, model) {
  return Math.ceil(costUsd(tokens, model) * config.USD_INR_RATE * CREDITS_PER_RUPEE);
}

const rupees = (credits) => (Math.max(0, credits) / CREDITS_PER_RUPEE).toFixed(2);

/** Credits the user can still spend right now. */
async function availableFor(user) {
  return wallets.available(await wallets.ensureWallet(user));
}

async function recordUsage(user, event) {
  const credits = creditsFor(event, event.modelMeta);
  try {
    await wallets.deduct(await wallets.ensureWallet(user), credits);
  } catch (err) {
    logger.error("credit deduction failed", { userId: user.id, error: err.message });
  }
  if (isMongoReady()) {
    UsageEvent.create({
      userId: user.id,
      apiKeyId: event.apiKeyId,
      model: event.model,
      promptTokens: event.promptTokens || 0,
      cachedTokens: event.cachedTokens || 0,
      completionTokens: event.completionTokens || 0,
      creditsDeducted: credits,
      status: event.status || "ok",
      latencyMs: event.latencyMs,
    }).catch((err) => logger.warn("usage event not recorded", { error: err.message }));
  }
  return credits;
}

async function sumCredits(userId, since) {
  if (!isMongoReady()) return null;
  const [row] = await UsageEvent.aggregate([{ $match: { userId, at: { $gte: since } } }, { $group: { _id: null, total: { $sum: "$creditsDeducted" } } }]);
  return row?.total ?? 0;
}

/** GET /api/usage payload in the shape the IDE parses (common/orbitProviderUsage.ts). */
async function usageSummary(user) {
  const wallet = await wallets.ensureWallet(user);
  const periodStart = wallet.billingPeriodStart ? new Date(wallet.billingPeriodStart) : new Date();
  const [period, last30] = await Promise.all([sumCredits(user.id, periodStart), sumCredits(user.id, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))]);
  const plan = planOf(user);
  // Amounts are rupees with two decimals (the IDE shows them with the currency below).
  return {
    currency: "INR",
    wallet: {
      availableCredits: rupees(wallets.available(wallet)),
      subscriptionCredits: rupees(wallet.subscriptionCredits || 0),
      topUpCredits: rupees(wallet.topUpCredits || 0),
    },
    limits: { plan, monthlyCredits: rupees(monthlyCreditsFor(plan)) },
    entitlements: entitlements(user),
    billingPeriod: period == null ? null : { start: periodStart.toISOString(), totalCreditsDeducted: Number(rupees(period)) },
    last30Days: { totalCreditsDeducted: Number(rupees(last30 ?? 0)) },
  };
}

module.exports = { costUsd, creditsFor, availableFor, recordUsage, usageSummary };
