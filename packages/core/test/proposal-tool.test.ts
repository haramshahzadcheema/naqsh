import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createModelInvocationResult,
  createModelProviderDescriptor,
  createModelResponse,
  createPlan,
  createTool,
  type ModelInvocationResult,
  type ModelRequest,
  type Plan
} from "@naqsh/schemas";
import { validateStructuredResult, type ModelProvider } from "../src/index.js";
import { createProposalTool } from "../src/proposal-tool.js";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry, type ToolRegistry } from "../src/tool-registry.js";
import { createExecuteToolAuthorizer } from "../src/authorization.js";
import { createApprovalStore } from "../src/approval-store.js";
import { createAutonomyGrantStore } from "../src/autonomy-grant-store.js";

function richPlan(): Plan {
  return createPlan({
    projectId: "proj_1",
    projectVersion: 1,
    observationId: "obs_1",
    objectiveSummary: "Reduce mass by 20%.",
    steps: [
      {
        id: "planstep_1",
        title: "Select material",
        description: "x",
        purpose: "unblock geometry",
        relevantRequirementIds: ["req_mass"],
        relevantConstraintIds: [],
        relevantObjectIds: ["obj_bracket"],
        relevantDecisionIds: []
      }
    ]
  });
}

function wellFormedOutput(): Record<string, unknown> {
  return {
    toolName: "modify_object",
    input: { objectId: "obj_bracket", propertyKey: "material", value: "aluminum_6061" },
    target: { entityType: "object", entityId: "obj_bracket" },
    rationale: "Aluminum satisfies the mass requirement.",
    expectedEffect: "The bracket's material property updates.",
    relevantRequirementIds: ["req_mass"],
    relevantConstraintIds: []
  };
}

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

function registryWithModifyObject(): ToolRegistry {
  const registry = createToolRegistry();
  registry.register(
    createTool({
      name: "modify_object",
      target: "world_model",
      mutation: "mutate",
      inputSchema: {
        type: "object",
        properties: { objectId: { type: "string" }, propertyKey: { type: "string" }, value: { type: "string" } },
        required: ["objectId", "propertyKey", "value"]
      },
      outputSchema: { type: "object", properties: {} }
    }),
    () => ({})
  );
  return registry;
}

function buildToolRegistry(registry: ToolRegistry = registryWithModifyObject(), provider: ModelProvider = fakeProvider()) {
  const { tool, handler } = createProposalTool(registry, provider);
  const toolRegistry = createToolRegistry();
  toolRegistry.register(tool, handler);
  return toolRegistry;
}

describe("createProposalTool: identity and classification", () => {
  it("is classified suggest/world_model -- zero mutation, mirroring create_plan's own tier", () => {
    const { tool } = createProposalTool(registryWithModifyObject(), fakeProvider());
    assert.equal(tool.mutation, "suggest");
    assert.equal(tool.target, "world_model");
    assert.equal(tool.name, "create_proposal");
  });

  it("declares a typed input schema and a typed output schema", () => {
    const { tool } = createProposalTool(registryWithModifyObject(), fakeProvider());
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.outputSchema.type, "object");
  });
});

describe("createProposalTool: valid calls reach the proposal generator", () => {
  it("produces a proposed Proposal through executeTool", async () => {
    const registry = buildToolRegistry();
    const { result } = await executeTool(registry, {
      toolName: "create_proposal",
      input: { plan: richPlan(), planStepId: "planstep_1", modelId: "fake-v1" }
    });
    assert.equal(result.status, "success");
    const output = result.output as { status: string; toolName: string };
    assert.equal(output.status, "proposed");
    assert.equal(output.toolName, "modify_object");
  });
});

