/**
 * Provider sign-in registry. These are the subscriptions a user can bring to
 * the IDE (ChatGPT via Codex, Claude, SuperGrok, Cline). The IDE runs the
 * authorization step itself; this server only relays the token exchange and
 * refresh so the IDE never has to embed provider endpoints it cannot update.
 *
 * NOTHING from these flows is persisted: no user row, no token, no log line
 * with a secret. See src/services/providerRelayService.js.
 *
 * Client ids default to the public PKCE client ids the IDE already ships
 * (src/vs/workbench/contrib/orbit/electron-main/{openai-codex,xai-grok,cline-pass}/oauthConfig.ts).
 */
const { config } = require("./env");

const PROVIDERS = {
  "openai-codex": {
    id: "openai-codex",
    label: "ChatGPT (Codex)",
    ideProvider: "openAICodex",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    clientId: config.OPENAI_CODEX_CLIENT_ID || "app_EMoamEEZ73f0CkXaXp7hrann",
    scopes: ["openid", "profile", "email", "offline_access"],
    redirectUris: ["http://localhost:1455/auth/callback"],
    extraAuthorizeParams: { codex_cli_simplified_flow: "true", originator: "roo-code" },
    tokenRequest: "form",
    supportsRefresh: true,
  },
  claude: {
    id: "claude",
    label: "Claude (Pro / Max)",
    ideProvider: "anthropic",
    authorizeUrl: "https://claude.ai/oauth/authorize",
    tokenUrl: "https://console.anthropic.com/v1/oauth/token",
    clientId: config.CLAUDE_OAUTH_CLIENT_ID || "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    scopes: ["org:create_api_key", "user:profile", "user:inference"],
    redirectUris: ["https://console.anthropic.com/oauth/code/callback", "http://localhost:54545/callback"],
    extraAuthorizeParams: { code: "true" },
    tokenRequest: "json",
    // Claude's manual flow hands the user "code#state"; the relay splits it.
    codeMayContainState: true,
    supportsRefresh: true,
  },
  "xai-grok": {
    id: "xai-grok",
    label: "SuperGrok",
    ideProvider: "xAISuperGrok",
    authorizeUrl: "https://auth.x.ai/oauth2/authorize",
    tokenUrl: "https://auth.x.ai/oauth2/token",
    clientId: config.XAI_GROK_CLIENT_ID || "b1a00492-073a-47ea-816f-4c329264a828",
    scopes: ["openid", "profile", "email", "offline_access", "grok-cli:access", "api:access"],
    redirectUris: ["http://127.0.0.1:56121/callback"],
    extraAuthorizeParams: { plan: "generic", referrer: "orbit-editor" },
    tokenRequest: "form",
    supportsRefresh: true,
  },
  cline: {
    id: "cline",
    label: "Cline account",
    ideProvider: "clinePass",
    authorizeUrl: "https://api.cline.bot/api/v1/auth/authorize",
    tokenUrl: "https://api.cline.bot/api/v1/auth/token",
    refreshUrl: "https://api.cline.bot/api/v1/auth/refresh",
    clientId: null,
    scopes: [],
    redirectUris: ["http://127.0.0.1:1488/auth"],
    extraAuthorizeParams: { client_type: "extension" },
    tokenRequest: "cline",
    pkce: false,
    supportsRefresh: true,
  },
};

function getProvider(id) {
  return PROVIDERS[String(id || "").toLowerCase()] || null;
}

/** Public, secret-free view for GET /api/provider-auth/providers. */
function listProviders() {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    ideProvider: p.ideProvider,
    authorizeUrl: p.authorizeUrl,
    clientId: p.clientId,
    scopes: p.scopes,
    redirectUris: p.redirectUris,
    pkce: p.pkce !== false,
    supportsRefresh: Boolean(p.supportsRefresh),
    recordsKept: false,
  }));
}

module.exports = { PROVIDERS, getProvider, listProviders };
