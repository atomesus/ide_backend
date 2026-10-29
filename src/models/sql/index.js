const User = require("./User");
const ApiKey = require("./ApiKey");
const IdeWallet = require("./IdeWallet");

/** Tables this service creates and migrates. `User` is the platform's and is never synced. */
const IDE_OWNED_MODELS = [ApiKey, IdeWallet];

module.exports = { User, ApiKey, IdeWallet, IDE_OWNED_MODELS };
