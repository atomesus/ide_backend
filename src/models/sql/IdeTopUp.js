const { DataTypes } = require("sequelize");
const { sequelize } = require("../../db/sql");

/**
 * READ-ONLY view of the platform's `IdeTopUps` table (zero_thought_node,
 * src/ideBilling). The platform writes a row per wallet top-up checkout and
 * flips it to `paid` from the payment verification or webhook; this service
 * adds `walletCredits` of each paid row to the user's wallet once.
 */
const IdeTopUp = sequelize.define(
  "IdeTopUp",
  {
    id: { type: DataTypes.UUID, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false },
    provider: { type: DataTypes.STRING(16), allowNull: false },
    currency: { type: DataTypes.STRING(8), allowNull: false },
    amountMinor: { type: DataTypes.INTEGER, allowNull: false },
    walletCredits: { type: DataTypes.INTEGER, allowNull: false },
    status: { type: DataTypes.STRING(16), allowNull: false },
    paidAt: { type: DataTypes.DATE, allowNull: true },
  },
  { tableName: "IdeTopUps", timestamps: true }
);

module.exports = IdeTopUp;
