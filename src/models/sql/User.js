const { DataTypes } = require("sequelize");
const { sequelize } = require("../../db/sql");

/**
 * READ-ONLY view of the Atomesus platform's `Users` table (zero_thought_node,
 * src/models/User.js). Accounts are created and changed by the platform only;
 * this service never writes this table and never syncs it (see db/sql.js).
 *
 * Only the columns the IDE needs are declared, so Sequelize selects just those.
 * Provider sign-ins (ChatGPT, Claude, ...) never touch this table.
 */
const User = sequelize.define(
  "User",
  {
    id: { type: DataTypes.UUID, primaryKey: true },
    name: { type: DataTypes.STRING, allowNull: false, defaultValue: "" },
    email: { type: DataTypes.STRING, allowNull: false },
    emailVerifiedAt: { type: DataTypes.DATE, allowNull: true },
    country: { type: DataTypes.STRING, allowNull: true },
    planId: { type: DataTypes.STRING, allowNull: true },
    planType: { type: DataTypes.STRING, allowNull: true, defaultValue: "free" },
    subscriptionStatus: { type: DataTypes.STRING, allowNull: true },
    planExpiryDate: { type: DataTypes.DATE, allowNull: true },
    lastPaymentDate: { type: DataTypes.DATE, allowNull: true },
  },
  { tableName: "Users", timestamps: true }
);

module.exports = User;
