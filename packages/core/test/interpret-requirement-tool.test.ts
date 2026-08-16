import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createModelInvocationResult,
  createModelProviderDescriptor,
  createModelResponse,
  createWorldModelState,
  type RequirementCandidate,
  type WorldModelState
} from "@naqsh/schemas";
import { createInterpretRequirementTool } from "../src/interpret-requirement-tool.js";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry } from "../src/tool-registry.js";
import { validateStructuredResult, type ModelProvider } from "../src/index.js";

function buildState(): WorldModelState {
  return createWorldModelState({ project: { id: "proj_1", name: "Bracket Study" }, session: {} });
}

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

function buildHarness(structuredResult: Record<string, unknown>) {
  const state = buildState();
  const provider = buildFakeProvider(structuredResult);
  const registry = createToolRegistry();
  const { tool, handler } = createInterpretRequirementTool(() => state, provider);
  registry.register(tool, handler);
  return { registry, state };
}

describe("createInterpretRequirementTool: identity and classification", () => {
  it("is classified suggest/world_model -- interpreting text never mutates the World Model", () => {
    const { registry } = buildHarness({});
    const tool = registry.getByName("interpret_requirement")!;
    assert.equal(tool.mutation, "suggest");
    assert.equal(tool.target, "world_model");
  });
});

describe("createInterpretRequirementTool: successful interpretation", () => {
  it("returns a structured, specific candidate", async () => {
    const { registry } = buildHarness({
      description: "Load capacity must be at least 500 N.",
      category: "load",
      interpretationStatus: "specific",
      operator: "gte",
      value: 500,
      unit: "N",
      ambiguityReason: null
    });
    const { result } = await executeTool(registry, { toolName: "interpret_requirement", input: { statementText: "The bracket must support 500 N.", modelId: "fake-v1" } });
    assert.equal(result.status, "success");
    const candidate = result.output as RequirementCandidate;
    assert.equal(candidate.interpretationStatus, "specific");
    assert.equal(candidate.value, 500);
  });

  it("returns an ambiguous candidate honestly, never a fabricated threshold", async () => {
    const { registry } = buildHarness({
      description: "Should be lightweight.",
      category: "mass",
      interpretationStatus: "ambiguous",
      operator: null,
      value: null,
      unit: null,
      ambiguityReason: "No specific mass target was given."
    });
    const { result } = await executeTool(registry, { toolName: "interpret_requirement", input: { statementText: "Make it lightweight.", modelId: "fake-v1" } });
    assert.equal(result.status, "success");
    const candidate = result.output as RequirementCandidate;
    assert.equal(candidate.interpretationStatus, "ambiguous");
    assert.equal(candidate.value, null);
  });
});

describe("createInterpretRequirementTool: input validation", () => {
  it("rejects a missing statementText", async () => {
    const { registry } = buildHarness({});
    const { result } = await executeTool(registry, { toolName: "interpret_requirement", input: { modelId: "fake-v1" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("rejects a missing modelId", async () => {
    const { registry } = buildHarness({});
    const { result } = await executeTool(registry, { toolName: "interpret_requirement", input: { statementText: "The bracket must support 500 N." } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });
});

describe("createInterpretRequirementTool: model failure surfaces as a structured tool error, never a fabricated candidate", () => {
  it("malformed model output surfaces as execution_failure/unavailable, not a success result", async () => {
    const { registry } = buildHarness({ description: "x" }); // missing required fields
    const { result } = await executeTool(registry, { toolName: "interpret_requirement", input: { statementText: "The bracket must support 500 N.", modelId: "fake-v1" } });
    assert.equal(result.status, "error");
  });
});

describe("createInterpretRequirementTool: purity", () => {
  it("never mutates the World Model", async () => {
    const { registry, state } = buildHarness({
      description: "Load capacity must be at least 500 N.",
      category: "load",
      interpretationStatus: "specific",
      operator: "gte",
      value: 500,
      unit: "N",
      ambiguityReason: null
    });
    const before = JSON.stringify(state);
    await executeTool(registry, { toolName: "interpret_requirement", input: { statementText: "The bracket must support 500 N.", modelId: "fake-v1" } });
    assert.equal(JSON.stringify(state), before);
  });
});
