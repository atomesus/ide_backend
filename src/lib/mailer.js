/**
 * Outbound email: SES when AWS credentials exist (zero_thought_node's setup),
 * else SMTP via nodemailer, else the message is logged (never in production).
 */
const { config } = require("../config/env");
const logger = require("./logger");

let transport = null;

function fromAddress() {
  const name = String(config.EMAIL_FROM_NAME || "").replace(/["\\]/g, "");
  return name ? `${name} <${config.FROM_EMAIL}>` : config.FROM_EMAIL;
}

function buildTransport() {
  if (config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY) {
    const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");
    const client = new SESClient({ region: config.SES_REGION || config.AWS_REGION || "ap-south-1" });
    return {
      kind: "ses",
      send: async ({ to, subject, text, html }) =>
        client.send(
          new SendEmailCommand({
            Source: fromAddress(),
            Destination: { ToAddresses: [to] },
            Message: {
              Subject: { Data: subject, Charset: "UTF-8" },
              Body: { ...(html ? { Html: { Data: html, Charset: "UTF-8" } } : {}), ...(text ? { Text: { Data: text, Charset: "UTF-8" } } : {}) },
            },
          })
        ),
    };
  }
  if (config.EMAIL_HOST && config.EMAIL_USER && config.EMAIL_PASS) {
    const nodemailer = require("nodemailer");
    const t = nodemailer.createTransport({
      host: config.EMAIL_HOST,
      port: config.EMAIL_PORT,
      secure: config.EMAIL_PORT === 465,
      auth: { user: config.EMAIL_USER, pass: config.EMAIL_PASS },
    });
    return { kind: "smtp", send: (m) => t.sendMail({ from: fromAddress(), ...m }) };
  }
  if (config.isProd) return { kind: "none", send: async () => { throw new Error("Email is not configured (AWS SES or EMAIL_HOST/USER/PASS)"); } };
  return {
    kind: "console",
    send: async ({ to, subject, text }) => {
      // Development only: surfaces OTPs on the console instead of sending.
      console.log(`[mail:console] to=${to} subject=${JSON.stringify(subject)}\n${text || ""}`);
    },
  };
}

async function sendMail(message) {
  if (!transport) {
    transport = buildTransport();
    logger.info("mailer ready", { kind: transport.kind });
  }
  return transport.send(message);
}

function otpEmail({ name, otp, purpose }) {
  const what = purpose === "reset" ? "reset your password" : "verify your email";
  const text = `Hi ${name || "there"},\n\nYour Atomesus code to ${what} is: ${otp}\n\nIt expires in ${Math.round(config.OTP_TTL_SEC / 60)} minutes. If you did not request this, ignore this email.`;
  const html = `<p>Hi ${name || "there"},</p><p>Your Atomesus code to ${what} is:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${otp}</p><p>It expires in ${Math.round(config.OTP_TTL_SEC / 60)} minutes. If you did not request this, ignore this email.</p>`;
  return { subject: `${otp} is your Atomesus code`, text, html };
}

module.exports = { sendMail, otpEmail, _resetForTests: () => { transport = null; } };
