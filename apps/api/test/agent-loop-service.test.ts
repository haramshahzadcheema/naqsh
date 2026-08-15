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
import {
  createApprovalStore,
  createAutonomyGrantStore,
  createChangeHistory,
  createModifyObjectTool,
  createToolRegistry,
  validateStructuredResult,
  type ApprovalStore,
  type AutonomyGrantStore,
  type ModelProvider,
  type ToolRegistry
} from "@naqsh/core";
import { continueAgentLoopRun, startAgentLoopRun } from "../src/agent-loop-service.js";

function buildState(): WorldModelState {
  return createWorldModelState({
    project: {
      name: "Bracket Study",
      description: "x",
      objective: { summary: "Reduce mass by 20%." },
      requirements: [{ id: "req_mass", description: "Max mass 350g" }],
      objects: [{ id: "obj_bracket", type: "part", name: "Bracket", properties: { material: "steel" } }]
    },
    session: {}
  });
}

function fakeProvider(): ModelProvider {
  const descriptor = createModelProviderDescriptor({ providerId: "fake", modelId: "fake-v1", supportsStructuredOutput: true });
  return {
    describe: () => descriptor,
    async generate(request: ModelRequest): Promise<ModelInvocationResult> {
      const startedAt = new Date().toISOString();
      const schema = request.outputSchema as { properties?: Record<string, unknown> } | null;
      const isProposalRequest = !!schema?.properties && "toolName" in schema.properties;
      const structuredResult = isProposalRequest
        ? {
            toolName: "modify_object",
            input: { objectId: "obj_bracket", propertyKey: "material", value: "aluminum_6061" },
            target: { entityType: "object", entityId: "obj_bracket" },
            rationale: "Aluminum satisfies the mass requirement.",
            expectedEffect: "The bracket's material property updates to aluminum 6061.",
            relevantRequirementIds: ["req_mass"],
            relevantConstraintIds: []
          }
        : {
            steps: [
              {
                id: "step-1",
                title: "Select material",
                description: "x",
                purpose: "x",
                dependsOn: [],
                inputs: [],
                expectedOutputs: [],
                relevantRequirementIds: ["req_mass"],
                relevantConstraintIds: [],
                relevantObjectIds: ["obj_bracket"],
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
      const response = createModelResponse({ requestId: request.id, kind: "structured_result", structuredResult });
      const schemaErrors = validateStructuredResult(response, request);
      return createModelInvocationResult({
        requestId: request.id,
        providerId: descriptor.providerId,
        modelId: descriptor.modelId,
        status: schemaErrors.length > 0 ? "error" : "success",
        response: schemaErrors.length > 0 ? undefined : response,
        error: schemaErrors.length > 0 ? { kind: "schema_validation_failed", message: schemaErrors.join("; ") } : undefined,
        startedAt
      });
    }
  };
}

interface Harness {
  getState: () => WorldModelState;
  registry: ToolRegistry;
  approvals: ApprovalStore;
  autonomyGrants: AutonomyGrantStore;
  provider: ModelProvider;
}

function buildHarness(): Harness {
  let state = buildState();
  const history = createChangeHistory();
  const registry = createToolRegistry();
  const { tool, handler } = createModifyObjectTool(
    () => state,
    (next) => {
      state = next;
    },
    history
  );
  registry.register(tool, handler);
  return {
    getState: () => state,
    registry,
    approvals: createApprovalStore(),
    autonomyGrants: createAutonomyGrantStore(),
    provider: fakeProvider()
  };
}

const config = { modelId: "fake-v1" };

describe("apps/api agent-loop service: thin pass-through to @naqsh/core", () => {
  it("startAgentLoopRun produces a run awaiting approval", async () => {
    const h = buildHarness();
    const result = await startAgentLoopRun({
      getState: h.getState,
      observe: { scope: "project" },
      provider: h.provider,
      registry: h.registry,
      approvals: h.approvals,
      planOptions: { config },
      proposalOptions: { config }
    });
    assert.equal(result.status, "success");
    if (result.status !== "success") return;
    assert.equal(result.run.status, "awaiting_approval");
  });

  it("continueAgentLoopRun executes an approved run through the real @naqsh/core boundary", async () => {
    const h = buildHarness();
    const begin = await startAgentLoopRun({
      getState: h.getState,
      observe: { scope: "project" },
      provider: h.provider,
      registry: h.registry,
      approvals: h.approvals,
      planOptions: { config },
      proposalOptions: { config }
    });
    if (begin.status !== "success") return assert.fail();
    h.approvals.approve(begin.run.approval!.id, "human");

    const resumed = await continueAgentLoopRun({
      run: begin.run,
      getState: h.getState,
      registry: h.registry,
      approvals: h.approvals,
      autonomyGrants: h.autonomyGrants,
      autonomyLevel: "approved_modify"
    });
    assert.equal(resumed.status, "success");
    if (resumed.status !== "success") return;
    assert.equal(resumed.run.status, "completed");
    assert.equal(h.getState().project.objects[0]!.properties.material, "aluminum_6061");
  });

  it("REGRESSION: a rejected run performs zero mutation through this seam either", async () => {
    const h = buildHarness();
    const before = h.getState();
    const begin = await startAgentLoopRun({
      getState: h.getState,
      observe: { scope: "project" },
      provider: h.provider,
      registry: h.registry,
      approvals: h.approvals,
      planOptions: { config },
      proposalOptions: { config }
    });
    if (begin.status !== "success") return assert.fail();
    h.approvals.reject(begin.run.approval!.id, "human");

    const resumed = await continueAgentLoopRun({
      run: begin.run,
      getState: h.getState,
      registry: h.registry,
      approvals: h.approvals,
      autonomyGrants: h.autonomyGrants,
      autonomyLevel: "approved_modify"
    });
    assert.equal(resumed.status, "success");
    if (resumed.status !== "success") return;
    assert.equal(resumed.run.status, "rejected");
    assert.deepEqual(h.getState(), before);
  });
});
