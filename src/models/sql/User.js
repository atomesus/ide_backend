const { DataTypes } = require("sequelize");
const { sequelize } = require("../../db/sql");

/**
 * Platform account. Only users who sign in through Atomesus (email, Google,
 * GitHub) get a row here. Provider sign-ins (ChatGPT, Claude, ...) never do.
 */
const User = sequelize.define(
  "User",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    email: { type: DataTypes.STRING(254), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(120), allowNull: false, defaultValue: "" },
    image: { type: DataTypes.STRING(1024), allowNull: true },
    role: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "user" },
    passwordHash: { type: DataTypes.STRING(255), allowNull: true },
    googleId: { type: DataTypes.STRING(64), allowNull: true, unique: true },
    githubId: { type: DataTypes.STRING(64), allowNull: true, unique: true },
    githubLogin: { type: DataTypes.STRING(64), allowNull: true },
    emailVerifiedAt: { type: DataTypes.DATE, allowNull: true },
    lastLoginAt: { type: DataTypes.DATE, allowNull: true },
    country: { type: DataTypes.STRING(2), allowNull: true },

    // Plan & wallet (credits are integers; 1 credit = 1k tokens * multiplier)
    plan: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "free" },
    subscriptionStatus: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "inactive" },
    subscriptionId: { type: DataTypes.STRING(128), allowNull: true },
    planExpiresAt: { type: DataTypes.DATE, allowNull: true },
    subscriptionCredits: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    topUpCredits: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    billingPeriodStart: { type: DataTypes.DATE, allowNull: true },

    deletedAt: { type: DataTypes.DATE, allowNull: true },
  },
  { tableName: "users", timestamps: true, paranoid: true, indexes: [{ fields: ["email"] }, { fields: ["plan"] }] }
);

module.exports = User;
