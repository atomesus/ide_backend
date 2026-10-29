# Deploying to https://ide-api.atomesus.com

One EC2 instance runs the backend with PM2 behind nginx. Accounts, Mongo and
Redis are the platform's (zero_thought_node), so the instance must be able to
reach the same RDS MySQL, Mongo and ElastiCache Redis.

## 1. AWS (once)

- **Instance:** Amazon Linux 2023, `t3.small` or larger, same VPC as the platform's RDS and
  ElastiCache. Login user `ec2-user`.
- **Instance security group:** inbound 22 (from your IP and GitHub Actions), 80 and 443 (anywhere).
- **RDS security group:** allow inbound 3306 from the instance's security group.
- **ElastiCache security group:** allow inbound 6379 from the instance's security group.
- **Mongo (Atlas):** add the instance's public IP (Elastic IP recommended) to the access list.
- **DNS:** an `A` record `ide-api.atomesus.com` → the instance's Elastic IP.

## 2. Server (once)

Copy `deploy/` to the instance and run:

```bash
bash deploy/setup-ec2.sh team@atomesus.com
```

It installs Node 20, PM2, nginx and certbot, gets the HTTPS certificate and makes PM2
start on boot.

Then create `/home/ec2-user/ide-backend.env` (`chmod 600`). Start from `.env.example` and take
the `[shared]` values from the platform's production `.env`:

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `4100` |
| `API_PUBLIC_URL` | `https://ide-api.atomesus.com` |
| `WEB_APP_URL` | `https://www.atomesus.com` |
| `JWT_SECRET` | **same as the platform** |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS` | same as the platform |
| `DB_NAME` | `atomesusdb` (the database with the platform `Users` table) |
| `DB_SYNC` | `false` (the deploy runs `npm run db:sync`) |
| `MONGO_URI` | same cluster as the platform |
| `MONGO_DB_NAME` | `atomesus_ide` (this service's own database) |
| `REDIS_HOST` / `REDIS_URL`, `REDIS_TLS` | same as the platform |
| `REDIS_REQUIRED` | `true` (PM2 runs one process per CPU; sign-in codes must be shared) |
| `REDIS_KEY_PREFIX` | `ide:` |
| `ATOMESUS_BASE_URL`, `ATOMESUS_MODEL`, `ATOMESUS_HOSTED_CHAT_API_KEY` | same as the platform |

`npm run env:check` on the server prints anything missing and refuses obvious mistakes.

## 3. GitHub (once)

In `atomesus/ide_backend` → Settings → Secrets and variables → Actions:

- Secret `EC2_HOST`: the Elastic IP or `ide-api.atomesus.com`.
- Secret `EC2_SSH_KEY`: the private key for `ec2-user`.
- Variable `DEPLOY_ENABLED` = `true` to deploy on every push to `main` (leave unset to deploy
  only from the Actions tab).

## 4. Deploy

Actions → **Deploy IDE backend to EC2** → Run workflow. It runs the tests, uploads the app to
`/home/ec2-user/releases/<commit>`, installs production dependencies, checks the env, creates
the `ide_api_keys` and `ide_wallets` tables if missing (`Users` is never touched), switches
`/home/ec2-user/ide-backend` to the new release, reloads PM2 and waits for
`/health/ready`. The five newest releases are kept for rollback:

```bash
ln -sfn /home/ec2-user/releases/<older-commit> /home/ec2-user/ide-backend && cd /home/ec2-user/ide-backend && pm2 reload ecosystem.config.js --env production
```

## 5. Check

```bash
curl https://ide-api.atomesus.com/health
curl -I "https://ide-api.atomesus.com/desktop/login?client=desktop&redirect_uri=atomesus%3A%2F%2Fauth-callback%3Feditor_state%3Dabcdefgh12345678&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256"
```

The second one must answer `302` to `https://www.atomesus.com/desktop/login?...`. That page
exists once the website's `feat/any-file-uploads` branch is merged and deployed.
