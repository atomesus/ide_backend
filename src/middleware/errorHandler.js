const logger = require("../lib/logger");
const { HttpError } = require("../lib/errors");
const { config } = require("../config/env");

function notFoundHandler(req, res) {
  res.status(404).json({ success: false, code: 404, message: `No route for ${req.method} ${req.path}`, error: { code: "not_found", message: "Not found" } });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    try { res.end(); } catch { /* ignore */ }
    return;
  }
  let status = err.status || err.statusCode || 500;
  let code = err.code;
  let message = err.message;

  if (err.type === "entity.parse.failed") { status = 400; code = "invalid_json"; message = "Malformed JSON body"; }
  else if (err.type === "entity.too.large") { status = 413; code = "payload_too_large"; message = "Request body too large"; }
  else if (err.name === "TokenExpiredError") { status = 401; code = "token_expired"; message = "Session expired. Please sign in again."; }
  else if (err.name === "JsonWebTokenError") { status = 401; code = "invalid_token"; message = "Invalid token. Please sign in again."; }
  else if (err.name === "SequelizeUniqueConstraintError") { status = 409; code = "conflict"; message = "Already exists"; }
  else if (err.name === "SequelizeValidationError") { status = 400; code = "validation_error"; }

  const expose = err instanceof HttpError ? err.expose : status < 500;
  if (status >= 500 && !(err instanceof HttpError)) logger.error("request failed", { method: req.method, path: req.originalUrl, error: err });
  else if (!config.isTest) logger.debug("request rejected", { method: req.method, path: req.originalUrl, status, code });

  const safeMessage = expose ? message : "Internal server error";
  res.status(status).json({
    success: false,
    code: status,
    message: safeMessage,
    error: { code: code || HttpError.defaultCode(status), message: safeMessage, ...(err.extra || {}) },
  });
}

module.exports = { notFoundHandler, errorHandler };
