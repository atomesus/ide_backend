const { Op } = require("sequelize");
const { ApiKey, User } = require("../models/sql");
const { kv } = require("../db/redis");
const { generateDeviceKey, hashToken } = require("../lib/tokens");
const { config } = require("../config/env");

const CACHE_TTL = 300;
const cacheKey = (hash) => `apikey:${hash}`;

/** Issues a device key for a user; the plaintext is returned exactly once. */
async function issueDeviceKey(user, { name, platform, userAgent, ip }) {
  const plaintext = generateDeviceKey();
  const expiresAt = new Date(Date.now() + config.DEVICE_KEY_TTL_DAYS * 24 * 60 * 60 * 1000);
  const row = await ApiKey.create({
    userId: user.id,
    keyHash: hashToken(plaintext),
    keyPrefix: plaintext.slice(0, 10),
    kind: "device",
    name: name || "Atomesus IDE",
    platform: platform || null,
    userAgent: userAgent ? String(userAgent).slice(0, 512) : null,
    createdIp: ip || null,
    expiresAt,
  });
  return { plaintext, row, expiresAt };
}

/** Resolves a device key to { user, apiKey } or null. Cached briefly in Redis. */
async function resolveDeviceKey(plaintext, { ip } = {}) {
  const hash = hashToken(plaintext);
  const cached = await kv.getJSON(cacheKey(hash));
  if (cached === false) return null;
  let row;
  if (cached?.id) {
    row = await ApiKey.findByPk(cached.id);
  } else {
    row = await ApiKey.findOne({ where: { keyHash: hash } });
  }
  if (!row || row.revokedAt || row.expiresAt <= new Date()) {
    await kv.setJSON(cacheKey(hash), false, 60);
    return null;
  }
  const user = await User.findByPk(row.userId);
  if (!user) return null;
  await kv.setJSON(cacheKey(hash), { id: row.id }, CACHE_TTL);
  // Throttle lastUsedAt writes to once a minute.
  if (!row.lastUsedAt || Date.now() - new Date(row.lastUsedAt).getTime() > 60_000) {
    row.lastUsedAt = new Date();
    row.lastUsedIp = ip || row.lastUsedIp;
    row.save({ fields: ["lastUsedAt", "lastUsedIp"] }).catch(() => {});
  }
  return { user, apiKey: row };
}

async function revokeKey(row) {
  if (!row.revokedAt) {
    row.revokedAt = new Date();
    await row.save({ fields: ["revokedAt"] });
  }
  await kv.del(cacheKey(row.keyHash));
}

async function revokeByPlaintext(plaintext) {
  const row = await ApiKey.findOne({ where: { keyHash: hashToken(plaintext) } });
  if (row) await revokeKey(row);
  return Boolean(row);
}

async function listKeys(userId) {
  const rows = await ApiKey.findAll({ where: { userId, revokedAt: null, expiresAt: { [Op.gt]: new Date() } }, order: [["createdAt", "DESC"]] });
  return rows.map(publicKey);
}

async function revokeById(userId, id) {
  const row = await ApiKey.findOne({ where: { id, userId } });
  if (!row) return false;
  await revokeKey(row);
  return true;
}

async function revokeAllForUser(userId) {
  const rows = await ApiKey.findAll({ where: { userId, revokedAt: null } });
  for (const row of rows) await revokeKey(row);
  return rows.length;
}

function publicKey(row) {
  return { id: row.id, name: row.name, platform: row.platform, keyPrefix: row.keyPrefix, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt, expiresAt: row.expiresAt };
}

module.exports = { issueDeviceKey, resolveDeviceKey, revokeKey, revokeByPlaintext, listKeys, revokeById, revokeAllForUser, publicKey };
