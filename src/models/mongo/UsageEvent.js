const { mongoose } = require("../../db/mongo");

/** One row per hosted-model request billed to a platform user. */
const UsageEventSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    apiKeyId: String,
    model: { type: String, required: true },
    promptTokens: { type: Number, default: 0 },
    cachedTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    creditsDeducted: { type: Number, default: 0 },
    // ":estimated" = no usage report from the provider; tokens were estimated from the text.
    status: { type: String, enum: ["ok", "error", "aborted", "ok:estimated", "error:estimated", "aborted:estimated"], default: "ok" },
    latencyMs: Number,
    at: { type: Date, default: Date.now, index: true },
  },
  { versionKey: false }
);
UsageEventSchema.index({ userId: 1, at: -1 });

module.exports = mongoose.models.UsageEvent || mongoose.model("UsageEvent", UsageEventSchema, "usage_events");
