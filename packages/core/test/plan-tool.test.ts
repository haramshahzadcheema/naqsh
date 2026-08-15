import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createModelInvocationResult,
  createModelProviderDescriptor,
  createModelResponse,
  createWorldModelState,
  type ModelInvocationResult,
  type ModelRequest,
  type WorldModelState
} from "@naqsh/schemas";
import { validateStructuredResult, type ModelProvider } from "../src/index.js";
import { createPlanningTool } from "../src/plan-tool.js";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry } from "../src/tool-registry.js";

function buildState(): WorldModelState {
  return createWorldModelState({
    project: {
      name: "Bracket Study",
      description: "x",
      objective: { summary: "Reduce mass by 20%." },
      requirements: [{ id: "req_1", description: "Max mass 350g" }],
      objects: [{ id: "obj_1", type: "part", name: "Bracket" }],
      relationships: [{ type: "satisfies", sourceType: "object", sourceId: "obj_1", targetType: "requirement", targetId: "req_1" }]
    },
    session: { focusObjectIds: ["obj_1"] }
  });
}

function wellFormedOutput(): Record<string, unknown> {
  return {
    steps: [
      {
        id: "step-1",
        title: "Select material",
        description: "x",
        purpose: "unblock geometry",
        dependsOn: [],
        inputs: [],
        expectedOutputs: [],
        relevantRequirementIds: ["req_1"],
        relevantConstraintIds: [],
        relevantObjectIds: ["obj_1"],
        relevantDecisionIds: [],
        verificationIntent: null,
        assumptionRefs: []
      }
    ],
    assumptions: [],
    unresolvedQuestions: [],
    risks: [],
    additionalMissingInformation: []
  };
}

/** A fake `ModelProvider` whose `respond` is configurable per test -- see
 * `planner.test.ts` for why this is hand-rolled rather than importing
 * `@naqsh/model-providers` (wrong dependency direction for this package). */
function fakeProvider(structuredResult: Record<string, unknown> | null = wellFormedOutput()): ModelProvider {
  const descriptor = createModelProviderDescriptor({ providerId: "fake", modelId: "fake-v1", supportsStructuredOutput: true });
  return {
    describe: () => descriptor,
    async generate(request: ModelRequest): Promise<ModelInvocationResult> {
      const startedAt = new Date().toISOString();
      if (structuredResult === null) {
        return createModelInvocationResult({
          requestId: request.id,
          providerId: descriptor.providerId,
          modelId: descriptor.modelId,
          status: "error",
          error: { kind: "provider_error", message: "simulated failure" },
          startedAt
        });
      }
      const response = createModelResponse({ requestId: request.id, kind: "structured_result", structuredResult });
      const schemaErrors = validateStructuredResult(response, request);
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
      return createModelInvocationResult({
        requestId: request.id,
        providerId: descriptor.providerId,
        modelId: descriptor.modelId,
        status: "success",
        response,
        startedAt
      });
    }
  };
}

function buildRegistry(getState: () => WorldModelState, provider: ModelProvider = fakeProvider()) {
  const registry = createToolRegistry();
  const { tool, handler } = createPlanningTool(getState, provider);
  registry.register(tool, handler);
  return registry;
}

describe("createPlanningTool: identity and classification", () => {
  it("is classified suggest/world_model -- zero mutation, but a proposal, unlike observe_project's pure read", () => {
    const { tool } = createPlanningTool(() => buildState(), fakeProvider());
    assert.equal(tool.mutation, "suggest");
    assert.equal(tool.target, "world_model");
    assert.equal(tool.name, "create_plan");
  });

  it("declares a typed input schema and a typed output schema", () => {
    const { tool } = createPlanningTool(() => buildState(), fakeProvider());
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.outputSchema.type, "object");
  });
});

describe("createPlanningTool: valid calls reach the planner", () => {
  it("produces a proposed Plan through executeTool", async () => {
    const registry = buildRegistry(() => buildState());
    const { result } = await executeTool(registry, { toolName: "create_plan", input: { modelId: "fake-v1" } });
    assert.equal(result.status, "success");
    const output = result.output as { status: string; steps: unknown[] };
    assert.equal(output.status, "proposed");
    assert.equal(output.steps.length, 1);
  });

  it("scope 'object' plans against exactly the named object's one-hop context", async () => {
    const registry = buildRegistry(() => buildState());
    const { result } = await executeTool(registry, {
      toolName: "create_plan",
      input: { modelId: "fake-v1", scope: "object", objectId: "obj_1" }
    });
    assert.equal(result.status, "success");
  });

  it("reads state fresh via getState() on every call -- not a captured snapshot", async () => {
    let callCount = 0;
    const registry = buildRegistry(() => {
      callCount++;
      return buildState();
    });
    await executeTool(registry, { toolName: "create_plan", input: { modelId: "fake-v1" } });
    await executeTool(registry, { toolName: "create_plan", input: { modelId: "fake-v1" } });
    assert.equal(callCount, 2);
  });
});

describe("createPlanningTool: input validation", () => {
  it("rejects a missing modelId with invalid_input, before the handler calls the model", async () => {
    const registry = buildRegistry(() => buildState());
    const { result } = await executeTool(registry, { toolName: "create_plan", input: {} });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("rejects scope:'object' with a missing objectId", async () => {
    const registry = buildRegistry(() => buildState());
    const { result } = await executeTool(registry, { toolName: "create_plan", input: { modelId: "fake-v1", scope: "object" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("maps a nonexistent objectId (ObservationError) onto ToolError invalid_input", async () => {
    const registry = buildRegistry(() => buildState());
    const { result } = await executeTool(registry, {
      toolName: "create_plan",
      input: { modelId: "fake-v1", scope: "object", objectId: "does_not_exist" }
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("maps a model-unavailable failure onto ToolError 'unavailable'", async () => {
    const registry = buildRegistry(() => buildState(), fakeProvider(null));
    const { result } = await executeTool(registry, { toolName: "create_plan", input: { modelId: "fake-v1" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "unavailable");
  });

  it("REGRESSION: maps a semantic-validation failure (hallucinated id) onto ToolError 'execution_failure', never silently succeeding", async () => {
    const hallucinated = wellFormedOutput();
    (hallucinated.steps as Record<string, unknown>[])[0]!.relevantRequirementIds = ["req_made_up"];
    const registry = buildRegistry(() => buildState(), fakeProvider(hallucinated));
    const { result } = await executeTool(registry, { toolName: "create_plan", input: { modelId: "fake-v1" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "execution_failure");
  });
});

describe("createPlanningTool: non-mutation guarantee", () => {
  it("never mutates the WorldModelState returned by getState", async () => {
    const state = buildState();
    const before = JSON.parse(JSON.stringify(state));
    const registry = buildRegistry(() => state);
    await executeTool(registry, { toolName: "create_plan", input: { modelId: "fake-v1" } });
    assert.deepEqual(state, before);
  });

  it("the tool's mutation classification IS \"suggest\" -- a future authorize hook can gate on this without inspecting behavior", () => {
    const { tool } = createPlanningTool(() => buildState(), fakeProvider());
    assert.equal(tool.mutation, "suggest");
  });
});

describe("createPlanningTool: auditability", () => {
  it("every call produces a ToolRequest/ToolResult pair with a stable requestId, like any other tool", async () => {
    const registry = buildRegistry(() => buildState());
    const { request, result } = await executeTool(registry, { toolName: "create_plan", input: { modelId: "fake-v1" } });
    assert.equal(result.requestId, request.id);
    assert.equal(result.toolName, "create_plan");
  });
});
