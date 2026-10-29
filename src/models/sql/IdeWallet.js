const { DataTypes } = require("sequelize");
const { sequelize } = require("../../db/sql");

/**
 * IDE credit wallet, one row per platform user, created on first use.
 * The platform's own consumer quota (token windows on `Users`) is separate;
 * this wallet only meters the IDE's hosted-model gateway.
 * 1 credit = 1000 tokens x multiplier (see usageService).
 */
const IdeWallet = sequelize.define(
  "IdeWallet",
  {
    userId: { type: DataTypes.UUID, primaryKey: true },
    plan: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "free" },
    subscriptionCredits: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    topUpCredits: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    billingPeriodStart: { type: DataTypes.DATE, allowNull: true },
  },
  { tableName: "ide_wallets", timestamps: true }
);

module.exports = IdeWallet;
