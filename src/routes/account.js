const express = require("express");
const { z } = require("zod");
const { requireAuth } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const users = require("../services/userService");
const apiKeys = require("../services/apiKeyService");
const { listLogins } = require("../services/loginEventService");
const { isMongoReady } = require("../db/mongo");
const { UserSettings, LoginEvent, UsageEvent } = require("../models/mongo");
const { IdeWallet, IdeWalletTopUp } = require("../models/sql");
const { unavailable } = require("../lib/errors");

const router = express.Router();
const ok = (res, data, message = "OK", status = 200) => res.status(status).json({ success: true, code: status, message, data });

router.use(requireAuth(true));

// Profile is owned by the platform (PUT /api/updateProfile there); read-only here.
router.get("/profile", async (req, res) => ok(res, { user: users.safeUser(req.user) }));

// ---- devices (IDE installs = device keys) ---------------------------------
router.get("/devices", async (req, res) => ok(res, { devices: await apiKeys.listKeys(req.user.id), currentApiKeyId: req.auth.apiKeyId || null }));

router.delete("/devices/:id", validate({ params: z.object({ id: z.string().uuid() }) }), async (req, res) => {
  const removed = await apiKeys.revokeById(req.user.id, req.params.id);
  ok(res, { removed }, removed ? "Device signed out" : "Device not found");
});

router.post("/devices/revoke-all", async (req, res) => ok(res, { revoked: await apiKeys.revokeAllForUser(req.user.id) }, "All devices signed out"));

// ---- login history --------------------------------------------------------
router.get("/login-history", validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) }), async (req, res) => {
  ok(res, { events: await listLogins(req.user.id, req.validatedQuery.limit) });
});

// ---- IDE settings sync (opaque blob, last-writer-wins with version check) --
const settingsBody = z.object({ settings: z.record(z.any()), version: z.number().int().min(0).optional() });

router.get("/settings", async (req, res) => {
  if (!isMongoReady()) throw unavailable("Settings storage is unavailable.", "mongo_unavailable");
  const doc = await UserSettings.findOne({ userId: req.user.id }).lean();
  ok(res, { settings: doc?.settings ?? {}, version: doc?.version ?? 0, updatedAt: doc?.updatedAt ?? null });
});

router.put("/settings", express.json({ limit: "1mb" }), validate({ body: settingsBody }), async (req, res) => {
  if (!isMongoReady()) throw unavailable("Settings storage is unavailable.", "mongo_unavailable");
  const existing = await UserSettings.findOne({ userId: req.user.id });
  if (existing && req.body.version != null && req.body.version !== existing.version) {
    return res.status(409).json({ success: false, code: 409, message: "Settings changed elsewhere. Reload and retry.", error: { code: "version_conflict", message: "Settings changed elsewhere." }, data: { version: existing.version } });
  }
  const doc = await UserSettings.findOneAndUpdate(
    { userId: req.user.id },
    { $set: { settings: req.body.settings, updatedBy: req.auth.apiKeyId || "web" }, $inc: { version: 1 } },
    { upsert: true, new: true }
  ).lean();
  ok(res, { version: doc.version, updatedAt: doc.updatedAt }, "Settings saved");
});

// ---- purge everything the IDE keeps about this account --------------------
// The account itself is deleted on the platform (POST /api/auth/delete-account there).
router.delete("/ide-data", validate({ body: z.object({ confirm: z.literal("DELETE") }) }), async (req, res) => {
  const userId = req.user.id;
  await apiKeys.revokeAllForUser(userId);
  await IdeWallet.destroy({ where: { userId } });
  await IdeWalletTopUp.destroy({ where: { userId } });
  if (isMongoReady()) {
    await Promise.all([UserSettings.deleteMany({ userId }), LoginEvent.deleteMany({ userId }), UsageEvent.deleteMany({ userId })]);
  }
  ok(res, null, "IDE data deleted");
});

module.exports = router;
