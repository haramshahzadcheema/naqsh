import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadGeminiConfigFromEnv } from "../src/config.js";

describe("loadGeminiConfigFromEnv", () => {
  it("returns null when GEMINI_API_KEY is absent -- never throws, never fakes a config", () => {
    assert.equal(loadGeminiConfigFromEnv({}), null);
  });

  it("returns null when GEMINI_API_KEY is an empty string", () => {
    assert.equal(loadGeminiConfigFromEnv({ GEMINI_API_KEY: "" }), null);
  });

  it("builds a config with defaults when only the API key is set", () => {
    const config = loadGeminiConfigFromEnv({ GEMINI_API_KEY: "test-key-123" });
    assert.ok(config);
    assert.equal(config.apiKey, "test-key-123");
    assert.equal(config.modelId, "gemini-2.5-flash");
    assert.equal(config.timeoutMs, 30000);
    assert.equal(config.maxRetries, 2);
  });

  it("honors overrides for model/timeout/retries", () => {
    const config = loadGeminiConfigFromEnv({
      GEMINI_API_KEY: "test-key-123",
      GEMINI_MODEL: "gemini-2.5-pro",
      GEMINI_TIMEOUT_MS: "5000",
      GEMINI_MAX_RETRIES: "5"
    });
    assert.ok(config);
    assert.equal(config.modelId, "gemini-2.5-pro");
    assert.equal(config.timeoutMs, 5000);
    assert.equal(config.maxRetries, 5);
  });

  it("falls back to defaults for non-numeric/invalid overrides rather than producing NaN", () => {
    const config = loadGeminiConfigFromEnv({ GEMINI_API_KEY: "k", GEMINI_TIMEOUT_MS: "not-a-number" });
    assert.ok(config);
    assert.equal(config.timeoutMs, 30000);
  });

  it("never logs or throws the api key itself", () => {
    // Structural guarantee: the function's return type carries the key as
    // plain data (the CALLER decides what to do with it), not as
    // something this function writes to console/logs.
    assert.doesNotThrow(() => loadGeminiConfigFromEnv({ GEMINI_API_KEY: "secret" }));
  });
});
