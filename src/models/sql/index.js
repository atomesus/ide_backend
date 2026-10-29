const User = require("./User");
const ApiKey = require("./ApiKey");
const IdeWallet = require("./IdeWallet");
const IdeSubscription = require("./IdeSubscription");

/** Tables this service creates and migrates. `User` and `IdeSubscription` are the platform's and never synced. */
const IDE_OWNED_MODELS = [ApiKey, IdeWallet];

module.exports = { User, ApiKey, IdeWallet, IdeSubscription, IDE_OWNED_MODELS };
