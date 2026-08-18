import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createModelInvocationResult,
  createModelProviderDescriptor,
  createModelResponse,
  createWorldModelState,
  UNAVAILABLE_ENVIRONMENT_GEOMETRY,
  type Clarification,
  type EnvironmentObject,
  type EnvironmentOperationResult,
  type EnvironmentSession,
  type RequirementCandidate,
  type ToolValueSchema,
  type WorldModelState
} from "@naqsh/schemas";
import { interpretRequirementFromText } from "../src/requirement-interpreter.js";
import { createAddRequirementTool } from "../src/add-requirement-tool.js";
import { createAnalyzeRequirementCompletenessTool } from "../src/analyze-requirement-completeness-tool.js";
import { createClarificationStore } from "../src/clarification-store.js";
import { observeProject } from "../src/observe-project.js";
import { generatePlanProposal } from "../src/planner.js";
import { generateDesignSpecification } from "../src/design-generator.js";
import { createDesignSpecificationStore } from "../src/design-specification-store.js";
import { executeBuildForDesignSpecification } from "../src/build-executor.js";
import { createBuildResultStore } from "../src/build-result-store.js";
import { createCreateEnvironmentObjectTool } from "../src/create-environment-object-tool.js";
import { createCreateCheckTool } from "../src/create-check-tool.js";
import { createRunVerificationTool } from "../src/run-verification-tool.js";
import { createEvaluateObjectiveSatisfactionTool } from "../src/evaluate-objective-satisfaction-tool.js";
import { createCheckStore } from "../src/check-store.js";
import { createVerificationResultStore } from "../src/verification-result-store.js";
import { createObjectiveSatisfactionStore } from "../src/objective-satisfaction-store.js";
import { createChangeHistory } from "../src/change-history.js";
import { createApprovalStore } from "../src/approval-store.js";
import { createAutonomyGrantStore } from "../src/autonomy-grant-store.js";
import { createExecuteToolAuthorizer } from "../src/authorization.js";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry } from "../src/tool-registry.js";
import { validateStructuredResult, type ModelProvider } from "../src/index.js";
import type { EnvironmentAdapter } from "../src/environment-adapter.js";

/**
 * PHASE 20 END-TO-END: proves the complete
 *   Intent -> P18 -> P19 -> Plan -> Design -> Approval -> Build -> Observe
 *   -> Verify -> Objective Satisfaction
 * flow, entirely through EXISTING, UNMODIFIED phase machinery (P18/P9/P16/
 * P17 reused as-is) plus P20's own new pieces (design generation, build).
 *
 * ONE routed fake ModelProvider stands in for Gemini across all THREE
 * distinct structured-output calls this flow makes (P18's requirement
 * interpretation, P9's plan generation, P20's design generation) --
 * dispatched by which output schema each call actually requests, the same
 * "never a hand-waved mock that skips schema validation" discipline every
 * other fake provider in this codebase already follows.
 */
function schemaHasProperty(schema: ToolValueSchema | null, property: string): boolean {
  return !!schema && typeof schema === "object" && "properties" in schema && !!(schema.properties as Record<string, unknown> | undefined)?.[property];
}

