const { loadConfig, auditConfig } = require("../src/config/env");

describe("env config", () => {
  it("applies defaults and coerces types", () => {
    const c = loadConfig({ NODE_ENV: "development", PORT: "5000", REDIS_TLS: "true", CORS_ALLOWED_ORIGINS: "https://a.com, https://b.com", API_PUBLIC_URL: "http://x/" });
    expect(c.PORT).toBe(5000);
    expect(c.REDIS_TLS).toBe(true);
    expect(c.CORS_ALLOWED_ORIGINS).toEqual(["https://a.com", "https://b.com"]);
    expect(c.API_PUBLIC_URL).toBe("http://x");
    expect(c.DESKTOP_REDIRECT_SCHEMES).toEqual(["atomesus", "orbit"]);
  });

  it("flags missing secrets in production as errors", () => {
    const c = loadConfig({ NODE_ENV: "production", API_PUBLIC_URL: "http://insecure", MONGO_URI: "mongodb://x" });
    const { errors } = auditConfig(c);
    expect(errors.join("\n")).toMatch(/JWT_SECRET/);
    expect(errors.join("\n")).toMatch(/https/);
  });
});
