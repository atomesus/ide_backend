/**
 * Keeps provider details out of what the IDE (or anyone holding a device key) receives from the
 * hosted-model gateway. Every chunk is rebuilt from an allow-list, so new provider fields never
 * leak by default:
 *
 *  - no token counts (`usage`), fingerprints (`system_fingerprint`, vLLM extras), service tiers,
 *    logprobs or provider response ids; the server still reads `usage` for billing first;
 *  - the response id is ours and the model is the catalog id;
 *  - tool-call ids are encrypted (their format names the vendor, e.g. `toolu_` or `call_`), and
 *    decrypted again when the IDE sends them back, because the provider needs its own ids.
 */
const crypto = require("crypto");
const { config } = require("../config/env");

const TOOL_ID_PREFIX = "call_at";
const DELTA_FIELDS = ["role", "content", "reasoning_content", "reasoning", "refusal"];

let cachedKey = null;
/** AES-256 key for tool-call ids; stable across restarts so a chat survives a deploy. */
function idKey() {
  if (cachedKey) return cachedKey;
  const secret = config.GATEWAY_ID_SECRET || `${config.JWT_SECRET}|${config.DB_PASS}|ide-gateway-tool-ids`;
  cachedKey = crypto.createHash("sha256").update(secret).digest();
  return cachedKey;
}

/** Upstream tool-call id -> opaque id the IDE sees. */
function publicToolCallId(upstreamId) {
  if (typeof upstreamId !== "string" || !upstreamId) return upstreamId;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", idKey(), iv);
  const enc = Buffer.concat([cipher.update(upstreamId, "utf8"), cipher.final()]);
  return TOOL_ID_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64url");
}

/** Opaque id from the IDE -> the provider's own id; anything not ours passes through. */
function upstreamToolCallId(publicId) {
  if (typeof publicId !== "string" || !publicId.startsWith(TOOL_ID_PREFIX)) return publicId;
  try {
    const raw = Buffer.from(publicId.slice(TOOL_ID_PREFIX.length), "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", idKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return publicId;
  }
}

/** Restores provider tool-call ids in the messages the IDE sends back. */
function restoreToolCallIds(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => {
    if (!m || typeof m !== "object") return m;
    const out = { ...m };
    if (typeof out.tool_call_id === "string") out.tool_call_id = upstreamToolCallId(out.tool_call_id);
    if (Array.isArray(out.tool_calls)) out.tool_calls = out.tool_calls.map((c) => (c && typeof c === "object" ? { ...c, id: upstreamToolCallId(c.id) } : c));
    return out;
  });
}

function cleanToolCall(call) {
  if (!call || typeof call !== "object") return null;
  const out = {};
  if (typeof call.index === "number") out.index = call.index;
  if (call.id) out.id = publicToolCallId(call.id);
  if (call.type) out.type = call.type;
  if (call.function && typeof call.function === "object") {
    out.function = {};
    if (typeof call.function.name === "string") out.function.name = call.function.name;
    if (typeof call.function.arguments === "string") out.function.arguments = call.function.arguments;
  }
  return out;
}

function cleanMessage(source) {
  const out = {};
  if (!source || typeof source !== "object") return out;
  for (const field of DELTA_FIELDS) if (source[field] != null) out[field] = source[field];
  if (Array.isArray(source.tool_calls)) out.tool_calls = source.tool_calls.map(cleanToolCall).filter(Boolean);
  return out;
}

/** One sanitizer per request, so every chunk shares the same response id. */
function createSanitizer(model) {
  const id = `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
  const created = Math.floor(Date.now() / 1000);

  /** A streamed chunk; returns null for chunks that only carried usage or provider metadata. */
  function chunk(json) {
    if (!json || typeof json !== "object") return null;
    if (json.error) return { error: { message: "The model service returned an error." } };
    const choices = Array.isArray(json.choices)
      ? json.choices.map((c) => ({ index: typeof c.index === "number" ? c.index : 0, delta: cleanMessage(c.delta), finish_reason: c.finish_reason ?? null }))
      : [];
    if (!choices.length) return null;
    return { id, object: "chat.completion.chunk", created, model: model.id, choices };
  }

  /** A whole (non-streamed) completion. */
  function completion(json) {
    const choices = Array.isArray(json?.choices)
      ? json.choices.map((c) => ({ index: typeof c.index === "number" ? c.index : 0, message: { role: "assistant", content: null, ...cleanMessage(c.message) }, finish_reason: c.finish_reason ?? null }))
      : [];
    return { id, object: "chat.completion", created, model: model.id, choices };
  }

  /** Rewrites one SSE line; returns the text to send ("" to drop the line). */
  function sseLine(rawLine) {
    const line = rawLine.replace(/\r?\n$/, "");
    if (!line.startsWith("data:")) return line.trim() === "" ? rawLine : "";
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") return "data: [DONE]\n";
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      return "";
    }
    const clean = chunk(json);
    return clean ? `data: ${JSON.stringify(clean)}\n` : "";
  }

  return { id, chunk, completion, sseLine };
}

module.exports = { createSanitizer, publicToolCallId, upstreamToolCallId, restoreToolCallIds };