function buildRoutedFakeProvider(routes: { requirement: Record<string, unknown>; plan: Record<string, unknown>; design: Record<string, unknown> }): ModelProvider {
  return {
    describe: () => createModelProviderDescriptor({ providerId: "fake", modelId: "fake-v1", supportsStructuredOutput: true }),
    async generate(request) {
      let structuredResult: Record<string, unknown>;
      if (schemaHasProperty(request.outputSchema, "interpretationStatus")) {
        structuredResult = routes.requirement;
      } else if (schemaHasProperty(request.outputSchema, "steps")) {
        structuredResult = routes.plan;
      } else if (schemaHasProperty(request.outputSchema, "expectedOutputs")) {
        structuredResult = routes.design;
      } else {
        throw new Error("test fake provider received an unrecognized outputSchema");
      }
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

function buildFakeEnvironmentAdapter(objects: Map<string, EnvironmentObject>): EnvironmentAdapter {
  const now = () => new Date().toISOString();
  const session: EnvironmentSession = { id: "sess_1", environmentKind: "fake", status: "connected", documentName: null, openedAt: now(), metadata: {} };
  let nextId = 1;
  function ok(operation: EnvironmentOperationResult["operation"], data: unknown): EnvironmentOperationResult {
    return { id: `envop_${Math.random()}`, operation, sessionId: session.id, objectId: null, status: "success", data, error: null, startedAt: now(), completedAt: now(), metadata: {} };
  }
  function err(operation: EnvironmentOperationResult["operation"], kind: "unsupported_capability" | "object_not_found", message: string): EnvironmentOperationResult {
    return { id: `envop_${Math.random()}`, operation, sessionId: session.id, objectId: null, status: "error", data: null, error: { kind, message }, startedAt: now(), completedAt: now(), metadata: {} };
  }
  return {
    describe: () => ({ kind: "fake", name: "Fake Environment", version: "0.0.1", capabilities: ["create"], metadata: {} }),
    health: async () => ok("health", { status: "healthy", message: "", checkedAt: now() }),
    connect: async () => ok("connect", session),
    disconnect: async () => ok("disconnect", null),
    listObjects: async () => ok("list_objects", [...objects.values()]),
    inspectObject: async (_session, objectId) => (objects.has(objectId) ? ok("inspect_object", objects.get(objectId)) : err("inspect_object", "object_not_found", "no such object")),
    createObject: async (_session, input) => {
      const id = `envobj_${nextId++}`;
      const object: EnvironmentObject = {
        id,
        type: input.type,
        name: input.name,
        genericType: input.genericType ?? "unknown",
        parentId: input.parentId ?? null,
        visible: input.visible ?? null,
        geometry: UNAVAILABLE_ENVIRONMENT_GEOMETRY,
        properties: (input.properties ?? []).map((p) => ({ key: p.key, value: p.value, readOnly: p.readOnly ?? false })),
        relationships: [],
        metadata: input.metadata ?? {}
      };
      objects.set(id, object);
      return ok("create_object", object);
    },
    modifyObject: async () => err("modify_object", "unsupported_capability", "not used"),
    deleteObject: async () => err("delete_object", "unsupported_capability", "not used"),
    inspectDocument: async () => err("inspect_document", "unsupported_capability", "not used"),
    save: async () => ok("save", null),
    checkpoint: async () => ok("checkpoint", { checkpointId: "chk_1" }),
    restore: async () => ok("restore", null)
  };
}

const requirementPayload = {
  description: "Load capacity must be at least 500 N, applied vertically.",
  category: "load",
  interpretationStatus: "specific",
  operator: "gte",
  value: 500,
  unit: "N",
  ambiguityReason: null
};

const planPayload = {
  steps: [
    {
      id: "step_1",
      title: "Design mounting plate",
      description: "Design a rectangular mounting plate sized for the 500 N load.",
      purpose: "Provide the primary load-bearing surface.",
      dependsOn: [],
      inputs: [],
      expectedOutputs: ["A mounting plate design"],
      relevantRequirementIds: ["__REQ_ID__"],
      relevantConstraintIds: [],
      relevantObjectIds: [],
      relevantDecisionIds: [],
      verificationIntent: "The built plate's Length property should be 100.",
      assumptionRefs: []
    }
  ],
  assumptions: [],
  unresolvedQuestions: [],
  risks: [],
  additionalMissingInformation: []
};

const designPayload = {
  description: "A rectangular aluminum mounting plate.",
  components: [{ id: "comp_plate", name: "Mounting Plate", type: "plate", geometryIntent: "Rectangular plate, 100x60x5mm", dimensions: { length: 100, width: 60, thickness: 5 }, parentComponentId: null }],
  relationships: [],
  parameters: {},
  material: "aluminum",
  manufacturingIntent: "CNC milled",
  relevantRequirementIds: ["__REQ_ID__"],
  relevantConstraintIds: [],
  expectedOutputs: [{ id: "out_plate", componentId: "comp_plate", environmentObjectType: "part", environmentGenericType: "solid", properties: { Length: 100, Width: 60, Height: 5 } }]
};

describe("Phase 20 end-to-end: Test 1 -- empty project is a valid starting state", () => {
  it("a project with zero engineering objects is valid and observable", () => {
    const state = createWorldModelState({ project: { id: "proj_1", name: "Bracket Study" }, session: {} });
    assert.equal(state.project.objects.length, 0);
    const observation = observeProject(state);
    assert.ok(observation.missingInformation.length >= 0); // never throws on an empty project
  });
});

describe("Phase 20 end-to-end: full workflow, intent -> requirements -> plan -> design -> build -> verify -> objective satisfaction", () => {
  it("the complete flow produces a real, verified, objective-satisfying build from a from-scratch project", async () => {
    let state: WorldModelState = createWorldModelState({ project: { id: "proj_1", name: "Bracket Study", objective: { summary: "Design a lightweight mounting bracket for a 500 N vertical load." } }, session: {} });
    const history = createChangeHistory();

    // ---- Test 2: Intent -> P18 requirement interpretation ----
    const fakeProviderForRequirement = buildRoutedFakeProvider({ requirement: requirementPayload, plan: planPayload, design: designPayload });
    const interpretation = await interpretRequirementFromText(fakeProviderForRequirement, state, "The bracket must support 500 N vertically.", { config: { modelId: "fake-v1" } });
    assert.equal(interpretation.status, "success");
    if (interpretation.status !== "success") return;
    const candidate: RequirementCandidate = interpretation.candidate;
    assert.equal(candidate.interpretationStatus, "specific");

    // add_requirement (P18, unmodified, approval-gated)
    const addRequirement = createAddRequirementTool(() => state, (next) => (state = next), history);
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    autonomyGrants.create({ toolNames: ["add_requirement", "create_environment_object"], targetType: null, targetId: null, reason: "test", grantedBy: "human" });
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "autonomous", approvals, autonomyGrants });
    const registry = createToolRegistry();
    registry.register(addRequirement.tool, addRequirement.handler);
    const addResult = await executeTool(registry, { toolName: "add_requirement", input: { candidate }, target: { entityType: "requirement", entityId: null }, authorize });
    assert.equal(addResult.result.status, "success");
    const requirement = state.project.requirements.at(-1)!;

    // ---- Test 3: P19 clarification gate is not bypassed ----
    const clarificationStore = createClarificationStore();
    const analyzeCompleteness = createAnalyzeRequirementCompletenessTool(() => state, clarificationStore);
    const vagueCandidateInterpretation = await interpretRequirementFromText(
      buildRoutedFakeProvider({
        requirement: { description: "Should be lightweight.", category: "mass", interpretationStatus: "ambiguous", operator: null, value: null, unit: null, ambiguityReason: "No mass limit was stated." },
        plan: planPayload,
        design: designPayload
      }),
      state,
      "Make it lightweight.",
      { config: { modelId: "fake-v1" } }
    );
    assert.equal(vagueCandidateInterpretation.status, "success");
    if (vagueCandidateInterpretation.status !== "success") return;
    const analysis = analyzeCompleteness.handler({ candidate: vagueCandidateInterpretation.candidate }) as unknown as { needsClarification: boolean; clarifications: Clarification[] };
    assert.equal(analysis.needsClarification, true);
    // The ambiguous candidate must be rejected by add_requirement -- the
    // workflow cannot proceed to planning/design for THIS candidate until
    // clarified. (The specific "500 N" requirement added above is a
    // SEPARATE, already-resolved candidate and is unaffected.)
    const addAmbiguous = await executeTool(registry, {
      toolName: "add_requirement",
      input: { candidate: vagueCandidateInterpretation.candidate },
      target: { entityType: "requirement", entityId: null },
      authorize
    });
    assert.equal(addAmbiguous.result.status, "error");
    assert.match(addAmbiguous.result.error!.message, /ambiguous_candidate/);

    // ---- Test 4: Plan creation (P9, unmodified) ----
    const observation = observeProject(state);
    const planPayloadWithRealId = { ...planPayload, steps: [{ ...planPayload.steps[0]!, relevantRequirementIds: [requirement.id] }] };
    const planResult = await generatePlanProposal(
      buildRoutedFakeProvider({ requirement: requirementPayload, plan: planPayloadWithRealId, design: designPayload }),
      observation,
      { config: { modelId: "fake-v1" } }
    );
    assert.equal(planResult.status, "success");
    if (planResult.status !== "success") return;
    const plan = planResult.plan;
    assert.equal(plan.steps.length, 1);

    // ---- Test 5: Design specification (P20) ----
    const designPayloadWithRealId = { ...designPayload, relevantRequirementIds: [requirement.id] };
    const designResult = await generateDesignSpecification(
      buildRoutedFakeProvider({ requirement: requirementPayload, plan: planPayloadWithRealId, design: designPayloadWithRealId }),
      plan,
      plan.steps[0]!.id,
      [requirement],
      [],
      { config: { modelId: "fake-v1" } }
    );
    assert.equal(designResult.status, "success");
    if (designResult.status !== "success") return;
    const design = designResult.design;
    const designStore = createDesignSpecificationStore();
    designStore.save(design);
    assert.equal(design.status, "proposed");

    // ---- Approval + Build (P20) ----
    const objects = new Map<string, EnvironmentObject>();
    const adapter = buildFakeEnvironmentAdapter(objects);
    let session: EnvironmentSession | null = null;
    const createEnvObj = createCreateEnvironmentObjectTool(() => session, adapter);
    registry.register(createEnvObj.tool, createEnvObj.handler);
    const connectResult = await adapter.connect();
    session = connectResult.data as EnvironmentSession;

    const buildResultStore = createBuildResultStore();
    const buildResult = await executeBuildForDesignSpecification(registry, design, buildResultStore, { authorize });
    assert.equal(buildResult.status, "completed");
    assert.equal(buildResult.buildSuccess, true);
    assert.equal(objects.size, 1);
    const createdObject = [...objects.values()][0]!;
    assert.equal(createdObject.properties.find((p) => p.key === "Length")!.value, 100);

    // ---- Test 10: Deterministic verification (P16, unmodified) ----
    const checkStore = createCheckStore();
    const verificationResultStore = createVerificationResultStore();
    const createCheck = createCreateCheckTool(checkStore, () => state);
    const runVerification = createRunVerificationTool(() => state, () => session, adapter, checkStore, verificationResultStore);
    registry.register(createCheck.tool, createCheck.handler);
    registry.register(runVerification.tool, runVerification.handler);

    const checkCreation = await executeTool(registry, {
      toolName: "create_check",
      input: {
        kind: "numeric_comparison",
        description: "Plate Length must equal 100mm.",
        objectId: createdObject.id,
        property: "Length",
        operator: "eq",
        expectedValue: 100
      }
    });
    assert.equal(checkCreation.result.status, "success", JSON.stringify(checkCreation.result.error));
    const check = (checkCreation.result.output as { check: { id: string } }).check;

    const verificationRun = await executeTool(registry, { toolName: "run_verification", input: { checkId: check.id } });
    assert.equal(verificationRun.result.status, "success");
    const verificationResult = (verificationRun.result.output as { result: { status: string } }).result;
    assert.equal(verificationResult.status, "pass");

    // ---- Objective satisfaction (P17, unmodified) ----
    const objectiveSatisfactionStore = createObjectiveSatisfactionStore();
    const evaluateObjective = createEvaluateObjectiveSatisfactionTool(() => state, verificationResultStore, objectiveSatisfactionStore);
    registry.register(evaluateObjective.tool, evaluateObjective.handler);
    const objectiveRun = await executeTool(registry, {
      toolName: "evaluate_objective_satisfaction",
      input: { conditions: [{ checkId: check.id, requirementId: requirement.id, constraintId: null }] }
    });
    assert.equal(objectiveRun.result.status, "success");
    const objectiveResult = (objectiveRun.result.output as { result: { status: string } }).result.status;
    assert.equal(objectiveResult, "satisfied");

    // ---- Step 14: build_success / verification_passed / objective_satisfied are distinct, never collapsed ----
    assert.equal(buildResult.buildSuccess, true);
    assert.equal(verificationResult.status, "pass");
    assert.equal(objectiveResult, "satisfied");
  });
});

describe("Phase 20 end-to-end: Test 11 -- build succeeds but requirement verification fails", () => {
  it("build_success stays true while verification_passed/objective_satisfied are false -- never collapsed", async () => {
    const state: WorldModelState = createWorldModelState({ project: { id: "proj_1", name: "Bracket Study" }, session: {} });
    const registry = createToolRegistry();
    const objects = new Map<string, EnvironmentObject>();
    const adapter = buildFakeEnvironmentAdapter(objects);
    let session: EnvironmentSession | null = null;
    const createEnvObj = createCreateEnvironmentObjectTool(() => session, adapter);
    registry.register(createEnvObj.tool, createEnvObj.handler);
    const connectResult = await adapter.connect();
    session = connectResult.data as EnvironmentSession;

    // This test's project has NO requirements at all -- the plan step
    // must not reference the placeholder "__REQ_ID__" id from the shared
    // fixture, or plan-semantics' "no hallucinated relevance" check will
    // (correctly) reject it.
    const noRequirementPlanPayload = { ...planPayload, steps: [{ ...planPayload.steps[0]!, relevantRequirementIds: [] }] };
    const planResult = await generatePlanProposal(
      buildRoutedFakeProvider({ requirement: requirementPayload, plan: noRequirementPlanPayload, design: designPayload }),
      observeProject(state),
      { config: { modelId: "fake-v1" } }
    );
    assert.equal(planResult.status, "success");
    if (planResult.status !== "success") return;
    const plan = planResult.plan;

    const noRequirementDesignPayload = { ...designPayload, relevantRequirementIds: [] };
    const design = await generateDesignSpecification(
      buildRoutedFakeProvider({ requirement: requirementPayload, plan: noRequirementPlanPayload, design: noRequirementDesignPayload }),
      plan,
      plan.steps[0]!.id,
      [],
      [],
      { config: { modelId: "fake-v1" } }
    );
    assert.equal(design.status, "success");
    if (design.status !== "success") return;

    const buildResultStore = createBuildResultStore();
    const buildResult = await executeBuildForDesignSpecification(registry, design.design, buildResultStore);
    assert.equal(buildResult.buildSuccess, true, "the create operation genuinely succeeded");

    const createdObject = [...objects.values()][0]!;
    const checkStore = createCheckStore();
    const verificationResultStore = createVerificationResultStore();
    const createCheck = createCreateCheckTool(checkStore, () => state);
    const runVerification = createRunVerificationTool(() => state, () => session, adapter, checkStore, verificationResultStore);
    registry.register(createCheck.tool, createCheck.handler);
    registry.register(runVerification.tool, runVerification.handler);

    // A check that the build did NOT actually satisfy (wrong expected value).
    const checkCreation = await executeTool(registry, {
      toolName: "create_check",
      input: { kind: "numeric_comparison", description: "Plate Length must equal 999mm (deliberately wrong).", objectId: createdObject.id, property: "Length", operator: "eq", expectedValue: 999 }
    });
    assert.equal(checkCreation.result.status, "success");
    const check = (checkCreation.result.output as { check: { id: string } }).check;
    const verificationRun = await executeTool(registry, { toolName: "run_verification", input: { checkId: check.id } });
    const verificationResult = (verificationRun.result.output as { result: { status: string } }).result;

    const objectiveSatisfactionStore = createObjectiveSatisfactionStore();
    const evaluateObjective = createEvaluateObjectiveSatisfactionTool(() => state, verificationResultStore, objectiveSatisfactionStore);
    registry.register(evaluateObjective.tool, evaluateObjective.handler);
    const objectiveRun = await executeTool(registry, { toolName: "evaluate_objective_satisfaction", input: { conditions: [{ checkId: check.id }] } });
    const objectiveResult = (objectiveRun.result.output as { result: { status: string } }).result.status;

    assert.equal(buildResult.buildSuccess, true);
    assert.equal(verificationResult.status, "fail");
    assert.equal(objectiveResult, "not_satisfied");
  });
});
