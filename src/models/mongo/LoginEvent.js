const { mongoose } = require("../../db/mongo");

/** One row per platform sign-in (the records the product keeps). */
const LoginEventSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    method: { type: String, required: true, enum: ["password", "otp", "google", "github", "device_key"] },
    client: { type: String, required: true, enum: ["web", "desktop", "api"] },
    outcome: { type: String, required: true, enum: ["success", "failure"], default: "success" },
    ip: String,
    userAgent: String,
    apiKeyId: String,
    at: { type: Date, default: Date.now },
  },
  { versionKey: false }
);
LoginEventSchema.index({ at: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 365 });

module.exports = mongoose.models.LoginEvent || mongoose.model("LoginEvent", LoginEventSchema, "login_events");
