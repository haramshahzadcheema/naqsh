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
import { createToolRegistry, validateStructuredResult, type ModelProvider, type ToolRegistry } from "@naqsh/core";
import { generatePlanStepProposal } from "../src/proposal-service.js";

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
        relevantRequirementIds: ["req_1"],
        relevantConstraintIds: [],
        relevantObjectIds: ["obj_1"],
        relevantDecisionIds: []
      }
    ]
  });
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

function fakeProvider(): ModelProvider {
  const descriptor = createModelProviderDescriptor({ providerId: "fake", modelId: "fake-v1", supportsStructuredOutput: true });
  return {
    describe: () => descriptor,
    async generate(request: ModelRequest): Promise<ModelInvocationResult> {
      const structuredResult = {
        toolName: "modify_object",
        input: { objectId: "obj_1", propertyKey: "material", value: "aluminum_6061" },
        target: { entityType: "object", entityId: "obj_1" },
        rationale: "Aluminum satisfies the mass requirement.",
        expectedEffect: "The object's material property updates.",
        relevantRequirementIds: ["req_1"],
        relevantConstraintIds: []
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

const config = { modelId: "fake-v1" };

describe("apps/api proposal service: thin pass-through to @naqsh/core", () => {
  it("generatePlanStepProposal produces a proposed Proposal for a real plan step", async () => {
    const result = await generatePlanStepProposal(registryWithModifyObject(), fakeProvider(), richPlan(), "planstep_1", { config });
    assert.equal(result.status, "success");
    if (result.status !== "success") return;
    assert.equal(result.proposal.status, "proposed");
    assert.equal(result.proposal.toolName, "modify_object");
    assert.equal(result.proposal.planStepId, "planstep_1");
  });

  it("propagates rejection for a nonexistent plan step", async () => {
    const result = await generatePlanStepProposal(registryWithModifyObject(), fakeProvider(), richPlan(), "planstep_ghost", { config });
    assert.equal(result.status, "error");
  });

  it("REGRESSION: generating a proposal through this seam performs no tool execution and no World Model mutation", async () => {
    let called = false;
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
        called = true;
        return {};
      }
    );
    const plan = richPlan();
    const before = JSON.parse(JSON.stringify(plan));
    await generatePlanStepProposal(registry, fakeProvider(), plan, "planstep_1", { config });
    assert.equal(called, false, "generating a proposal must never execute the tool it proposes");
    assert.deepEqual(plan, before, "the originating Plan itself must remain unchanged");
  });
});
