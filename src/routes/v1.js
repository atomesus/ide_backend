/** Endpoints the IDE's `orbit` provider calls with its device key. */
const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { limiters } = require("../middleware/rateLimit");
const gateway = require("../services/modelGatewayService");
const usage = require("../services/usageService");

const router = express.Router();

router.get("/v1/models", requireAuth(true), (req, res) => res.json(gateway.modelsResponse()));

router.post("/v1/chat/completions", requireAuth(true), limiters.chat, express.json({ limit: "20mb" }), async (req, res) => {
  await gateway.proxyChatCompletion(req, res);
});

router.get("/usage", requireAuth(true), async (req, res) => res.json(await usage.usageSummary(req.user, req)));

module.exports = router;
