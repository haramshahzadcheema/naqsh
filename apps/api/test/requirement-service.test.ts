import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createModelInvocationResult, createModelProviderDescriptor, createModelResponse, createWorldModelState, type ModelInvocationResult, type ModelRequest, type WorldModelState } from "@naqsh/schemas";
import { validateStructuredResult, type ModelProvider } from "@naqsh/core";
import { interpretUserRequirement } from "../src/requirement-service.js";

function buildState(): WorldModelState {
  return createWorldModelState({ project: { id: "proj_1", name: "Bracket Study" }, session: {} });
}

function fakeProvider(): ModelProvider {
  const descriptor = createModelProviderDescriptor({ providerId: "fake", modelId: "fake-v1", supportsStructuredOutput: true });
  return {
    describe: () => descriptor,
    async generate(request: ModelRequest): Promise<ModelInvocationResult> {
      const structuredResult = {
        description: "Load capacity must be at least 500 N.",
        category: "load",
        interpretationStatus: "specific",
        operator: "gte",
        value: 500,
        unit: "N",
        ambiguityReason: null
      };
      const response = createModelResponse({ requestId: request.id, kind: "structured_result", structuredResult });
      const schemaErrors = validateStructuredResult(response, request);
      const startedAt = new Date().toISOString();
      if (schemaErrors.length > 0) {
        return createModelInvocationResult({
          requestId: request.id,
          providerId: descriptor.providerId,
          modelId: descriptor.modelId,
          status: "error",
          error: { kind: "schema_validation_failed", message: schemaErrors.join("; ") },
          startedAt
        });
      }
      return createModelInvocationResult({ requestId: request.id, providerId: descriptor.providerId, modelId: descriptor.modelId, status: "success", response, startedAt });
    }
  };
}

const config = { modelId: "fake-v1" };

describe("apps/api requirement service: thin pass-through to @naqsh/core", () => {
  it("interpretUserRequirement produces a structured candidate for a real statement", async () => {
    const result = await interpretUserRequirement(fakeProvider(), buildState(), "The bracket must support 500 N.", { config });
    assert.equal(result.status, "success");
    if (result.status !== "success") return;
    assert.equal(result.candidate.interpretationStatus, "specific");
    assert.equal(result.candidate.value, 500);
  });

  it("propagates a rejection for empty statement text", async () => {
    const result = await interpretUserRequirement(fakeProvider(), buildState(), "", { config });
    assert.equal(result.status, "error");
  });

  it("REGRESSION: interpreting a requirement through this seam performs no World Model mutation", async () => {
    const state = buildState();
    const before = JSON.stringify(state);
    await interpretUserRequirement(fakeProvider(), state, "The bracket must support 500 N.", { config });
    assert.equal(JSON.stringify(state), before, "the originating WorldModelState must remain unchanged");
  });
});
