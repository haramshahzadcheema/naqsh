import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createModelInvocationResult,
  createModelProviderDescriptor,
  createModelResponse,
  createWorldModelState,
  type WorldModelState
} from "@naqsh/schemas";
import { interpretRequirementFromText } from "../src/requirement-interpreter.js";
import { validateStructuredResult, type ModelProvider } from "../src/index.js";

function buildState(): WorldModelState {
  return createWorldModelState({ project: { id: "proj_1", name: "Bracket Study", objective: { summary: "Design a mounting bracket." } }, session: {} });
}

/** A fake ModelProvider that always returns the given structured result,
 * schema-validated the real way (`validateStructuredResult`) exactly like
 * `proposal-generator.test.ts`'s own fake provider -- never a hand-waved
 * "just return this object" mock that skips the schema-conformance check
 * `generate()` is actually supposed to perform. */
function buildFakeProvider(structuredResult: Record<string, unknown>): ModelProvider {
  return {
    describe: () => createModelProviderDescriptor({ providerId: "fake", modelId: "fake-v1", supportsStructuredOutput: true }),
    async generate(request) {
      const response = createModelResponse({ requestId: request.id, kind: "structured_result", structuredResult });
      const schemaErrors = validateStructuredResult(response, request);
      return createModelInvocationResult({
        requestId: request.id,
        providerId: "fake",
        modelId: "fake-v1",
        status: schemaErrors.length > 0 ? "error" : "success",
        response: schemaErrors.length > 0 ? undefined : response,
        error: schemaErrors.length > 0 ? { kind: "schema_validation_failed", message: schemaErrors.join("; ") } : undefined,
        startedAt: new Date().toISOString()
      });
    }
  };
}

function specificPayload(overrides: Record<string, unknown> = {}) {
  return {
    description: "Load capacity must be at least 500 N.",
    category: "load",
    interpretationStatus: "specific",
    operator: "gte",
    value: 500,
    unit: "N",
    ambiguityReason: null,
    ...overrides
  };
}

describe("interpretRequirementFromText: direct numerical requirement", () => {
  it('"The bracket must support 500 N." -> a specific, quantitative candidate', async () => {
    const provider = buildFakeProvider(specificPayload());
    const result = await interpretRequirementFromText(provider, buildState(), "The bracket must support 500 N.", { config: { modelId: "fake-v1" } });
    assert.equal(result.status, "success");
    if (result.status !== "success") return;
    assert.equal(result.candidate.interpretationStatus, "specific");
    assert.equal(result.candidate.operator, "gte");
    assert.equal(result.candidate.value, 500);
    assert.equal(result.candidate.unit, "N");
    assert.equal(result.candidate.statementText, "The bracket must support 500 N.");
  });
});

describe("interpretRequirementFromText: dimensional requirement", () => {
  it('"Keep the mass below 2 kg." -> metric/operator/value/unit extracted', async () => {
    const provider = buildFakeProvider(specificPayload({ description: "Total mass must be below 2 kg.", category: "mass", operator: "lt", value: 2, unit: "kg" }));
    const result = await interpretRequirementFromText(provider, buildState(), "Keep the mass below 2 kg.", { config: { modelId: "fake-v1" } });
    assert.equal(result.status, "success");
    if (result.status !== "success") return;
    assert.equal(result.candidate.category, "mass");
    assert.equal(result.candidate.operator, "lt");
    assert.equal(result.candidate.value, 2);
    assert.equal(result.candidate.unit, "kg");
  });
});

describe("interpretRequirementFromText: non-numerical requirement", () => {
  it('"The design should be easy to manufacture." -> specific but no invented quantitative values', async () => {
    const provider = buildFakeProvider(
      specificPayload({ description: "Design must be easy to manufacture.", category: "manufacturability", operator: null, value: null, unit: null })
    );
    const result = await interpretRequirementFromText(provider, buildState(), "The design should be easy to manufacture.", { config: { modelId: "fake-v1" } });
    assert.equal(result.status, "success");
    if (result.status !== "success") return;
    assert.equal(result.candidate.interpretationStatus, "specific");
    assert.equal(result.candidate.operator, null);
    assert.equal(result.candidate.value, null);
    assert.equal(result.candidate.unit, null);
  });
});

