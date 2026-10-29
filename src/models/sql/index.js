const User = require("./User");
const ApiKey = require("./ApiKey");

User.hasMany(ApiKey, { foreignKey: "userId", as: "apiKeys", onDelete: "CASCADE" });
ApiKey.belongsTo(User, { foreignKey: "userId", as: "user" });

module.exports = { User, ApiKey };
