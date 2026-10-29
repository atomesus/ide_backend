const http = require("http");
const { config, auditConfig } = require("./src/config/env");
const logger = require("./src/lib/logger");

async function main() {
  const { errors, warnings } = auditConfig(config);
  for (const w of warnings) logger.warn(w);
  if (errors.length) {
    for (const e of errors) logger.error(e);
    process.exit(1);
  }

  const { connectRedis, disconnectRedis } = require("./src/db/redis");
  const { connectMongo, disconnectMongo } = require("./src/db/mongo");
  const { connectSql, disconnectSql } = require("./src/db/sql");

  await connectRedis(); // first: rate limiters and kv pick it up lazily
  await Promise.all([connectMongo(), connectSql()]);

  const { createApp } = require("./src/app");
  const app = createApp();
  const server = http.createServer(app);
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  await new Promise((resolve) => server.listen(config.PORT, resolve));
  logger.info("ide-backend listening", { port: config.PORT, env: config.NODE_ENV, publicUrl: config.API_PUBLIC_URL });

  const shutdown = async (signal) => {
    logger.info("shutting down", { signal });
    server.close(async () => {
      await Promise.allSettled([disconnectRedis(), disconnectMongo(), disconnectSql()]);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (err) => logger.error("unhandledRejection", { error: err }));
}

main().catch((err) => {
  logger.error("startup failed", { error: err });
  process.exit(1);
});
