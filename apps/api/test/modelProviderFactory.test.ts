import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { resolveModelProvider, isGeminiConfigured, getModelCatalog, DETERMINISTIC_MODEL_ID } from "../src/modelProviderFactory.js";

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

describe("apps/api model provider factory: never trusts an arbitrary client-supplied model id", () => {
  beforeEach(() => {
    delete process.env.GEMINI_API_KEY;
  });
  afterEach(resetEnv);

  it("the deterministic (mock) model is always available -- no API key required", () => {
    const resolved = resolveModelProvider(DETERMINISTIC_MODEL_ID);
    assert.ok("provider" in resolved);
  });

  it("an unrecognized model id is rejected outright, never silently substituted", () => {
    const resolved = resolveModelProvider("gpt-4-super-turbo-arbitrary");
    assert.ok("error" in resolved);
    if ("error" in resolved) assert.equal(resolved.error.reason, "unknown_model");
  });

  it("an allowlisted Gemini model is rejected with an honest 'not_configured' reason when no GEMINI_API_KEY is set -- never a fake reply", () => {
    assert.equal(isGeminiConfigured(), false);
    const resolved = resolveModelProvider("gemini-3.5-flash");
    assert.ok("error" in resolved);
    if ("error" in resolved) assert.equal(resolved.error.reason, "not_configured");
  });

  it("an allowlisted Gemini model resolves to a real provider once GEMINI_API_KEY is set", () => {
    process.env.GEMINI_API_KEY = "test-key-not-a-real-secret";
    assert.equal(isGeminiConfigured(), true);
    const resolved = resolveModelProvider("gemini-3.5-flash-lite");
    assert.ok("provider" in resolved);
    if ("provider" in resolved) {
      assert.equal(resolved.modelId, "gemini-3.5-flash-lite");
      assert.equal(resolved.provider.describe().modelId, "gemini-3.5-flash-lite");
    }
  });
});

describe("apps/api model catalog: real availability, not just a static list", () => {
  beforeEach(() => {
    delete process.env.GEMINI_API_KEY;
  });
  afterEach(resetEnv);

  it("every Gemini entry reports unavailable, with an honest reason, when no GEMINI_API_KEY is set", () => {
    const catalog = getModelCatalog();
    const geminiEntries = catalog.filter((entry) => entry.provider === "gemini");
    assert.ok(geminiEntries.length > 0);
    for (const entry of geminiEntries) {
      assert.equal(entry.available, false);
      assert.match(entry.availabilityReason ?? "", /GEMINI_API_KEY/);
    }
  });

  it("Gemini entries flip to available once GEMINI_API_KEY is set, with no reason attached", () => {
    process.env.GEMINI_API_KEY = "test-key-not-a-real-secret";
    const catalog = getModelCatalog();
    const geminiEntries = catalog.filter((entry) => entry.provider === "gemini");
    for (const entry of geminiEntries) {
      assert.equal(entry.available, true);
      assert.equal(entry.availabilityReason, null);
    }
  });

  it("the deterministic entry is always available and honestly reports no streaming support (nothing to progressively reveal)", () => {
    const deterministic = getModelCatalog().find((entry) => entry.modelId === DETERMINISTIC_MODEL_ID);
    assert.ok(deterministic);
    assert.equal(deterministic!.available, true);
    assert.equal(deterministic!.capabilities.streaming, false);
  });

  it("every catalog entry's modelId is resolvable through resolveModelProvider -- the catalog and the allowlist never drift apart", () => {
    process.env.GEMINI_API_KEY = "test-key-not-a-real-secret";
    for (const entry of getModelCatalog()) {
      const resolved = resolveModelProvider(entry.modelId);
      assert.ok("provider" in resolved, `catalog entry "${entry.modelId}" must resolve to a real provider`);
    }
  });
});