describe("interpretRequirementFromText: ambiguous requirement", () => {
  it('"Make it lightweight." -> ambiguous, never a fabricated threshold', async () => {
    const provider = buildFakeProvider({
      description: "The design should be lightweight.",
      category: "mass",
      interpretationStatus: "ambiguous",
      operator: null,
      value: null,
      unit: null,
      ambiguityReason: "No specific mass target or unit was stated."
    });
    const result = await interpretRequirementFromText(provider, buildState(), "Make it lightweight.", { config: { modelId: "fake-v1" } });
    assert.equal(result.status, "success");
    if (result.status !== "success") return;
    assert.equal(result.candidate.interpretationStatus, "ambiguous");
    assert.equal(result.candidate.value, null);
    assert.equal(result.candidate.operator, null);
    assert.match(result.candidate.ambiguityReason!, /No specific mass target/);
  });

  it("even if the model tries to smuggle a numeric value alongside interpretationStatus:'ambiguous', it is stripped -- never trusted", async () => {
    // The model's raw JSON claims BOTH "ambiguous" AND a specific numeric
    // value -- a self-contradictory response a non-compliant or
    // hallucinating model could produce. createRequirementCandidate
    // (schemas layer) normalizes this away rather than trusting either
    // half blindly.
    const provider = buildFakeProvider({
      description: "The design should be lightweight.",
      category: "mass",
      interpretationStatus: "ambiguous",
      operator: "lt",
      value: 2,
      unit: "kg",
      ambiguityReason: "No specific mass target was stated."
    });
    const result = await interpretRequirementFromText(provider, buildState(), "Make it lightweight.", { config: { modelId: "fake-v1" } });
    assert.equal(result.status, "success");
    if (result.status !== "success") return;
    assert.equal(result.candidate.operator, null);
    assert.equal(result.candidate.value, null);
    assert.equal(result.candidate.unit, null);
  });
});

describe("interpretRequirementFromText: malformed model output", () => {
  it("rejects a response missing required fields (fails schema validation before ever reaching this function's own logic)", async () => {
    const provider = buildFakeProvider({ description: "x" }); // missing category, interpretationStatus, etc.
    const result = await interpretRequirementFromText(provider, buildState(), "The bracket must support 500 N.", { config: { modelId: "fake-v1" } });
    assert.equal(result.status, "error");
    if (result.status !== "error") return;
    assert.equal(result.error.kind, "model_unavailable");
  });

  it("rejects an invalid enum for interpretationStatus", async () => {
    const provider = buildFakeProvider(specificPayload({ interpretationStatus: "maybe" }));
    const result = await interpretRequirementFromText(provider, buildState(), "The bracket must support 500 N.", { config: { modelId: "fake-v1" } });
    assert.equal(result.status, "error");
  });

  it("rejects an invalid operator enum", async () => {
    const provider = buildFakeProvider(specificPayload({ operator: "roughly_equal_to" }));
    const result = await interpretRequirementFromText(provider, buildState(), "The bracket must support 500 N.", { config: { modelId: "fake-v1" } });
    assert.equal(result.status, "error");
  });

  it("rejects a non-numeric value", async () => {
    const provider = buildFakeProvider(specificPayload({ value: "five hundred" }));
    const result = await interpretRequirementFromText(provider, buildState(), "The bracket must support 500 N.", { config: { modelId: "fake-v1" } });
    assert.equal(result.status, "error");
  });

  it("rejects a specific candidate carrying an operator but no value (semantically inconsistent, caught by the schemas-layer validator)", async () => {
    const provider = buildFakeProvider(specificPayload({ operator: "gte", value: null }));
    const result = await interpretRequirementFromText(provider, buildState(), "The bracket must support 500 N.", { config: { modelId: "fake-v1" } });
    assert.equal(result.status, "error");
    if (result.status !== "error") return;
    assert.equal(result.error.kind, "malformed_candidate_shape");
  });
});

