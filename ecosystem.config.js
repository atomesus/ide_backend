module.exports = {
  apps: [
    {
      name: "ide-backend",
      script: "index.js",
      instances: process.env.PM2_INSTANCES || "max",
      exec_mode: "cluster",
      max_memory_restart: process.env.PM2_MAX_MEMORY || "1G",
      env: { NODE_ENV: "production" },
      env_production: { NODE_ENV: "production" },
      listen_timeout: 10000,
      kill_timeout: 5000,
    },
  ],
};
