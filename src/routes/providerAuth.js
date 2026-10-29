/**
 * /api/provider-auth — relay for bring-your-own-subscription sign-ins.
 * No authentication required (the IDE may have no Atomesus account at all),
 * no persistence, per-IP rate limit only.
 */
const express = require("express");
const { z } = require("zod");
const { listProviders } = require("../config/providers");
const relay = require("../services/providerRelayService");
const { validate } = require("../middleware/validate");
const { limiters } = require("../middleware/rateLimit");
const { config } = require("../config/env");

const router = express.Router();

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  res.locals.noBodyLog = true;
  next();
});

router.get("/providers", (req, res) => {
  res.json({ enabled: config.PROVIDER_RELAY_ENABLED, recordsKept: false, providers: config.PROVIDER_RELAY_ENABLED ? listProviders() : [] });
});

const providerParam = z.object({ provider: z.string().min(2).max(32) });

router.post("/:provider/authorize-url", limiters.providerRelay, validate({ params: providerParam, body: z.object({ codeChallenge: z.string().min(43).max(128).optional(), state: z.string().min(8).max(256), redirectUri: z.string().url().optional(), nonce: z.string().max(256).optional() }) }), (req, res) => {
  res.json(relay.buildAuthorizeUrl(req.params.provider, req.body));
});

router.post("/:provider/exchange", limiters.providerRelay, validate({ params: providerParam, body: z.object({ code: z.string().min(1).max(4096), codeVerifier: z.string().min(43).max(128).optional(), redirectUri: z.string().url().optional(), state: z.string().max(256).optional() }) }), async (req, res) => {
  res.json(await relay.exchangeCode(req.params.provider, req.body));
});

router.post("/:provider/refresh", limiters.providerRelay, validate({ params: providerParam, body: z.object({ refreshToken: z.string().min(1).max(8192) }) }), async (req, res) => {
  res.json(await relay.refreshToken(req.params.provider, req.body));
});

module.exports = router;
