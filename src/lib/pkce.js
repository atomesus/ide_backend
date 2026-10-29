const crypto = require("crypto");

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function generateVerifier() {
  return b64url(crypto.randomBytes(32));
}

function challengeFor(verifier) {
  return b64url(crypto.createHash("sha256").update(verifier).digest());
}

/** Constant-time check that `verifier` hashes to `challenge` (S256). */
function verifyChallenge(verifier, challenge) {
  if (typeof verifier !== "string" || typeof challenge !== "string") return false;
  if (verifier.length < 43 || verifier.length > 128) return false;
  const a = Buffer.from(challengeFor(verifier));
  const b = Buffer.from(challenge);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isValidChallenge(challenge) {
  return typeof challenge === "string" && /^[A-Za-z0-9_-]{43}$/.test(challenge);
}

module.exports = { generateVerifier, challengeFor, verifyChallenge, isValidChallenge };
