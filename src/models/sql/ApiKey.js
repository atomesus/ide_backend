const { DataTypes } = require("sequelize");
const { sequelize } = require("../../db/sql");

/**
 * Device keys (`sk_...`) issued to IDE installs after a desktop sign-in.
 * Only the SHA-256 of the key is stored. Owned by this service (ide_* table
 * inside the platform database); `userId` points at platform `Users.id`.
 */
const ApiKey = sequelize.define(
  "ApiKey",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false },
    keyHash: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    keyPrefix: { type: DataTypes.STRING(12), allowNull: false },
    kind: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "device" },
    name: { type: DataTypes.STRING(120), allowNull: false, defaultValue: "Atomesus IDE" },
    platform: { type: DataTypes.STRING(64), allowNull: true },
    userAgent: { type: DataTypes.STRING(512), allowNull: true },
    createdIp: { type: DataTypes.STRING(64), allowNull: true },
    lastUsedAt: { type: DataTypes.DATE, allowNull: true },
    lastUsedIp: { type: DataTypes.STRING(64), allowNull: true },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    revokedAt: { type: DataTypes.DATE, allowNull: true },
  },
  { tableName: "ide_api_keys", timestamps: true, indexes: [{ fields: ["userId"] }, { fields: ["expiresAt"] }] }
);

module.exports = ApiKey;
