const { mongoose } = require("../../db/mongo");

/** Opaque per-user IDE settings blob (settings sync). */
const UserSettingsSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true },
    settings: { type: mongoose.Schema.Types.Mixed, default: {} },
    version: { type: Number, default: 1 },
    updatedBy: String,
  },
  { timestamps: true, versionKey: false, minimize: false }
);

module.exports = mongoose.models.UserSettings || mongoose.model("UserSettings", UserSettingsSchema, "user_settings");
