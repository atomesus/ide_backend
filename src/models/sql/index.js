const User = require("./User");
const ApiKey = require("./ApiKey");
const IdeWallet = require("./IdeWallet");
const IdeSubscription = require("./IdeSubscription");
const IdeTopUp = require("./IdeTopUp");
const IdeWalletTopUp = require("./IdeWalletTopUp");

/** Tables this service creates and migrates. `User`, `IdeSubscription` and `IdeTopUp` are the platform's and never synced. */
const IDE_OWNED_MODELS = [ApiKey, IdeWallet, IdeWalletTopUp];
/** Platform tables read here (tests create them in SQLite). */
const PLATFORM_MODELS = [User, IdeSubscription, IdeTopUp];

module.exports = { User, ApiKey, IdeWallet, IdeSubscription, IdeTopUp, IdeWalletTopUp, IDE_OWNED_MODELS, PLATFORM_MODELS };
