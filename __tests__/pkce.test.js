const pkce = require("../src/lib/pkce");

describe("pkce", () => {
  it("round-trips verifier -> challenge", () => {
    const v = pkce.generateVerifier();
    const c = pkce.challengeFor(v);
    expect(pkce.isValidChallenge(c)).toBe(true);
    expect(pkce.verifyChallenge(v, c)).toBe(true);
    expect(pkce.verifyChallenge(v + "x", c)).toBe(false);
    expect(pkce.verifyChallenge("short", c)).toBe(false);
  });
});
