/**
 * Hosted model gateway: the IDE's `orbit` provider sends OpenAI-style chat
 * completions here with its device key. Each model is forwarded to its own
 * provider (our Ethos vLLM, Anthropic or OpenAI, all OpenAI-compatible), the
 * SSE stream is passed back, and the user's rupee wallet is charged at the
 * model's real price from the final usage chunk.
 */
const { config } = require("../config/env");
const { allModels, providers } = require("../config/models");
const { HttpError, unavailable, badRequest } = require("../lib/errors");
const { kv } = require("../db/redis");
const usage = require("./usageService");
const users = require("./userService");
const logger = require("../lib/logger");

/** Models whose provider is configured on this server, in catalog order. */
function listModels() {
  const enabled = providers();
  return allModels().filter((m) => enabled[m.provider]?.enabled);
}

function findModel(id) {
  return listModels().find((m) => m.id === id) || null;
}

/** /api/v1/models response (shape read by electron-main/llmMessage/orbitProviderList.ts). */
function modelsResponse() {
  // The IDE reads these as USD per token (x 1e6 = vendor list price per million tokens).
  const perToken = (usdPerMTok) => usdPerMTok / 1e6;
  return {
    object: "list",
    data: listModels().map((m) => ({
      id: m.id,
      object: "model",
      owned_by: m.provider === "atomesus" ? "atomesus" : m.provider,
      name: m.name,
      orbit: {
        displayName: m.name,
        provider: m.provider,
        contextWindow: m.contextWindow,
        supportsTools: m.supportsTools,
        supportsReasoning: m.supportsReasoning,
        inputCreditMultiplier: perToken(m.priceUsdPerMTok.input),
        outputCreditMultiplier: perToken(m.priceUsdPerMTok.output),
      },
    })),
  };
}

function chatUrl(baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return /\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

function upstreamUrl(provider = "atomesus") {
  return chatUrl(providers()[provider]?.baseUrl);
}

/** Provider-specific request fixes for the OpenAI-style body the IDE sends. */
function adaptBody(model, body, stream) {
  const out = { ...body, model: model.upstreamModel || model.id, stream };
  if (stream) out.stream_options = { ...(body.stream_options || {}), include_usage: true };
  delete out.user;
  if (model.provider === "openai" && out.max_tokens != null && out.max_completion_tokens == null) {
    // GPT-5 family models take max_completion_tokens only.
    out.max_completion_tokens = out.max_tokens;
    delete out.max_tokens;
  }
  if (model.provider === "anthropic" && out.max_tokens == null && out.max_completion_tokens == null) {
    out.max_tokens = 16384;
  }
  return out;
}

/** Rough token count for text we never got a usage report for (about 4 characters per token). */
const roughTokens = (text) => Math.ceil(String(text || "").length / 4);

/** Holds one of the user's in-flight slots for this model; returns a release function or null when full. */
async function acquireSlot(userId, model) {
  const limit = model.maxConcurrentPerUser || config.CHAT_MAX_CONCURRENT_PER_USER;
  if (!limit) return () => {};
  const key = `inflight:${model.provider}:${userId}`;
  const n = await kv.incr(key, 15 * 60);
  if (n > limit) {
    await kv.decr(key);
    return null;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    kv.decr(key).catch(() => {});
  };
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
  const user = req.user;
  const body = req.body || {};
  const ent = users.entitlements(user);
  if (!ent.paid) {
    throw new HttpError(402, "Atomesus models need an IDE plan (Rs 299 / Rs 999, or $4 / $10 outside India). Get one at atomesus.com/ide/pricing.", "plan_required");
  }
  if (!ent.hostedModels) {
    throw new HttpError(402, "Your IDE plan does not include Atomesus models. Use your own API key, or change plan at atomesus.com/ide/pricing.", "plan_required");
  }
  if (listModels().length === 0) throw unavailable("Hosted models are not configured on this server.", "gateway_unconfigured");
  const model = findModel(body.model);
  if (!model) throw badRequest(`Unknown model "${body.model}". Call /api/v1/models for the list.`, "unknown_model");
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw badRequest("messages is required.", "invalid_request");

  const promptText = JSON.stringify(body.messages) + (body.tools ? JSON.stringify(body.tools) : "");
  const estimatedPrompt = roughTokens(promptText);
  const available = await usage.availableFor(user);
  if (available <= 0 || available < usage.creditsFor({ promptTokens: estimatedPrompt }, model)) {
    throw new HttpError(402, "You have used this month's Atomesus model budget. It refills with your next billing period, or use your own API key.", "insufficient_credits");
  }

  const release = await acquireSlot(user.id, model);
  if (!release) {
    throw new HttpError(429, `Too many ${model.name} requests at once. Wait for one to finish or pick another model.`, "too_many_concurrent_requests");
  }
  res.on("close", release);

  const provider = providers()[model.provider];
  const stream = body.stream !== false;
  const upstreamBody = adaptBody(model, body, stream);

  const ac = new AbortController();
  req.on("close", () => ac.abort());
  const startedAt = Date.now();

  let upstream;
  try {
    upstream = await fetch(chatUrl(provider.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json", ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}) },
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.any ? AbortSignal.any([ac.signal, AbortSignal.timeout(config.CHAT_UPSTREAM_TIMEOUT_MS)]) : ac.signal,
    });
  } catch (err) {
    release();
    if (ac.signal.aborted) return;
    logger.error("model gateway upstream failed", { provider: model.provider, error: err.message });
    throw new HttpError(503, `${model.name} is unavailable. Try again shortly or pick another model.`, "upstream_unavailable");
  }

  if (!upstream.ok) {
    release();
    const text = await upstream.text().catch(() => "");
    logger.warn("model gateway upstream error", { provider: model.provider, status: upstream.status, body: text.slice(0, 300) });
    const status = upstream.status === 429 ? 429 : upstream.status >= 500 ? 503 : 502;
    throw new HttpError(status, status === 429 ? "The model service is busy. Try again shortly." : "The model service returned an error.", status === 429 ? "usage_limit_exceeded" : "upstream_error");
  }

  let streamedChars = 0;
  const finish = (usageObj, status) => {
    release();
    // No usage report (aborted or broken stream): bill an estimate so stopping early is not free.
    const u = usageObj || { prompt_tokens: estimatedPrompt, completion_tokens: Math.ceil(streamedChars / 4) };
    usage.recordUsage(user, {
      model: model.id,
      modelMeta: model,
      apiKeyId: req.auth?.apiKeyId,
      promptTokens: u.prompt_tokens || 0,
      cachedTokens: u.prompt_tokens_details?.cached_tokens || 0,
      completionTokens: u.completion_tokens || 0,
      status: usageObj ? status : `${status}:estimated`,
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
      streamedChars += text.length;
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

module.exports = { listModels, findModel, modelsResponse, proxyChatCompletion, extractUsage, upstreamUrl, adaptBody, _resetForTests: () => {} };
