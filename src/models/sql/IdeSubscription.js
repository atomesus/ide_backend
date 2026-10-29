const { DataTypes } = require("sequelize");
const { sequelize } = require("../../db/sql");

/**
 * READ-ONLY view of the platform's `IdeSubscriptions` table (zero_thought_node,
 * src/ideBilling). The platform writes it from Razorpay/Stripe checkouts and
 * webhooks; this service only reads it to decide what an account may use.
 */
const IdeSubscription = sequelize.define(
  "IdeSubscription",
  {
    id: { type: DataTypes.UUID, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false },
    plan: { type: DataTypes.STRING(32), allowNull: false },
    region: { type: DataTypes.STRING(8), allowNull: false },
    provider: { type: DataTypes.STRING(16), allowNull: false },
    status: { type: DataTypes.STRING(16), allowNull: false },
    currency: { type: DataTypes.STRING(8), allowNull: false },
    amount: { type: DataTypes.INTEGER, allowNull: false },
    currentPeriodStart: { type: DataTypes.DATE, allowNull: true },
    currentPeriodEnd: { type: DataTypes.DATE, allowNull: true },
    cancelAtPeriodEnd: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  { tableName: "IdeSubscriptions", timestamps: true }
);

/** Must match the platform's IdeSubscription.ACCESS_STATUSES. */
IdeSubscription.ACCESS_STATUSES = ["active", "pending", "past_due", "cancelled"];

module.exports = IdeSubscription;
