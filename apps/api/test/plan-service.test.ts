import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createModelInvocationResult,
  createModelProviderDescriptor,
  createModelResponse,
  createWorldModelState,
  type ModelInvocationResult,
  type ModelRequest
} from "@naqsh/schemas";
import { validateStructuredResult, type ModelProvider } from "@naqsh/core";
import {
  generateFocusedPlan,
  generateObjectPlan,
  generateWholeProjectPlan,
  inspectPlanStep,
  inspectPlanSummary,
  inspectStepDependencies
} from "../src/plan-service.js";

function buildState() {
  return createWorldModelState({
    project: {
      name: "Bracket Study",
      description: "x",
      objective: { summary: "Design a lightweight bracket." },
      requirements: [{ id: "req_1", description: "Must be lightweight." }],
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
      },
      {
        id: "step-2",
        title: "Draft geometry",
        description: "x",
        purpose: "produce a first pass",
        dependsOn: ["step-1"],
        inputs: [],
        expectedOutputs: [],
        relevantRequirementIds: [],
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

/** A hand-rolled `ModelProvider` -- apps/api has no dependency on
 * `@naqsh/model-providers` (nor should it need one just to test a thin
 * pass-through service), so this mirrors the same fake used in
 * `packages/core/test/planner.test.ts`. */
function fakeProvider(): ModelProvider {
  const descriptor = createModelProviderDescriptor({ providerId: "fake", modelId: "fake-v1", supportsStructuredOutput: true });
  return {
    describe: () => descriptor,
    async generate(request: ModelRequest): Promise<ModelInvocationResult> {
      const startedAt = new Date().toISOString();
      const response = createModelResponse({ requestId: request.id, kind: "structured_result", structuredResult: wellFormedOutput() });
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

const config = { modelId: "fake-v1" };

describe("apps/api plan service: thin pass-through to @naqsh/core", () => {
  it("generateWholeProjectPlan produces a proposed plan scoped to the whole project", async () => {
    const result = await generateWholeProjectPlan(buildState(), fakeProvider(), { config });
    assert.equal(result.status, "success");
    if (result.status !== "success") return;
    assert.equal(result.plan.status, "proposed");
    assert.equal(result.plan.steps.length, 2);
  });

  it("generateFocusedPlan produces a plan scoped to the session's focused objects", async () => {
    const result = await generateFocusedPlan(buildState(), fakeProvider(), { config });
    assert.equal(result.status, "success");
  });

  it("generateObjectPlan produces a plan scoped to exactly the named object", async () => {
    const result = await generateObjectPlan(buildState(), fakeProvider(), "obj_1", { config });
    assert.equal(result.status, "success");
  });

  it("generateObjectPlan propagates a not-found failure for an unknown object id", () => {
    // Matches observeObject's own documented precedent (observation-service.test.ts):
    // scope:"object" with a nonexistent id is an explicit-lookup-miss hard
    // failure, thrown synchronously by observeProject before generatePlanProposal
    // is ever reached -- not surfaced as an awaited { status: "error" } result.
    assert.throws(() => generateObjectPlan(buildState(), fakeProvider(), "does_not_exist", { config }));
  });

  it("inspectPlanSummary/inspectPlanStep/inspectStepDependencies expose the generated plan's structure", async () => {
    const result = await generateWholeProjectPlan(buildState(), fakeProvider(), { config });
    assert.equal(result.status, "success");
    if (result.status !== "success") return;

    const summary = inspectPlanSummary(result.plan);
    assert.equal(summary.stepCount, 2);

    const firstStepId = result.plan.steps[0]!.id;
    const secondStepId = result.plan.steps[1]!.id;

    const step = inspectPlanStep(result.plan, firstStepId);
    assert.equal(step?.title, "Select material");

    const dependencyContext = inspectStepDependencies(result.plan, secondStepId);
    assert.equal(dependencyContext.dependencies.length, 1);
    assert.equal(dependencyContext.dependencies[0]?.id, firstStepId);

    const dependentContext = inspectStepDependencies(result.plan, firstStepId);
    assert.equal(dependentContext.dependents.length, 1);
    assert.equal(dependentContext.dependents[0]?.id, secondStepId);
  });

  it("REGRESSION: generating a plan through this seam does not mutate the WorldModelState", async () => {
    const state = buildState();
    const before = JSON.parse(JSON.stringify(state));
    await generateWholeProjectPlan(state, fakeProvider(), { config });
    assert.deepEqual(state, before);
  });
});
