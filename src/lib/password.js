const bcrypt = require("bcryptjs");

const ROUNDS = 12;
const MIN_LENGTH = 8;

function validatePassword(password) {
  if (typeof password !== "string" || password.length < MIN_LENGTH) return `Password must be at least ${MIN_LENGTH} characters`;
  if (password.length > 128) return "Password is too long";
  return null;
}

async function hashPassword(password) {
  return bcrypt.hash(password, ROUNDS);
}

async function verifyPassword(password, hash) {
  if (!hash) return false;
  return bcrypt.compare(password, hash);
}

module.exports = { validatePassword, hashPassword, verifyPassword, MIN_LENGTH };
