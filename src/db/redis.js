/**
 * Redis client plus a small key/value facade (`kv`) that falls back to an
 * in-process Map when Redis is not configured or unreachable. Everything that
 * is short-lived state (OTPs, PKCE flows, one-time codes, device-key cache,
 * rate-limit counters) goes through `kv`, so single-instance dev works with
 * nothing running and production shares state across PM2 workers.
 */
const { createClient } = require("redis");
const { config } = require("../config/env");
const logger = require("../lib/logger");

let client = null;
let connectPromise = null;

function resolveRedisUrl() {
  if (config.REDIS_URL) return config.REDIS_URL;
  if (!config.REDIS_HOST) return null;
  const scheme = config.REDIS_TLS ? "rediss" : "redis";
  const user = encodeURIComponent(config.REDIS_USERNAME || "");
  const pass = encodeURIComponent(config.REDIS_PASSWORD || "");
  const auth = user && pass ? `${user}:${pass}@` : pass ? `:${pass}@` : user ? `${user}@` : "";
  return `${scheme}://${auth}${config.REDIS_HOST}:${config.REDIS_PORT}`;
}

const isRedisEnabled = () => Boolean(resolveRedisUrl());
const getRedisClient = () => (client?.isOpen ? client : null);

async function connectRedis() {
  const url = resolveRedisUrl();
  if (!url) {
    logger.info("Redis not configured; using in-memory state (single-instance mode)");
    return null;
  }
  if (client?.isOpen) return client;
  if (connectPromise) return connectPromise;
  connectPromise = (async () => {
    const c = createClient({
      url,
      socket: { ...(config.REDIS_TLS ? { tls: true, rejectUnauthorized: true } : {}), connectTimeout: 5000, reconnectStrategy: (n) => Math.min(n * 200, 5000) },
    });
    c.on("error", (err) => logger.error("Redis client error", { error: err.message }));
    await c.connect();
    client = c;
    logger.info("Redis connected");
    return c;
  })();
  try {
    return await connectPromise;
  } catch (err) {
    connectPromise = null;
    client = null;
    if (config.REDIS_REQUIRED) throw err;
    logger.warn("Redis unavailable; using in-memory state", { error: err.message });
    return null;
  }
}

async function disconnectRedis() {
  if (client?.isOpen) await client.quit();
  client = null;
  connectPromise = null;
}

// ---- in-memory fallback -------------------------------------------------
const memory = new Map();
function memGet(key) {
  const entry = memory.get(key);
  if (!entry) return null;
  if (entry.expiresAt && entry.expiresAt <= Date.now()) {
    memory.delete(key);
    return null;
  }
  return entry.value;
}
function memSet(key, value, ttlSec) {
  memory.set(key, { value, expiresAt: ttlSec ? Date.now() + ttlSec * 1000 : 0 });
  if (memory.size > 50000) {
    // crude sweep so a flood cannot grow the map without bound
    for (const [k, v] of memory) if (v.expiresAt && v.expiresAt <= Date.now()) memory.delete(k);
  }
}

const prefix = (key) => `${config.REDIS_KEY_PREFIX}${key}`;

const kv = {
  async get(key) {
    const r = getRedisClient();
    if (r) return r.get(prefix(key));
    return memGet(key);
  },
  async getJSON(key) {
    const raw = await kv.get(key);
    if (raw == null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },
  async set(key, value, ttlSec) {
    const r = getRedisClient();
    if (r) return r.set(prefix(key), value, ttlSec ? { EX: ttlSec } : undefined);
    memSet(key, value, ttlSec);
    return "OK";
  },
  async setJSON(key, value, ttlSec) {
    return kv.set(key, JSON.stringify(value), ttlSec);
  },
  async del(key) {
    const r = getRedisClient();
    if (r) return r.del(prefix(key));
    return memory.delete(key) ? 1 : 0;
  },
  /** Atomic read-and-delete, used for one-time codes. */
  async take(key) {
    const r = getRedisClient();
    if (r) return r.getDel(prefix(key));
    const v = memGet(key);
    memory.delete(key);
    return v;
  },
  async incr(key, ttlSec) {
    const r = getRedisClient();
    if (r) {
      const n = await r.incr(prefix(key));
      if (n === 1 && ttlSec) await r.expire(prefix(key), ttlSec);
      return n;
    }
    const n = (Number(memGet(key)) || 0) + 1;
    memSet(key, String(n), n === 1 ? ttlSec : undefined);
    if (n > 1) {
      const entry = memory.get(key);
      memory.set(key, { value: String(n), expiresAt: entry?.expiresAt || 0 });
    }
    return n;
  },
  _memory: memory,
};

module.exports = { connectRedis, disconnectRedis, getRedisClient, isRedisEnabled, resolveRedisUrl, kv };