describe("interpretRequirementFromText: input validation", () => {
  it("rejects empty statementText", async () => {
    const provider = buildFakeProvider(specificPayload());
    const result = await interpretRequirementFromText(provider, buildState(), "", { config: { modelId: "fake-v1" } });
    assert.equal(result.status, "error");
    if (result.status !== "error") return;
    assert.equal(result.error.kind, "invalid_input");
  });

  it("rejects whitespace-only statementText", async () => {
    const provider = buildFakeProvider(specificPayload());
    const result = await interpretRequirementFromText(provider, buildState(), "   ", { config: { modelId: "fake-v1" } });
    assert.equal(result.status, "error");
  });
});

describe("interpretRequirementFromText: model/API failure", () => {
  it("a provider that reports status:'error' is surfaced as model_unavailable, never fabricated into a candidate", async () => {
    const provider: ModelProvider = {
      describe: () => createModelProviderDescriptor({ providerId: "fake", modelId: "fake-v1", supportsStructuredOutput: true }),
      async generate(request) {
        return createModelInvocationResult({
          requestId: request.id,
          providerId: "fake",
          modelId: "fake-v1",
          status: "error",
          error: { kind: "api_unavailable", message: "simulated outage" },
          startedAt: new Date().toISOString()
        });
      }
    };
    const result = await interpretRequirementFromText(provider, buildState(), "The bracket must support 500 N.", { config: { modelId: "fake-v1" } });
    assert.equal(result.status, "error");
    if (result.status !== "error") return;
    assert.equal(result.error.kind, "model_unavailable");
    assert.match(result.error.message, /simulated outage/);
  });
});

describe("interpretRequirementFromText: provenance", () => {
  it("the candidate's source is always 'agent' -- Gemini interpreted it, the user did not directly author structured state", async () => {
    const provider = buildFakeProvider(specificPayload());
    const result = await interpretRequirementFromText(provider, buildState(), "The bracket must support 500 N.", { config: { modelId: "fake-v1" } });
    assert.equal(result.status, "success");
    if (result.status !== "success") return;
    assert.equal(result.candidate.source, "agent");
  });
});

describe("interpretRequirementFromText: determinism", () => {
  it("parsing the same fixture twice with the same fake provider produces equivalent structured output", async () => {
    const provider = buildFakeProvider(specificPayload());
    const state = buildState();
    const first = await interpretRequirementFromText(provider, state, "The bracket must support 500 N.", { config: { modelId: "fake-v1" } });
    const second = await interpretRequirementFromText(provider, state, "The bracket must support 500 N.", { config: { modelId: "fake-v1" } });
    assert.equal(first.status, "success");
    assert.equal(second.status, "success");
    if (first.status !== "success" || second.status !== "success") return;
    assert.equal(first.candidate.description, second.candidate.description);
    assert.equal(first.candidate.operator, second.candidate.operator);
    assert.equal(first.candidate.value, second.candidate.value);
    assert.equal(first.candidate.unit, second.candidate.unit);
    assert.equal(first.candidate.interpretationStatus, second.candidate.interpretationStatus);
    assert.notEqual(first.candidate.id, second.candidate.id); // distinct records, equivalent content
  });
});

describe("interpretRequirementFromText: purity -- no World Model mutation", () => {
  it("the WorldModelState object is byte-for-byte unchanged after interpretation", async () => {
    const provider = buildFakeProvider(specificPayload());
    const state = buildState();
    const before = JSON.stringify(state);
    await interpretRequirementFromText(provider, state, "The bracket must support 500 N.", { config: { modelId: "fake-v1" } });
    assert.equal(JSON.stringify(state), before);
  });
});
