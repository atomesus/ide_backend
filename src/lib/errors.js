/** HTTP-aware error. `expose` controls whether the message reaches the client. */
class HttpError extends Error {
  constructor(status, message, code, extra) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code || HttpError.defaultCode(status);
    this.expose = status < 500 || status === 502 || status === 503;
    if (extra) this.extra = extra;
  }
  static defaultCode(status) {
    return { 400: "bad_request", 401: "unauthorized", 402: "payment_required", 403: "forbidden", 404: "not_found", 409: "conflict", 429: "rate_limited", 503: "unavailable" }[status] || "error";
  }
}

const badRequest = (m, c) => new HttpError(400, m, c);
const unauthorized = (m = "Please sign in.", c) => new HttpError(401, m, c);
const forbidden = (m = "Forbidden", c) => new HttpError(403, m, c);
const notFound = (m = "Not found", c) => new HttpError(404, m, c);
const conflict = (m, c) => new HttpError(409, m, c);
const unavailable = (m = "Service unavailable", c) => new HttpError(503, m, c);

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, conflict, unavailable };
