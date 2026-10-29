/** Builds the Express app without listening, so tests can mount it with supertest. */
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const compression = require("compression");
const morgan = require("morgan");
const { config } = require("./config/env");
const { resolveTrustProxy } = require("./middleware/clientIp");
const { notFoundHandler, errorHandler } = require("./middleware/errorHandler");
const logger = require("./lib/logger");

const STATIC_ORIGINS = ["http://localhost:3000", "http://localhost:3001", "http://localhost:5173", "https://atomesus.com", "https://www.atomesus.com"];

function corsOrigin(origin, cb) {
  if (!origin || origin === "null") return cb(null, true); // IDE (Electron main), curl, mobile
  if (STATIC_ORIGINS.includes(origin) || config.CORS_ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol === "https:" && (hostname === "atomesus.us" || hostname.endsWith(".atomesus.us") || hostname.endsWith(".atomesus.com"))) return cb(null, true);
    if (!config.isProd && /^(localhost|127\.0\.0\.1)$/.test(hostname)) return cb(null, true);
  } catch {
    /* fallthrough */
  }
  const err = new Error(`CORS blocked for origin ${origin}`);
  err.status = 403;
  cb(err, false);
}

function createApp() {
  const app = express();
  app.set("trust proxy", resolveTrustProxy());
  app.disable("x-powered-by");
  app.set("etag", false);

  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], imgSrc: ["'self'", "https:", "data:"], styleSrc: ["'self'", "'unsafe-inline'"], formAction: ["'self'"], frameAncestors: ["'none'"] } }, crossOriginEmbedderPolicy: false }));
  app.use((req, res, next) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    next();
  });
  app.use(cors({ origin: corsOrigin, credentials: true, methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "X-Health-Token", "X-Atomesus-Platform"], maxAge: 600 }));
  app.use(compression({ filter: (req, res) => !String(res.getHeader("Content-Type") || "").includes("text/event-stream") && compression.filter(req, res) }));
  app.use(express.json({ limit: "1mb" }));

  if (!config.isTest) {
    morgan.token("url", (req) => String(req.originalUrl || req.url || "").replace(/([?&](?:token|code|key|state|otp)=)[^&#]*/gi, "$1[REDACTED]"));
    app.use(morgan(config.isProd ? "combined" : "dev"));
  }

  app.use(require("./routes/health"));
  app.get("/", (req, res) => res.json({ service: "atomesus-ide-backend", docs: "/api/provider-auth/providers", health: "/health" }));

  app.use("/desktop", require("./routes/desktop").router);
  app.use("/api/auth", require("./routes/auth"));
  app.use("/api/account", require("./routes/account"));
  app.use("/api/provider-auth", require("./routes/providerAuth"));
  app.use("/api", require("./routes/v1"));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp, corsOrigin };
