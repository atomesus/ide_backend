const { isMongoReady } = require("../db/mongo");
const { UsageEvent } = require("../models/mongo");
const { config } = require("../config/env");
const wallets = require("./walletService");
const { planOf, monthlyCreditsFor, entitlements, CREDITS_PER_RUPEE } = require("./userService");
const logger = require("../lib/logger");
const { regionFor, currencyFor } = require("../lib/region");

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

/** Below this share of the budget left, the IDE warns that it is running out. */
const LOW_PERCENT = 10;
const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * GET /api/usage payload (parsed by the IDE's common/orbitProviderUsage.ts). It says only how much
 * of the allowance is left, as a percentage, and when it refills: no rupee amounts, credits or
 * tokens, so nobody can work out what a request costs or which provider served it.
 *
 * Remaining = everything spendable / (this period's plan allowance + unspent top-ups). It only
 * falls while models are used, rises after a top-up, and is 0 exactly when requests are refused.
 */
async function usageSummary(user, req) {
  const wallet = await wallets.ensureWallet(user);
  const plan = planOf(user);
  const ent = entitlements(user);
  const monthly = monthlyCreditsFor(plan);
  const sub = Math.max(0, wallet.subscriptionCredits || 0);
  const top = Math.max(0, wallet.topUpCredits || 0);
  const total = monthly + top;
  const left = sub + top;
  let remainingPercent = total > 0 ? Math.floor((left / total) * 100) : 0;
  if (left > 0 && remainingPercent === 0) remainingPercent = 1;
  const status = !ent.hostedModels ? "none" : left <= 0 ? "exhausted" : remainingPercent <= LOW_PERCENT ? "low" : "ok";
  const periodStart = wallet.billingPeriodStart ? new Date(wallet.billingPeriodStart) : new Date();
  // Which currency the IDE shows prices in (plans, Add credits): rupees in India, dollars elsewhere.
  const region = regionFor(req, user);
  return {
    plan,
    region,
    currency: currencyFor(region),
    entitlements: ent,
    limits: {
      plan,
      remainingPercent: ent.hostedModels ? remainingPercent : 0,
      status,
      resetsAt: new Date(periodStart.getTime() + PERIOD_MS).toISOString(),
      hasTopUp: top > 0,
    },
    topUpUrl: "https://www.atomesus.com/code#topup",
  };
}

module.exports = { costUsd, creditsFor, availableFor, recordUsage, usageSummary };
