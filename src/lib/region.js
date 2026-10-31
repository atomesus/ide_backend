/**
 * India or elsewhere, decided the way the platform routes payments
 * (zero_thought_node src/payments/paymentProviderPolicy.js): the request's IP country first
 * (Cloudflare's CF-IPCountry header in front of this server), then the country on the account,
 * and India for old accounts without one. India sees rupees and pays by Razorpay; everyone else
 * sees dollars and pays by Stripe. Display only: the platform enforces routing again at checkout.
 */
const INDIA_COUNTRY_VALUES = new Set(["in", "ind", "india"]);
// Cloudflare sends XX when it cannot tell and T1 for Tor.
const UNKNOWN_IP_COUNTRIES = new Set(["XX", "T1"]);

function regionFor(req, user) {
  const ipCountry = String((req && typeof req.get === "function" && req.get("cf-ipcountry")) || "").trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(ipCountry) && !UNKNOWN_IP_COUNTRIES.has(ipCountry)) return ipCountry === "IN" ? "IN" : "INTL";
  const country = String(user?.country || "").trim().toLowerCase();
  return !country || INDIA_COUNTRY_VALUES.has(country) ? "IN" : "INTL";
}

const currencyFor = (region) => (region === "IN" ? "INR" : "USD");

/** The IDE plans' prices in the region's currency, for messages. */
const planPricesText = (region) => (region === "IN" ? "₹299 or ₹999" : "$4 or $10");

module.exports = { regionFor, currencyFor, planPricesText };
