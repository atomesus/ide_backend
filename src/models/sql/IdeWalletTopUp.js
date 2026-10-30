const { DataTypes } = require("sequelize");
const { sequelize } = require("../../db/sql");

/**
 * Ledger of platform top-ups already added to a wallet (one row per IdeTopUps
 * id). The primary key is what makes applying a top-up idempotent across
 * processes: the second insert fails and the credits are not added twice.
 */
const IdeWalletTopUp = sequelize.define(
  "IdeWalletTopUp",
  {
    topUpId: { type: DataTypes.UUID, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false },
    credits: { type: DataTypes.INTEGER, allowNull: false },
    appliedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "ide_wallet_topups", timestamps: false, indexes: [{ fields: ["userId"] }] }
);

module.exports = IdeWalletTopUp;
