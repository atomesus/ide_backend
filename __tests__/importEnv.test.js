const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

describe("scripts/import-env.js", () => {
  it("copies the shared platform keys (including DB_NAME) and nothing else", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ide-env-"));
    const src = path.join(dir, "source.env");
    fs.writeFileSync(src, "MONGO_URI=mongodb://prod\nDB_NAME=atomesusdb\nJWT_SECRET=abc\nPORT=4000\nSOME_OTHER=1\n");
    const dest = path.join(dir, "dest.env");
    fs.writeFileSync(dest, "DB_NAME=\nJWT_SECRET=change-me-64-hex\nPORT=4100\n");
    const out = execFileSync("node", [path.join(__dirname, "..", "scripts", "import-env.js"), src, "--dry-run", "--dest", dest], { encoding: "utf8" });
    expect(out).toMatch(/MONGO_URI/);
    expect(out).toMatch(/JWT_SECRET/);
    expect(out).toMatch(/DB_NAME/);
    expect(out).not.toMatch(/PORT/);
    expect(out).not.toMatch(/SOME_OTHER/);
    expect(out).not.toMatch(/mongodb:\/\/prod/); // values are never printed
  });
});
