/**
 * Hosted models the IDE can pick from. Paid IDE plans get exactly this list;
 * free accounts get none (modelGatewayService answers 402 plan_required).
 *
 * Each entry has two names:
 *   id / name       what the IDE lists and shows (public catalog name)
 *   upstreamModel   the model id actually sent to the provider
 * Only the public name leaves this server: /api/v1/models never includes
 * upstreamModel, and usage events are recorded under the public id.
 *
 * Prices are the providers' list prices for the UPSTREAM model in USD per
 * million tokens (Anthropic and OpenAI pricing pages). They decide what a
 * request costs the user's wallet, so keep them current. Override or add
 * entries with IDE_MODELS (JSON array, matched by id; `upstreamModel`,
 * `name`, `provider`, prices and `disabled: true` are all accepted).
 */
const { config } = require("./env");
const logger = require("../lib/logger");

function catalog() {
  return [
    {
      id: config.ATOMESUS_MODEL || "ethos-6",
      name: "Ethos 6",
      provider: "atomesus",
      upstreamModel: config.ATOMESUS_MODEL || "ethos-6",
      contextWindow: config.ATOMESUS_MAX_CONTEXT_TOKENS,
      supportsTools: true,
      supportsReasoning: false,
      // Runs on our own GPUs (self-hosted vLLM; served once ATOMESUS_BASE_URL is set). Priced
      // like Haiku so heavy use still counts against the plan budget and one user cannot hold
      // the GPUs; set to 0 to make it free on paid plans.
      priceUsdPerMTok: { input: 0.1, cachedInput: 0.01, output: 0.5 },
      maxConcurrentPerUser: config.ETHOS_MAX_CONCURRENT_PER_USER,
    },
    {
      id: "opus-5.5",
      name: "Opus 5.5",
      provider: "anthropic",
      upstreamModel: "claude-haiku-5-5",
      // Anthropic charges 5x above 100k input tokens; capping the window keeps every
      // request on the cheap tier (the IDE trims history to the window).
      contextWindow: 100000,
      supportsTools: true,
      supportsReasoning: false,
      priceUsdPerMTok: { input: 0.1, cachedInput: 0.01, output: 0.5 },
      longContext: { overInputTokens: 100000, priceUsdPerMTok: { input: 0.5, cachedInput: 0.05, output: 2.5 } },
    },
    {
      id: "gpt-6.1-sol",
      name: "GPT-6.1 Sol",
      provider: "openai",
      upstreamModel: "gpt-6-luna",
      // GPT-6 Luna: 1M-token window; list price taken as $0.20 / $1.00 per MTok (gateways quote
      // $0.10-$0.20 in, $0.50-$1.00 out) - the higher figure so the wallet never under-charges.
      contextWindow: 1000000,
      supportsTools: true,
      supportsReasoning: true,
      priceUsdPerMTok: { input: 0.2, cachedInput: 0.02, output: 1 },
    },
  ];
}

/** Where each provider lives and how to authenticate; a provider without credentials is hidden. */
function providers() {
  return {
    atomesus: { baseUrl: config.ATOMESUS_BASE_URL, apiKey: config.ATOMESUS_API_KEY, enabled: Boolean(config.ATOMESUS_BASE_URL) },
    anthropic: { baseUrl: config.ANTHROPIC_BASE_URL, apiKey: config.CLAUDE_API_KEY, enabled: Boolean(config.CLAUDE_API_KEY) },
    openai: { baseUrl: config.OPENAI_BASE_URL, apiKey: config.OPENAI_API_KEY, enabled: Boolean(config.OPENAI_API_KEY) },
  };
}

function overrides() {
  const raw = config.IDE_MODELS || config.ATOMESUS_MODELS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((m) => m && typeof m.id === "string") : [];
  } catch (err) {
    logger.warn("IDE_MODELS is not valid JSON; using the built-in catalog", { error: err.message });
    return [];
  }
}

/** The catalog with IDE_MODELS applied; entries without a provider or price are dropped. */
function allModels() {
  const byId = new Map(catalog().map((m) => [m.id, m]));
  for (const o of overrides()) byId.set(o.id, { ...(byId.get(o.id) || { provider: "atomesus", supportsTools: true, supportsReasoning: false, contextWindow: 128000 }), ...o });
  const out = [];
  for (const m of byId.values()) {
    if (m.disabled) continue;
    const p = m.priceUsdPerMTok;
    if (!p || !(p.input >= 0) || !(p.output >= 0)) {
      logger.warn("model has no price; not served", { id: m.id });
      continue;
    }
    out.push({ ...m, name: m.name || m.id, upstreamModel: m.upstreamModel || m.id });
  }
  return out;
}

module.exports = { catalog, providers, allModels };
