/**
 * Hosted model gateway: the IDE's `orbit` provider sends OpenAI-style chat
 * completions here with its device key. Each model is forwarded to its own
 * provider (our Ethos vLLM, Anthropic or OpenAI, all OpenAI-compatible), the
 * SSE stream is passed back, and the user's rupee wallet is charged at the
 * upstream model's real price from the final usage chunk.
 *
 * Models are listed under their catalog name (src/config/models.js); the
 * upstream model id is used only on the provider request and is rewritten back
 * to the catalog id in whatever the provider returns.
 */
const { config } = require("../config/env");
const { allModels, providers } = require("../config/models");
const { HttpError, unavailable, badRequest } = require("../lib/errors");
const { kv } = require("../db/redis");
const usage = require("./usageService");
const users = require("./userService");
const logger = require("../lib/logger");
const { createSanitizer, restoreToolCallIds } = require("./responseSanitizer");
const { regionFor, planPricesText } = require("../lib/region");

/** Models whose provider is configured on this server, in catalog order. */
function listModels() {
  const enabled = providers();
  return allModels().filter((m) => enabled[m.provider]?.enabled);
}

function findModel(id) {
  return listModels().find((m) => m.id === id) || null;
}

/**
 * /api/v1/models response (shape read by electron-main/llmMessage/orbitProviderList.ts).
 * Only the catalog id and name are sent; `upstreamModel` stays on this server.
 */
