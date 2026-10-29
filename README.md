# Atomesus IDE backend

Device-key and hosted-model backend for the Atomesus IDE (`../atomesus-ide`).
Node 20 · Express 5 · MongoDB · Redis · MySQL/MariaDB.

**Accounts are the Atomesus platform's.** This service does not sign users up or in itself: it
reads the platform's `Users` table (zero_thought_node, same database) and trusts the platform's
session JWT, so an IDE user is exactly a website user. The sign-in page lives on the website
(`atomesis_frontend` `/desktop/login`); this server only hands out the one-time code, the device
key and the hosted-model gateway.

Two kinds of sign-in, deliberately different:

| Sign-in | Where it runs | What is stored |
|---|---|---|
| **Atomesus account** (the website's login: email + password, Google, OTP sign-up) | website → `POST /api/auth/desktop/approve` here | device keys + IDE wallet (`ide_*` SQL tables), login history, IDE settings, usage (Mongo) |
| **Bring your own subscription** (ChatGPT/Codex, Claude, SuperGrok, Cline) | in the IDE against the provider's OAuth; this server only relays the token exchange at `/api/provider-auth/*` | **nothing** — no row, no token, no log line with a secret |

## Run it locally

```bash
nvm use                     # Node 20.18.2 (.nvmrc)
npm install
cp .env.example .env        # then pull the platform's values (DB_*, JWT_SECRET, MONGO_URI, REDIS_*):
npm run env:import -- ../zero_thought_node/.env
npm run env:check           # validates .env, prints what is on/off
npm run dev                 # nodemon on http://localhost:4100
npm test                    # Jest (SQLite in-memory, local Mongo if reachable, no Redis needed)
```

`DB_NAME` must be the platform database (the one with the `Users` table). Outside production the
`ide_api_keys` and `ide_wallets` tables are created on boot; in production run `npm run db:sync`
once (`-- --alter` after model changes). `Users` is never created, altered or written here.

For a fully local stack use a local copy of the platform database and run the platform backend
against it too, e.g. on this Mac (`atomesus_qa_local` has a `Users` table):

```sql
GRANT ALL ON atomesus_qa_local.* TO 'atomesus_ide'@'127.0.0.1';
GRANT ALL ON atomesus_qa_local.* TO 'atomesus_ide'@'localhost';
```

Then `scripts/dev-platform-local.sh` (runs `../zero_thought_node` on :4000 against this `.env`'s database with local Mongo/Redis; its own `.env` is left untouched),
`../atomesis_frontend` on :3000 (`NEXT_PUBLIC_API_ORIGIN=http://localhost:4000`,
`NEXT_PUBLIC_IDE_API_ORIGIN=http://localhost:4100`), this server on :4100
(`WEB_APP_URL=http://localhost:3000`), and a dev IDE with `ORBIT_API_URL=http://localhost:4100`
(or `orbitApiUrl` in `product.json` for a packaged build).

## Environment

Everything is read once by `src/config/env.js` and validated with zod; a bad value fails at
boot. `.env.example` documents each key. Keys marked `[shared]` have the same names **and must
hold the same values** as `zero_thought_node/.env` (`DB_*` including `DB_NAME`, `JWT_SECRET`,
`MONGO_URI`, `REDIS_*`, `ATOMESUS_BASE_URL`…) so `npm run env:import` can copy them. It only
copies allow-listed keys, never prints values, never overwrites a value already set (use
`--overwrite`), and skips `PORT` and `MONGO_DB_NAME` (this service keeps its own Mongo database).

Production hard requirements (`auditConfig`): the platform's `JWT_SECRET`, `MONGO_URI`, SQL
host and `DB_NAME`, `API_PUBLIC_URL` and `WEB_APP_URL` on https. Redis is optional (single-instance
mode falls back to in-process state) but required for PM2 cluster / multi-instance deployments.

## Layout

```
index.js                 boot: env audit → Redis → Mongo + SQL → listen, graceful shutdown
src/app.js               Express app (helmet, CORS, compression, routes, error handler)
src/config/env.js        validated config        src/config/providers.js   provider OAuth registry
src/db/{mongo,sql,redis} connections; sql.js syncs only ide_* tables; redis.js exports `kv`
src/models/sql           User (read-only view of the platform's Users), ApiKey, IdeWallet
src/models/mongo         LoginEvent, UserSettings, UsageEvent (Mongoose)
src/middleware           auth (device key or platform JWT), rate limits, validation, errors
src/services             desktopAuthService, apiKeyService, walletService, usageService,
                         modelGatewayService, providerRelayService, userService
src/routes               health, desktop (302 → website), auth, account, providerAuth, v1
scripts/                 check-env, import-env, sync-sql
__tests__/               Jest + supertest
```

## HTTP API

Response envelope for platform routes: `{ success, code, message, data }`; errors also carry
`error: { code, message }`. Routes the IDE's `orbit` provider consumes use the shapes the IDE
already parses (see `docs/desktop-sign-in.md` and `electron-main/llmMessage/orbitProvider*.ts`
in the IDE repo).

### Desktop sign-in (IDE contract)

```
GET  /desktop/login | /desktop/signup   ?client=desktop&redirect_uri=atomesus://auth-callback?editor_state=…
                                        &code_challenge=…&code_challenge_method=S256
     → 302 to {WEB_APP_URL}/desktop/login|signup with the same query (bad query → …?error=<code>)
POST /api/auth/desktop/approve          Bearer <website auth_token>, body = the same four fields
     → { redirectTo: redirect_uri + &code=…, user }       (called by the website page on "Continue")
POST /api/auth/desktop/deny             body = the same four fields → { redirectTo: …&error=access_denied }
POST /api/auth/desktop/exchange         { code, codeVerifier }
     → { token: "sk_…", session: { expiresAt }, user: { id, email, name, image: null, githubLogin: null, plan } }
DELETE /api/auth/api-keys/current       Bearer sk_… → 204 (IDE sign-out)
```

`redirect_uri` must use a scheme in `DESKTOP_REDIRECT_SCHEMES` (default `atomesus`, `orbit`,
matching `product.json` `urlProtocol`). Codes are single-use, PKCE-bound, 5-minute TTL.
Device keys are `sk_` + 43 chars, stored as SHA-256, 30-day TTL (`DEVICE_KEY_TTL_DAYS`).
`approve` requires the website session (a device key cannot approve further sign-ins).

### Hosted models (IDE `orbit` provider, Bearer `sk_…`)

```
GET  /api/v1/models            { data: [{ id, orbit: { contextWindow, supportsTools, … } }] }
POST /api/v1/chat/completions  OpenAI-style body, SSE passthrough to ATOMESUS_BASE_URL;
                               usage chunk → credits deducted; 402 insufficient_credits,
                               429 usage_limit_exceeded, 503 gateway unconfigured/unavailable
GET  /api/usage                { wallet, limits, billingPeriod, last30Days }
```

Credits: `ceil(input_tokens/1000 × INPUT_CREDIT_MULTIPLIER + output_tokens/1000 × OUTPUT_CREDIT_MULTIPLIER)`,
cached input billed at 10 %. Credits live in `ide_wallets` (one row per platform user, created on first use). The plan comes
from the platform's `planType`: `free` gets `FREE_PLAN_MONTHLY_CREDITS`, any paid plan gets
`PRO_PLAN_MONTHLY_CREDITS`, a lapsed `planExpiryDate` counts as free. Subscription credits refill
every 30 days; top-ups are spent after them.
`ATOMESUS_MODELS` (JSON array) overrides the served list.

### Session (Bearer = website `auth_token` JWT or `sk_…`)

Sign-up, login, Google and password reset are the platform's (`zero_thought_node`
`/api/auth/*`, used by the website). This server only reads the resulting session.

```
GET  /api/auth/me        → { user, auth: { kind: "platform_session" | "device_key" } }
POST /api/auth/logout    revokes the device key when called with one
```

### Account (Bearer JWT or sk_)

```
GET  /api/account/profile             read-only; edit the profile on the platform (PUT /api/updateProfile)
GET  /api/account/devices             DELETE /api/account/devices/:id   POST /api/account/devices/revoke-all
GET  /api/account/login-history?limit=50
GET/PUT /api/account/settings         { settings, version } — optimistic version check (409 on conflict)
DELETE /api/account/ide-data          { confirm: "DELETE" } — revokes keys, drops the wallet, purges Mongo
                                      (the account itself is deleted on the platform)
```

### Provider relay (no auth, no records)

```
GET  /api/provider-auth/providers                  public config per provider (ids, scopes, redirect URIs)
POST /api/provider-auth/:provider/authorize-url    { codeChallenge, state, redirectUri? } → { url }
POST /api/provider-auth/:provider/exchange         { code, codeVerifier, redirectUri?, state? }
                                                   → { accessToken, refreshToken, idToken, expiresAt, ideProvider, raw }
POST /api/provider-auth/:provider/refresh          { refreshToken }
```

Providers: `openai-codex`, `claude`, `xai-grok`, `cline`. Client ids default to the public
PKCE ids the IDE ships; override with `*_CLIENT_ID`. Claude's manual flow returns `code#state`;
the relay splits it. Responses are `Cache-Control: no-store`; the route never touches a DB and
the logger redacts any key that looks like a credential.

### Health

`GET /health` → `{ ok: true }`; with header `X-Health-Token: $HEALTH_TOKEN` it adds store
states, config flags and audit warnings. `GET /health/ready` checks Mongo, SQL (and Redis when
`REDIS_REQUIRED=true`) for load balancers.

## Deploy

`Dockerfile` (node:20-alpine, port 4100) and `ecosystem.config.js` (PM2 cluster, same shape as
zero_thought_node). Behind nginx/ALB set `TRUST_PROXY_HOPS` or leave unset for
`loopback, uniquelocal`. Set `REDIS_REQUIRED=true` whenever more than one instance runs.

## Follow-ups

- IDE top-ups and plan allowances per tier (`go`/`core`/`prime`/`plus`…) are not wired to the
  platform's payments yet; every paid plan gets `PRO_PLAN_MONTHLY_CREDITS`.
- When the platform deletes an account it does not call `DELETE /api/account/ide-data`; wire that
  into zero_thought_node's `accountDeletionService` so device keys die with the account.
- Codex/Grok/Cline token exchanges still go straight to the provider from Electron. Switching
  them to `/api/provider-auth/:provider/exchange` is optional and lets client ids / endpoints
  change without an IDE release.
