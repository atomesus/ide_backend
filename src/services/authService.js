const { kv } = require("../db/redis");
const { config } = require("../config/env");
const { normalizeEmail, isValidEmail, isDisposableBlocked } = require("../lib/email");
const { hashPassword, verifyPassword, validatePassword } = require("../lib/password");
const { generateOtp, signPurposeToken, verifyPurposeToken, signSessionToken } = require("../lib/tokens");
const { sendMail, otpEmail } = require("../lib/mailer");
const { badRequest, unauthorized, conflict } = require("../lib/errors");
const users = require("./userService");

const MAX_OTP_ATTEMPTS = 5;
const otpKey = (purpose, email) => `otp:${purpose}:${normalizeEmail(email)}`;

async function issueOtp(purpose, email, name) {
  const otp = generateOtp();
  await kv.setJSON(otpKey(purpose, email), { otp, attempts: 0, name: name || "" }, config.OTP_TTL_SEC);
  await sendMail({ to: normalizeEmail(email), ...otpEmail({ name, otp, purpose }) });
}

/** Burns the OTP after MAX_OTP_ATTEMPTS wrong guesses. Returns stored record on success. */
async function consumeOtp(purpose, email, otp) {
  const key = otpKey(purpose, email);
  const record = await kv.getJSON(key);
  if (!record) throw badRequest("Code expired or not requested. Request a new one.", "otp_expired");
  if (String(otp) !== record.otp) {
    record.attempts = (record.attempts || 0) + 1;
    if (record.attempts >= MAX_OTP_ATTEMPTS) {
      await kv.del(key);
      throw badRequest("Too many wrong codes. Request a new one.", "otp_burned");
    }
    await kv.setJSON(key, record, config.OTP_TTL_SEC);
    throw badRequest("Incorrect code.", "otp_invalid");
  }
  await kv.del(key);
  return record;
}

function assertEmail(email) {
  if (!isValidEmail(email)) throw badRequest("Enter a valid email address.", "invalid_email");
  if (isDisposableBlocked(email)) throw badRequest("Disposable email addresses are not allowed.", "disposable_email");
}

// ---- sign-up (email + OTP) ------------------------------------------------
async function requestSignupOtp({ email, name, password }) {
  assertEmail(email);
  const pwErr = validatePassword(password);
  if (pwErr) throw badRequest(pwErr, "weak_password");
  const existing = await users.findByEmail(email);
  if (existing && existing.emailVerifiedAt) throw conflict("Account already exists. Please log in.", "account_exists");
  // Stash the pending signup alongside the OTP; nothing is written to SQL until verified.
  const passwordHash = await hashPassword(password);
  await kv.setJSON(`signup:${normalizeEmail(email)}`, { name: String(name || "").trim(), passwordHash }, config.OTP_TTL_SEC);
  await issueOtp("signup", email, name);
}

async function verifySignupOtp({ email, otp }) {
  await consumeOtp("signup", email, otp);
  const pending = await kv.getJSON(`signup:${normalizeEmail(email)}`);
  if (!pending) throw badRequest("Sign-up expired. Start again.", "signup_expired");
  await kv.del(`signup:${normalizeEmail(email)}`);
  let user = await users.findByEmail(email);
  if (user) {
    user.passwordHash = pending.passwordHash;
    if (pending.name) user.name = pending.name;
    user.emailVerifiedAt = user.emailVerifiedAt || new Date();
    await user.save();
  } else {
    user = await users.createUser({ email, name: pending.name, passwordHash: pending.passwordHash, emailVerified: true });
  }
  return user;
}

// ---- login (email + password) ---------------------------------------------
async function loginWithPassword({ email, password }) {
  const user = await users.findByEmail(email);
  const ok = user ? await verifyPassword(password, user.passwordHash) : await verifyPassword(password, "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv"); // constant-ish time
  if (!user || !ok) throw unauthorized("Invalid email or password.", "invalid_credentials");
  if (!user.emailVerifiedAt) throw unauthorized("Verify your email first.", "email_unverified");
  return user;
}

// ---- password reset -------------------------------------------------------
async function requestPasswordReset({ email }) {
  const user = await users.findByEmail(email);
  // Always answer the same way so the endpoint cannot be used to enumerate accounts.
  if (user) await issueOtp("reset", email, user.name);
}

async function verifyPasswordResetOtp({ email, otp }) {
  await consumeOtp("reset", email, otp);
  return signPurposeToken("password_reset", { email: normalizeEmail(email) }, config.PASSWORD_RESET_TOKEN_TTL);
}

async function resetPassword({ resetToken, password }) {
  const pwErr = validatePassword(password);
  if (pwErr) throw badRequest(pwErr, "weak_password");
  let decoded;
  try {
    decoded = verifyPurposeToken("password_reset", resetToken);
  } catch {
    throw badRequest("Reset link is invalid or expired.", "invalid_reset_token");
  }
  const user = await users.findByEmail(decoded.email);
  if (!user) throw badRequest("Account not found.", "account_missing");
  user.passwordHash = await hashPassword(password);
  await user.save();
  return user;
}

async function changePassword(user, { currentPassword, newPassword }) {
  if (user.passwordHash && !(await verifyPassword(currentPassword || "", user.passwordHash))) throw unauthorized("Current password is incorrect.", "invalid_credentials");
  const pwErr = validatePassword(newPassword);
  if (pwErr) throw badRequest(pwErr, "weak_password");
  user.passwordHash = await hashPassword(newPassword);
  await user.save();
}

// ---- Google ID token (web one-tap, mobile) --------------------------------
let googleClient = null;
async function loginWithGoogleIdToken({ idToken }) {
  if (!config.GOOGLE_CLIENT_ID) throw badRequest("Google sign-in is not configured.", "google_not_configured");
  const { OAuth2Client } = require("google-auth-library");
  googleClient ||= new OAuth2Client(config.GOOGLE_CLIENT_ID);
  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken, audience: config.GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch {
    throw unauthorized("Invalid Google token.", "invalid_google_token");
  }
  if (!payload?.sub || !payload.email_verified) throw unauthorized("Google account email is not verified.", "invalid_google_token");
  return users.upsertOAuthUser("google", { providerId: payload.sub, email: payload.email, name: payload.name, image: payload.picture });
}

function sessionFor(user) {
  const token = signSessionToken(user);
  return { token, user: users.safeUser(user) };
}

module.exports = {
  requestSignupOtp,
  verifySignupOtp,
  loginWithPassword,
  requestPasswordReset,
  verifyPasswordResetOtp,
  resetPassword,
  changePassword,
  loginWithGoogleIdToken,
  sessionFor,
};