function modelsResponse() {
  // Names and capabilities only: no provider, prices or token sizes (see responseSanitizer.js).
  return {
    object: "list",
    data: listModels().map((m) => ({
      id: m.id,
      object: "model",
      owned_by: "atomesus",
      name: m.name,
      orbit: {
        displayName: m.name,
        supportsTools: m.supportsTools,
        supportsReasoning: m.supportsReasoning,
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
  if (Array.isArray(out.messages)) out.messages = restoreToolCallIds(out.messages);
  if (stream) out.stream_options = { ...(body.stream_options || {}), include_usage: true };
  delete out.user;
  if (model.provider === "openai" && out.max_tokens != null && out.max_completion_tokens == null) {
    // GPT-5 family models take max_completion_tokens only.
    out.max_completion_tokens = out.max_tokens;
    delete out.max_tokens;
  }
  if (model.provider === "openai" && Array.isArray(out.tools) && out.tools.length) {
    // OpenAI rejects function tools on /v1/chat/completions unless reasoning_effort is
    // explicitly "none" (the model's default reasoning counts too); the IDE sends tools in Agent mode.
    out.reasoning_effort = "none";
  }
  if (model.provider === "anthropic" && out.max_tokens == null && out.max_completion_tokens == null) {
    out.max_tokens = 16384;
  }
  if (model.provider === "atomesus") {
    // The Ethos gateway caps a reply at 1024 tokens unless the request names max_tokens (the IDE
    // sends max_completion_tokens); vLLM accepts both, so make the limit explicit.
    if (out.max_tokens == null) out.max_tokens = out.max_completion_tokens ?? config.ATOMESUS_MAX_OUTPUT_TOKENS;
    delete out.max_completion_tokens;
  }
  return out;
}

/** Replaces the provider's model id with the catalog id in a response line or body. */
function publicizeModel(model, text) {
  if (!model.upstreamModel || model.upstreamModel === model.id) return text;
  return String(text).split(JSON.stringify(model.upstreamModel)).join(JSON.stringify(model.id));
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
    throw new HttpError(402, `Atomesus models need an IDE plan (${planPricesText(regionFor(req, user))}). Get one at atomesus.com/code.`, "plan_required");
  }
  if (!ent.hostedModels) {
    throw new HttpError(402, "Your IDE plan does not include Atomesus models. Use your own API key, or change plan at atomesus.com/code.", "plan_required");
  }
  if (listModels().length === 0) throw unavailable("Hosted models are not configured on this server.", "gateway_unconfigured");
  const model = findModel(body.model);
  if (!model) throw badRequest(`Unknown model "${body.model}". Call /api/v1/models for the list.`, "unknown_model");
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw badRequest("messages is required.", "invalid_request");

  const promptText = JSON.stringify(body.messages) + (body.tools ? JSON.stringify(body.tools) : "");
  const estimatedPrompt = roughTokens(promptText);
  const available = await usage.availableFor(user);
  if (available <= 0 || available < usage.creditsFor({ promptTokens: estimatedPrompt }, model)) {
    throw new HttpError(402, "You have used this month's Atomesus model budget. Top up at atomesus.com/code#topup, use your own API key, or wait for your next billing period.", "insufficient_credits");
  }

  const release = await acquireSlot(user.id, model);
  if (!release) {
    throw new HttpError(429, `Too many ${model.name} requests at once. Wait for one to finish or pick another model.`, "too_many_concurrent_requests");
  }
  res.on("close", release);

  const provider = providers()[model.provider];
  const stream = body.stream !== false;
  const upstreamBody = adaptBody(model, body, stream);

  // ac: the IDE went away (client abort). limit: our own time limits. Time limits must not cut a
  // healthy reply short: CHAT_UPSTREAM_TIMEOUT_MS covers only the wait for the reply to start;
  // once it streams, it is stopped only after CHAT_STREAM_IDLE_MS of silence or CHAT_STREAM_MAX_MS
  // in total (Ethos streams about 22 tokens a second, so a long file takes minutes).
  const ac = new AbortController();
  req.on("close", () => ac.abort());
  const limit = new AbortController();
  let limitReason = null;
  const stopFor = (reason) => { if (!limitReason) { limitReason = reason; limit.abort(); } };
  const startedAt = Date.now();
  const firstByteTimer = setTimeout(() => stopFor("first_byte"), config.CHAT_UPSTREAM_TIMEOUT_MS);
  const totalTimer = setTimeout(() => stopFor("total"), config.CHAT_STREAM_MAX_MS);
  const clearLimits = () => { clearTimeout(firstByteTimer); clearTimeout(totalTimer); };
  res.on("close", clearLimits);

  let upstream;
  try {
    upstream = await fetch(chatUrl(provider.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json", ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}) },
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.any([ac.signal, limit.signal]),
    });
  } catch (err) {
    release();
    clearLimits();
    if (ac.signal.aborted) return;
    logger.error("model gateway upstream failed", { provider: model.provider, error: err.message });
    throw new HttpError(503, `${model.name} is unavailable. Try again shortly or pick another model.`, "upstream_unavailable");
  }

  clearTimeout(firstByteTimer);
  if (!upstream.ok) {
    release();
    clearLimits();
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
    clearLimits();
    if (!json) {
      release();
      throw new HttpError(502, "Invalid upstream response.", "upstream_error");
    }
    finish(json.usage, "ok");
    return res.json(createSanitizer(model).completion(json));
  }

  res.status(200);
  res.set({ "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  res.flushHeaders();

  const sanitizer = createSanitizer(model);
  let idleTimer = null;
  const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => stopFor("idle"), config.CHAT_STREAM_IDLE_MS); };
  resetIdle();
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastUsage = null;
  let status = "ok";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      resetIdle();
      const text = decoder.decode(value, { stream: true });
      streamedChars += text.length;
      buffer += text;
      // Forward whole lines so the model id can be rewritten even when a chunk splits a line.
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const rawLine = buffer.slice(0, idx + 1);
        buffer = buffer.slice(idx + 1);
        const u = extractUsage(rawLine.trim());
        if (u) lastUsage = u;
        const out = sanitizer.sseLine(rawLine);
        if (out) res.write(out);
      }
    }
    if (buffer) {
      const u = extractUsage(buffer.trim());
      if (u) lastUsage = u;
      const out = sanitizer.sseLine(buffer);
      if (out) res.write(out);
    }
  } catch (err) {
    status = ac.signal.aborted ? "aborted" : limitReason ? `timeout_${limitReason}` : "error";
    if (!ac.signal.aborted) {
      logger.warn("model gateway stream interrupted", { provider: model.provider, reason: limitReason || err.message, ms: Date.now() - startedAt });
      // Tell the IDE instead of ending silently, so a half-written tool call is not mistaken for
      // the model running out of room.
      const message = limitReason === "idle" ? `${model.name} stopped responding. Try again.` : `${model.name}'s reply was interrupted. Try again.`;
      try { res.write(`data: ${JSON.stringify({ error: { message } })}\n\n`); } catch { /* client gone */ }
    }
  } finally {
    clearTimeout(idleTimer);
    clearLimits();
    finish(lastUsage, status);
    try { res.end(); } catch { /* ignore */ }
  }
}

module.exports = { listModels, findModel, modelsResponse, proxyChatCompletion, extractUsage, upstreamUrl, adaptBody, publicizeModel, _resetForTests: () => {} };