describe("createProposalTool: input validation", () => {
  it("rejects a missing modelId with invalid_input, before the handler calls the model", async () => {
    const registry = buildToolRegistry();
    const { result } = await executeTool(registry, {
      toolName: "create_proposal",
      input: { plan: richPlan(), planStepId: "planstep_1" }
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("rejects a missing planStepId", async () => {
    const registry = buildToolRegistry();
    const { result } = await executeTool(registry, {
      toolName: "create_proposal",
      input: { plan: richPlan(), modelId: "fake-v1" }
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("rejects a malformed plan (not a real, schema-valid Plan)", async () => {
    const registry = buildToolRegistry();
    const { result } = await executeTool(registry, {
      toolName: "create_proposal",
      input: { plan: { not: "a plan" }, planStepId: "planstep_1", modelId: "fake-v1" }
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("maps a nonexistent planStepId onto ToolError invalid_input", async () => {
    const registry = buildToolRegistry();
    const { result } = await executeTool(registry, {
      toolName: "create_proposal",
      input: { plan: richPlan(), planStepId: "planstep_ghost", modelId: "fake-v1" }
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("maps a model-unavailable failure onto ToolError 'unavailable'", async () => {
    const registry = buildToolRegistry(registryWithModifyObject(), fakeProvider(null));
    const { result } = await executeTool(registry, {
      toolName: "create_proposal",
      input: { plan: richPlan(), planStepId: "planstep_1", modelId: "fake-v1" }
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "unavailable");
  });

  it("REGRESSION: maps a semantic-validation failure (hallucinated tool name) onto ToolError 'execution_failure', never silently succeeding", async () => {
    const hallucinated = { ...wellFormedOutput(), toolName: "delete_everything" };
    const registry = buildToolRegistry(registryWithModifyObject(), fakeProvider(hallucinated));
    const { result } = await executeTool(registry, {
      toolName: "create_proposal",
      input: { plan: richPlan(), planStepId: "planstep_1", modelId: "fake-v1" }
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "execution_failure");
  });
});

describe("createProposalTool: non-mutation and non-execution guarantees", () => {
  it("REGRESSION: never invokes the registered tool the proposal names -- 'modify_object' is never actually called", async () => {
    let modifyObjectCalled = false;
    const registry = createToolRegistry();
    registry.register(
      createTool({
        name: "modify_object",
        target: "world_model",
        mutation: "mutate",
        inputSchema: {
          type: "object",
          properties: { objectId: { type: "string" }, propertyKey: { type: "string" }, value: { type: "string" } },
          required: ["objectId", "propertyKey", "value"]
        },
        outputSchema: { type: "object", properties: {} }
      }),
      () => {
        modifyObjectCalled = true;
        return {};
      }
    );
    const toolRegistry = buildToolRegistry(registry);
    await executeTool(toolRegistry, {
      toolName: "create_proposal",
      input: { plan: richPlan(), planStepId: "planstep_1", modelId: "fake-v1" }
    });
    assert.equal(modifyObjectCalled, false, "creating a proposal must never execute the tool it proposes");
  });

  it("the tool's mutation classification IS \"suggest\" -- a future authorize hook can gate on this without inspecting behavior", () => {
    const { tool } = createProposalTool(registryWithModifyObject(), fakeProvider());
    assert.equal(tool.mutation, "suggest");
  });
});

describe("createProposalTool: auditability", () => {
  it("every call produces a ToolRequest/ToolResult pair with a stable requestId, like any other tool", async () => {
    const registry = buildToolRegistry();
    const { request, result } = await executeTool(registry, {
      toolName: "create_proposal",
      input: { plan: richPlan(), planStepId: "planstep_1", modelId: "fake-v1" }
    });
    assert.equal(result.requestId, request.id);
    assert.equal(result.toolName, "create_proposal");
  });
});

describe("createProposalTool: permission enforcement (against the real P4 authorization engine, not just a static assertion)", () => {
  it("is DENIED at autonomy level 'observe' -- 'suggest' tools require at least the 'suggest' tier", async () => {
    const registry = buildToolRegistry();
    const authorize = createExecuteToolAuthorizer({
      autonomyLevel: "observe",
      approvals: createApprovalStore(),
      autonomyGrants: createAutonomyGrantStore()
    });
    const { result } = await executeTool(registry, {
      toolName: "create_proposal",
      input: { plan: richPlan(), planStepId: "planstep_1", modelId: "fake-v1" },
      authorize
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "policy_rejected");
  });

  it("is ALLOWED at autonomy level 'suggest' with NO Approval or AutonomyGrant needed -- creating a proposal never implicitly grants modification authority", async () => {
    const registry = buildToolRegistry();
    const authorize = createExecuteToolAuthorizer({
      autonomyLevel: "suggest",
      // Deliberately empty stores: if create_proposal required an approval
      // or grant the way a "mutate" tool does, this call would be denied.
      approvals: createApprovalStore(),
      autonomyGrants: createAutonomyGrantStore()
    });
    const { result } = await executeTool(registry, {
      toolName: "create_proposal",
      input: { plan: richPlan(), planStepId: "planstep_1", modelId: "fake-v1" },
      authorize
    });
    assert.equal(result.status, "success");
  });

  it("remains ALLOWED at the highest autonomy level too, still with no approval/grant required", async () => {
    const registry = buildToolRegistry();
    const authorize = createExecuteToolAuthorizer({
      autonomyLevel: "autonomous",
      approvals: createApprovalStore(),
      autonomyGrants: createAutonomyGrantStore()
    });
    const { result } = await executeTool(registry, {
      toolName: "create_proposal",
      input: { plan: richPlan(), planStepId: "planstep_1", modelId: "fake-v1" },
      authorize
    });
    assert.equal(result.status, "success");
  });
});
