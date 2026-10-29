/**
 * Hosted model gateway: the IDE's `orbit` provider sends OpenAI-style chat
 * completions here with its device key; we forward to the Atomesus upstream
 * (vLLM / OpenAI-compatible, same ATOMESUS_BASE_URL as zero_thought_node),
 * stream the SSE back, and bill credits from the final usage chunk.
 */
const { config } = require("../config/env");
const { HttpError, unavailable, badRequest } = require("../lib/errors");
const usage = require("./usageService");
const logger = require("../lib/logger");

function defaultModels() {
  return [
    {
      id: config.ATOMESUS_MODEL || "ethos-6",
      upstreamModel: config.ATOMESUS_MODEL || "ethos-6",
      contextWindow: config.ATOMESUS_MAX_CONTEXT_TOKENS,
      supportsTools: true,
      supportsReasoning: false,
      inputCreditMultiplier: config.INPUT_CREDIT_MULTIPLIER,
      outputCreditMultiplier: config.OUTPUT_CREDIT_MULTIPLIER,
    },
  ];
}

let cachedModels = null;
function listModels() {
  if (cachedModels) return cachedModels;
  let models = defaultModels();
  if (config.ATOMESUS_MODELS) {
    try {
      const parsed = JSON.parse(config.ATOMESUS_MODELS);
      if (Array.isArray(parsed) && parsed.length) models = parsed.map((m) => ({ ...defaultModels()[0], upstreamModel: m.id, ...m }));
    } catch (err) {
      logger.warn("ATOMESUS_MODELS is not valid JSON; using defaults", { error: err.message });
    }
  }
  cachedModels = models;
  return models;
}

function findModel(id) {
  return listModels().find((m) => m.id === id) || null;
}

/** /api/v1/models response (shape read by electron-main/llmMessage/orbitProviderList.ts). */
function modelsResponse() {
  return {
    object: "list",
    data: listModels().map((m) => ({
      id: m.id,
      object: "model",
      owned_by: "atomesus",
      orbit: { contextWindow: m.contextWindow, supportsTools: m.supportsTools, supportsReasoning: m.supportsReasoning, inputCreditMultiplier: m.inputCreditMultiplier, outputCreditMultiplier: m.outputCreditMultiplier },
    })),
  };
}

function upstreamUrl() {
  const base = config.ATOMESUS_BASE_URL.replace(/\/+$/, "");
  return /\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

/** Pulls the usage object out of an SSE buffer chunk; returns null when absent. */
function extractUsage(line) {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    const json = JSON.parse(payload);
    return json.usage || null;
  } catch {
    return null;
  }
}

/**
 * Proxies one chat request. `req`/`res` are Express objects; the function
 * handles the whole response lifecycle (SSE or JSON).
 */
async function proxyChatCompletion(req, res) {
  if (!config.ATOMESUS_BASE_URL) throw unavailable("Hosted models are not configured on this server.", "gateway_unconfigured");
  const user = req.user;
  const body = req.body || {};
  const model = findModel(body.model);
  if (!model) throw badRequest(`Unknown model "${body.model}". Call /api/v1/models for the list.`, "unknown_model");
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw badRequest("messages is required.", "invalid_request");

  if ((await usage.availableFor(user)) <= 0) {
    throw new HttpError(402, "You are out of credits. Top up or upgrade your plan at atomesus.com.", "insufficient_credits");
  }

  const stream = body.stream !== false;
  const upstreamBody = {
    ...body,
    model: model.upstreamModel || model.id,
    stream,
    ...(stream ? { stream_options: { include_usage: true, ...(body.stream_options || {}) } } : {}),
  };
  delete upstreamBody.user;

  const ac = new AbortController();
  req.on("close", () => ac.abort());
  const startedAt = Date.now();

  let upstream;
  try {
    upstream = await fetch(upstreamUrl(), {
      method: "POST",
      headers: { "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json", ...(config.ATOMESUS_API_KEY ? { authorization: `Bearer ${config.ATOMESUS_API_KEY}` } : {}) },
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.any ? AbortSignal.any([ac.signal, AbortSignal.timeout(config.CHAT_UPSTREAM_TIMEOUT_MS)]) : ac.signal,
    });
  } catch (err) {
    if (ac.signal.aborted) return;
    logger.error("model gateway upstream failed", { error: err.message });
    throw new HttpError(503, "The model service is unavailable. Try again shortly.", "upstream_unavailable");
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    logger.warn("model gateway upstream error", { status: upstream.status, body: text.slice(0, 300) });
    const status = upstream.status === 429 ? 429 : upstream.status >= 500 ? 503 : 502;
    throw new HttpError(status, status === 429 ? "The model service is busy. Try again shortly." : "The model service returned an error.", status === 429 ? "usage_limit_exceeded" : "upstream_error");
  }

  const finish = (usageObj, status) => {
    const u = usageObj || {};
    usage.recordUsage(user, {
      model: model.id,
      modelMeta: model,
      apiKeyId: req.auth?.apiKeyId,
      promptTokens: u.prompt_tokens || 0,
      cachedTokens: u.prompt_tokens_details?.cached_tokens || 0,
      completionTokens: u.completion_tokens || 0,
      status,
      latencyMs: Date.now() - startedAt,
    }).catch(() => {});
  };

  if (!stream) {
    const json = await upstream.json().catch(() => null);
    if (!json) throw new HttpError(502, "Invalid upstream response.", "upstream_error");
    finish(json.usage, "ok");
    return res.json(json);
  }

  res.status(200);
  res.set({ "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  res.flushHeaders();

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastUsage = null;
  let status = "ok";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      res.write(text);
      buffer += text;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        const u = extractUsage(line);
        if (u) lastUsage = u;
      }
    }
  } catch (err) {
    status = ac.signal.aborted ? "aborted" : "error";
    if (!ac.signal.aborted) logger.warn("model gateway stream interrupted", { error: err.message });
  } finally {
    finish(lastUsage, status);
    try { res.end(); } catch { /* ignore */ }
  }
}

module.exports = { listModels, findModel, modelsResponse, proxyChatCompletion, extractUsage, upstreamUrl, _resetForTests: () => { cachedModels = null; } };
