# Atomesus IDE backend

Account, device-key and hosted-model backend for the Atomesus IDE
(`../atomesus-ide`). Node 20 · Express 5 · MongoDB · Redis · MySQL/MariaDB.

Two kinds of sign-in, deliberately different:

| Sign-in | Where it runs | What is stored |
|---|---|---|
| **Atomesus account** (email + OTP, password, GitHub, Google) | here, via `/desktop/*` pages and `/api/auth/*` | user row (SQL), device keys (SQL), login history, IDE settings, usage (Mongo) |
| **Bring your own subscription** (ChatGPT/Codex, Claude, SuperGrok, Cline) | in the IDE against the provider's OAuth; this server only relays the token exchange at `/api/provider-auth/*` | **nothing** — no user row, no token, no log line with a secret |

## Run it locally

```bash
nvm use                     # Node 20.18.2 (.nvmrc)
npm install
cp .env.example .env        # then edit; or pull shared values from zero_thought_node:
npm run env:import -- ../zero_thought_node/.env --dry-run
npm run env:check           # validates .env, prints what is on/off
npm run dev                 # nodemon on http://localhost:4100
npm test                    # Jest (SQLite in-memory, local Mongo if reachable, no Redis needed)
```

Local services on this Mac: MongoDB (`brew services`), MariaDB (`brew services`), Redis
(`redis-server --daemonize yes`). Create the SQL database once:

```sql
CREATE DATABASE atomesus_ide CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'atomesus_ide'@'127.0.0.1' IDENTIFIED BY '...';
GRANT ALL ON atomesus_ide.* TO 'atomesus_ide'@'127.0.0.1';
```

Outside production the schema is synced on boot; in production run `npm run db:sync` once
(or `-- --alter` after model changes).

Point a dev build of the IDE at it with `ORBIT_API_URL=http://localhost:4100` (or set
`orbitApiUrl` in `product.json` for a packaged build).

## Environment

Everything is read once by `src/config/env.js` and validated with zod; a bad value fails at
boot. `.env.example` documents each key. Keys marked `[shared]` have the same names as
`zero_thought_node/.env` (`MONGO_URI`, `DB_*`, `REDIS_*`, `JWT_SECRET`, `GOOGLE_CLIENT_*`,
SES/SMTP, `ATOMESUS_BASE_URL`, rate limits…) so `npm run env:import` can copy them. It only
copies allow-listed keys, never prints values, never overwrites a value already set (use
`--overwrite`), and deliberately skips `DB_NAME` and `PORT` — this service owns its own schema.

Production hard requirements (`auditConfig`): random `JWT_SECRET`, `MONGO_URI`, SQL host,
`API_PUBLIC_URL` on https. Redis is optional (single-instance mode falls back to in-process
state) but required for PM2 cluster / multi-instance deployments.

## Layout

```
index.js                 boot: env audit → Redis → Mongo + SQL → listen, graceful shutdown
src/app.js               Express app (helmet, CORS, compression, routes, error handler)
src/config/env.js        validated config        src/config/providers.js   provider OAuth registry
src/db/{mongo,sql,redis} connections; redis.js also exports `kv` (Redis or memory fallback)
src/models/sql           User, ApiKey (Sequelize)
src/models/mongo         LoginEvent, UserSettings, UsageEvent (Mongoose)
src/middleware           auth (device key or JWT), rate limits, validation, errors, trust proxy
src/services             authService, oauthWebService, desktopAuthService, apiKeyService,
                         providerRelayService, modelGatewayService, usageService, ...
src/routes               health, desktop (HTML pages), auth, account, providerAuth, v1
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
     → page with GitHub / Google / email; when the browser is already signed in it asks
       "Sign in to Atomesus desktop as …?" then redirects to redirect_uri + &code=…
       (Cancel → &error=access_denied)
POST /api/auth/desktop/exchange         { code, codeVerifier }
     → { token: "sk_…", session: { expiresAt }, user: { id, email, name, image, githubLogin, plan } }
DELETE /api/auth/api-keys/current       Bearer sk_… → 204 (IDE sign-out)
```

`redirect_uri` must use a scheme in `DESKTOP_REDIRECT_SCHEMES` (default `atomesus`, `orbit`,
matching `product.json` `urlProtocol`). Codes are single-use, PKCE-bound, 5-minute TTL.
Device keys are `sk_` + 43 chars, stored as SHA-256, 30-day TTL (`DEVICE_KEY_TTL_DAYS`).

### Hosted models (IDE `orbit` provider, Bearer `sk_…`)

```
GET  /api/v1/models            { data: [{ id, orbit: { contextWindow, supportsTools, … } }] }
POST /api/v1/chat/completions  OpenAI-style body, SSE passthrough to ATOMESUS_BASE_URL;
                               usage chunk → credits deducted; 402 insufficient_credits,
                               429 usage_limit_exceeded, 503 gateway unconfigured/unavailable
GET  /api/usage                { wallet, limits, billingPeriod, last30Days }
```

Credits: `ceil(input_tokens/1000 × INPUT_CREDIT_MULTIPLIER + output_tokens/1000 × OUTPUT_CREDIT_MULTIPLIER)`,
cached input billed at 10 %. Subscription credits refill every 30 days to the plan allowance
(`FREE_PLAN_MONTHLY_CREDITS` / `PRO_PLAN_MONTHLY_CREDITS`); top-ups are spent after them.
`ATOMESUS_MODELS` (JSON array) overrides the served list.

### Platform auth (website / API)

```
POST /api/auth/signup/request-otp   { email, name, password }   → emails a 6-digit code
POST /api/auth/signup/verify-otp    { email, otp }              → 201 { token, user } (+ session cookie)
POST /api/auth/login                { email, password }
POST /api/auth/login/google         { idToken }                 (one-tap / mobile)
GET  /api/auth/github | /google     [?flow=<desktop flow>|&return_to=/path] → provider → /callback
GET  /api/auth/me                   Bearer JWT or sk_
POST /api/auth/logout
POST /api/auth/forgot-password      { email }   → POST /verify-otp { email, otp } → { resetToken }
POST /api/auth/reset-password       { resetToken, password }    (revokes every device key)
POST /api/auth/change-password      { currentPassword, newPassword }
```

### Account (Bearer JWT or sk_)

```
GET/PATCH /api/account/profile
GET  /api/account/devices             DELETE /api/account/devices/:id   POST /api/account/devices/revoke-all
GET  /api/account/login-history?limit=50
GET/PUT /api/account/settings         { settings, version } — optimistic version check (409 on conflict)
DELETE /api/account                   { confirm: "DELETE", password? } — scrubs SQL row, purges Mongo
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

## Follow-ups on the IDE side

- The IDE's account gate (`atomesusAccountGate.ts`) only offers "Continue without an account"
  when `orbitApiUrl` is unset. To let a ChatGPT/Claude sign-in satisfy the gate, the gate needs
  to accept a connected provider as signed-in.
- The IDE has no Claude OAuth flow yet (Anthropic is API-key only). The relay's `claude`
  provider is ready for one; the IDE needs a `claude-oauth` manager like `openai-codex/`.
- Codex/Grok/Cline token exchanges still go straight to the provider from Electron. Switching
  them to `/api/provider-auth/:provider/exchange` is optional and lets client ids / endpoints
  change without an IDE release.
