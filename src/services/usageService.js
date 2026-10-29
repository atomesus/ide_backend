const { isMongoReady } = require("../db/mongo");
const { UsageEvent } = require("../models/mongo");
const { config } = require("../config/env");
const wallets = require("./walletService");
const { planOf, monthlyCreditsFor } = require("./userService");
const logger = require("../lib/logger");

/** Credits for a usage record: tokens/1000 * multiplier, rounded up per side. */
function creditsFor({ promptTokens = 0, cachedTokens = 0, completionTokens = 0 }, model) {
  const inMul = model?.inputCreditMultiplier ?? config.INPUT_CREDIT_MULTIPLIER;
  const outMul = model?.outputCreditMultiplier ?? config.OUTPUT_CREDIT_MULTIPLIER;
  const billableInput = Math.max(0, promptTokens - cachedTokens) + cachedTokens * 0.1;
  return Math.ceil((billableInput / 1000) * inMul + (completionTokens / 1000) * outMul);
}

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
  return {
    wallet: {
      availableCredits: String(wallets.available(wallet)),
      subscriptionCredits: String(wallet.subscriptionCredits || 0),
      topUpCredits: String(wallet.topUpCredits || 0),
    },
    limits: { plan, monthlyCredits: String(monthlyCreditsFor(plan)) },
    billingPeriod: period == null ? null : { start: periodStart.toISOString(), totalCreditsDeducted: period },
    last30Days: { totalCreditsDeducted: last30 ?? 0 },
  };
}

module.exports = { creditsFor, availableFor, recordUsage, usageSummary };
