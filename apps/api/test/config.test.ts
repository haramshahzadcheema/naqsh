import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveCorsConfig, resolveEnvironment } from "../src/config.js";
import { createServer } from "../src/server.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("resolveEnvironment", () => {
  it("recognizes 'production' and 'test' explicitly", () => {
    assert.equal(resolveEnvironment("production"), "production");
    assert.equal(resolveEnvironment("test"), "test");
  });

  it("defaults anything else (including unset) to 'development'", () => {
    assert.equal(resolveEnvironment(undefined), "development");
    assert.equal(resolveEnvironment(""), "development");
    assert.equal(resolveEnvironment("staging"), "development");
  });
});

describe("resolveCorsConfig", () => {
  it("development/test stay permissive by default -- no allowlist configured, no origins returned (cors() reflects any origin)", () => {
    assert.deepEqual(resolveCorsConfig("development", undefined).allowedOrigins, undefined);
    assert.deepEqual(resolveCorsConfig("test", undefined).allowedOrigins, undefined);
  });

  it("a configured allowlist is honored in any environment", () => {
    const result = resolveCorsConfig("development", "https://a.example.com, https://b.example.com");
    assert.deepEqual(result.allowedOrigins, ["https://a.example.com", "https://b.example.com"]);
  });

  it("production REFUSES to start with no allowlist -- never silently permissive", () => {
    assert.throws(() => resolveCorsConfig("production", undefined), /NAQSH_ALLOWED_ORIGIN must be set/);
    assert.throws(() => resolveCorsConfig("production", ""), /NAQSH_ALLOWED_ORIGIN must be set/);
    assert.throws(() => resolveCorsConfig("production", " , , "), /NAQSH_ALLOWED_ORIGIN must be set/);
  });

  it("production starts cleanly once a real allowlist is configured", () => {
    const result = resolveCorsConfig("production", "https://app.example.com");
    assert.deepEqual(result.allowedOrigins, ["https://app.example.com"]);
  });
});

describe("createServer refuses to start in production without NAQSH_ALLOWED_ORIGIN", () => {
  it("throws synchronously from createServer itself -- before any port is ever bound", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "naqsh-config-test-"));
    const originalNodeEnv = process.env.NODE_ENV;
    const originalAllowedOrigin = process.env.NAQSH_ALLOWED_ORIGIN;
    try {
      process.env.NODE_ENV = "production";
      delete process.env.NAQSH_ALLOWED_ORIGIN;
      assert.throws(() => createServer({ dataDir }), /NAQSH_ALLOWED_ORIGIN must be set/);
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
      if (originalAllowedOrigin === undefined) delete process.env.NAQSH_ALLOWED_ORIGIN;
      else process.env.NAQSH_ALLOWED_ORIGIN = originalAllowedOrigin;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
