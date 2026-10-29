// PM2 reads this from the release folder, so load its .env to decide the process count.
require("dotenv").config({ quiet: true });

// One-time sign-in codes and rate limits live in Redis; without it they are
// per-process, so run a single process until Redis is configured.
const redisConfigured = Boolean(process.env.REDIS_URL || process.env.REDIS_HOST);

module.exports = {
  apps: [
    {
      name: "ide-backend",
      script: "index.js",
      instances: redisConfigured ? process.env.PM2_INSTANCES || "max" : 1,
      exec_mode: "cluster",
      max_memory_restart: process.env.PM2_MAX_MEMORY || "1G",
      env: { NODE_ENV: "production" },
      env_production: { NODE_ENV: "production" },
      listen_timeout: 10000,
      kill_timeout: 5000,
    },
  ],
};
