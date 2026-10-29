const express = require("express");
const { z } = require("zod");
const { requireAuth } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const users = require("../services/userService");
const apiKeys = require("../services/apiKeyService");
const { listLogins } = require("../services/loginEventService");
const { isMongoReady } = require("../db/mongo");
const { UserSettings, LoginEvent, UsageEvent } = require("../models/mongo");
const { User } = require("../models/sql");
const { config } = require("../config/env");
const { unavailable } = require("../lib/errors");
const { verifyPassword } = require("../lib/password");
const { unauthorized } = require("../lib/errors");

const router = express.Router();
const ok = (res, data, message = "OK", status = 200) => res.status(status).json({ success: true, code: status, message, data });

router.use(requireAuth(true));

router.get("/profile", async (req, res) => ok(res, { user: users.safeUser(req.user) }));

router.patch("/profile", validate({ body: z.object({ name: z.string().trim().min(1).max(120).optional(), country: z.string().trim().length(2).toUpperCase().optional(), image: z.string().url().max(1024).nullable().optional() }) }), async (req, res) => {
  for (const [k, v] of Object.entries(req.body)) req.user[k] = v;
  await req.user.save();
  ok(res, { user: users.safeUser(req.user) }, "Profile updated");
});

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

// ---- delete account (GDPR-style: SQL soft-delete + purge Mongo records) ---
router.delete("/", validate({ body: z.object({ password: z.string().max(128).optional(), confirm: z.literal("DELETE") }) }), async (req, res) => {
  const user = req.user;
  if (user.passwordHash && !(await verifyPassword(req.body.password || "", user.passwordHash))) throw unauthorized("Password is incorrect.", "invalid_credentials");
  await apiKeys.revokeAllForUser(user.id);
  if (isMongoReady()) {
    await Promise.all([UserSettings.deleteMany({ userId: user.id }), LoginEvent.deleteMany({ userId: user.id }), UsageEvent.deleteMany({ userId: user.id })]);
  }
  // Keep the row (paranoid delete) but scrub identity so the email can be reused.
  const tombstone = `deleted+${user.id}@deleted.invalid`;
  await User.update({ email: tombstone, name: "Deleted user", image: null, passwordHash: null, googleId: null, githubId: null, githubLogin: null }, { where: { id: user.id } });
  await user.destroy();
  res.clearCookie(config.SESSION_COOKIE_NAME, { path: "/" });
  ok(res, null, "Account deleted");
});

module.exports = router;
