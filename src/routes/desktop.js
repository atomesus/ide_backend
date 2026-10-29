/**
 * The IDE opens {orbitApiUrl}/desktop/login|signup. The page itself lives on
 * the website (WEB_APP_URL), so these routes only validate the request and
 * forward the browser there with the same query. A broken link is forwarded
 * too: the website renders the error so the user sees Atomesus, not JSON.
 */
const express = require("express");
const desktop = require("../services/desktopAuthService");

const router = express.Router();

function forward(screen) {
  return (req, res) => {
    const q = req.query;
    try {
      desktop.validateRequest({ redirectUri: q.redirect_uri, codeChallenge: q.code_challenge, codeChallengeMethod: q.code_challenge_method, client: q.client });
    } catch (err) {
      return res.redirect(302, desktop.websiteUrl(screen, { error: err.code || "invalid_request" }));
    }
    res.set("Cache-Control", "no-store");
    res.redirect(302, desktop.websiteUrl(screen, { client: q.client, redirect_uri: q.redirect_uri, code_challenge: q.code_challenge, code_challenge_method: q.code_challenge_method || "S256" }));
  };
}

router.get("/login", forward("login"));
router.get("/signup", forward("signup"));

module.exports = { router };
