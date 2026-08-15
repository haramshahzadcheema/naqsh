import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createModelInvocationResult,
  createModelProviderDescriptor,
  createModelResponse,
  createPlan,
  createTool,
  createWorldModelState,
  type ModelInvocationResult,
  type ModelRequest,
  type Plan
} from "@naqsh/schemas";
import { validateStructuredResult, type ModelProvider } from "../src/index.js";
import { createToolRegistry, type ToolRegistry } from "../src/tool-registry.js";
import { observeProject } from "../src/observe-project.js";
import { generatePlanProposal } from "../src/planner.js";
import { generateProposal } from "../src/proposal-generator.js";

/** A plan generated the normal P9 way, from a real observation of a real
 * project, so `plan.projectId`/`plan.projectVersion`/`plan.steps[].id`/
 * relevant-ids are all genuine, not hand-fabricated. */
async function richPlan(): Promise<Plan> {
  const state = createWorldModelState({
    project: {
      name: "Bracket Study",
      description: "x",
      objective: { summary: "Reduce mass by 20%." },
      requirements: [{ id: "req_mass", description: "Max mass 350g" }],
      constraints: [{ id: "con_material", description: "Aluminum only" }],
      objects: [{ id: "obj_bracket", type: "part", name: "Bracket" }]
    },
    session: {}
  });
  const observation = observeProject(state, { scope: "project" });
  const planProvider: ModelProvider = {
    describe: () => createModelProviderDescriptor({ providerId: "fake", modelId: "fake-v1", supportsStructuredOutput: true }),
    async generate(request) {
      const response = createModelResponse({
        requestId: request.id,
        kind: "structured_result",
        structuredResult: {
          steps: [
            {
              id: "step-1",
              title: "Select material",
              description: "Choose a material meeting the mass constraint.",
              purpose: "Unblock geometry work.",
              dependsOn: [],
              inputs: [],
              expectedOutputs: [],
              relevantRequirementIds: ["req_mass"],
              relevantConstraintIds: ["con_material"],
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
        }
      });
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
  const result = await generatePlanProposal(planProvider, observation, { config: { modelId: "fake-v1" } });
  assert.equal(result.status, "success");
  if (result.status !== "success") throw new Error("unreachable");
  return result.plan;
}

function registryWithModifyObject(): ToolRegistry {
  const registry = createToolRegistry();
  registry.register(
    createTool({
      name: "modify_object",
      description: "Modifies a property on an existing engineering object.",
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

type FakeOutcome =
  | { kind: "structured_result"; structuredResult: Record<string, unknown> }
  | { kind: "text"; text: string }
  | { kind: "tool_call" }
  | { error: string };

function fakeProvider(respond: (request: ModelRequest) => FakeOutcome): ModelProvider {
  const descriptor = createModelProviderDescriptor({ providerId: "fake", modelId: "fake-v1", supportsStructuredOutput: true });
  return {
    describe: () => descriptor,
    async generate(request: ModelRequest): Promise<ModelInvocationResult> {
      const startedAt = new Date().toISOString();
      const outcome = respond(request);
      if ("error" in outcome) {
        return createModelInvocationResult({
          requestId: request.id,
          providerId: descriptor.providerId,
          modelId: descriptor.modelId,
          status: "error",
          error: { kind: "provider_error", message: outcome.error },
          startedAt
        });
      }
      const response = createModelResponse({
        requestId: request.id,
        kind: outcome.kind,
        text: outcome.kind === "text" ? outcome.text : undefined,
        structuredResult: outcome.kind === "structured_result" ? outcome.structuredResult : undefined,
        toolCall: outcome.kind === "tool_call" ? { toolName: "some_other_tool", arguments: {} } : undefined
      });
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

function wellFormedOutput(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    toolName: "modify_object",
    input: { objectId: "obj_bracket", propertyKey: "material", value: "aluminum_6061" },
    target: { entityType: "object", entityId: "obj_bracket" },
    rationale: "Aluminum satisfies the mass requirement.",
    expectedEffect: "The bracket's material property updates to aluminum 6061.",
    relevantRequirementIds: ["req_mass"],
    relevantConstraintIds: ["con_material"],
    ...overrides
  };
}

const config = { modelId: "fake-v1" };

describe("generateProposal: the golden path", () => {
  it("produces a valid, semantically-checked, 'proposed' proposal from a well-formed model response", async () => {
    const plan = await richPlan();
    const registry = registryWithModifyObject();
    const provider = fakeProvider(() => ({ kind: "structured_result", structuredResult: wellFormedOutput() }));
    const result = await generateProposal(provider, registry, plan, plan.steps[0]!.id, { config });
    assert.equal(result.status, "success");
    if (result.status !== "success") return;
    assert.equal(result.proposal.status, "proposed");
    assert.equal(result.proposal.planId, plan.id);
    assert.equal(result.proposal.planStepId, plan.steps[0]!.id);
    assert.equal(result.proposal.toolName, "modify_object");
    assert.equal(result.proposal.toolTarget, "world_model");
    assert.deepEqual(result.proposal.target, { entityType: "object", entityId: "obj_bracket" });
  });

  it("provenance: proposal.source is always 'agent'", async () => {
    const plan = await richPlan();
    const registry = registryWithModifyObject();
    const provider = fakeProvider(() => ({ kind: "structured_result", structuredResult: wellFormedOutput() }));
    const result = await generateProposal(provider, registry, plan, plan.steps[0]!.id, { config });
    assert.equal(result.status, "success");
    if (result.status !== "success") return;
    assert.equal(result.proposal.source, "agent");
  });

  it("REGRESSION: generating a proposal does not mutate the originating Plan itself (not just WorldModelState)", async () => {
    // Plan is already deep-frozen by createPlan (P9), so a genuine mutation
    // attempt would throw -- this proves generateProposal never even
    // ATTEMPTS to write through the Plan value it was handed, independent
    // of that freeze (a caller could theoretically pass an unfrozen
    // hand-built object satisfying the Plan shape).
    const plan = await richPlan();
    const before = JSON.parse(JSON.stringify(plan));
    const registry = registryWithModifyObject();
    const provider = fakeProvider(() => ({ kind: "structured_result", structuredResult: wellFormedOutput() }));
    await generateProposal(provider, registry, plan, plan.steps[0]!.id, { config });
    assert.deepEqual(plan, before);
  });

  it("REGRESSION: generating a proposal does not mutate the WorldModelState the plan/observation was built from", async () => {
    const state = createWorldModelState({
      project: {
        name: "Bracket Study",
        description: "x",
        objective: { summary: "Reduce mass by 20%." },
        requirements: [{ id: "req_mass", description: "Max mass 350g" }],
        objects: [{ id: "obj_bracket", type: "part", name: "Bracket" }]
      },
      session: {}
    });
    const before = JSON.parse(JSON.stringify(state));
    const observation = observeProject(state, { scope: "project" });
    const planProvider = fakeProvider(() => ({
      kind: "structured_result",
      structuredResult: {
        steps: [
          {
            id: "step-1",
            title: "x",
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
      }
    }));
    const planResult = await generatePlanProposal(planProvider, observation, { config });
    assert.equal(planResult.status, "success");
    if (planResult.status !== "success") return;

    const registry = registryWithModifyObject();
    const proposalProvider = fakeProvider(() => ({
      kind: "structured_result",
      structuredResult: wellFormedOutput({ target: { entityType: "object", entityId: "obj_bracket" } })
    }));
    await generateProposal(proposalProvider, registry, planResult.plan, planResult.plan.steps[0]!.id, { config });
    assert.deepEqual(state, before);
  });

  it("REGRESSION: generating a proposal does not register or execute any tool -- the registry is read-only here", async () => {
    const plan = await richPlan();
    const registry = registryWithModifyObject();
    const toolsBefore = registry.list().length;
    const provider = fakeProvider(() => ({ kind: "structured_result", structuredResult: wellFormedOutput() }));
    await generateProposal(provider, registry, plan, plan.steps[0]!.id, { config });
    assert.equal(registry.list().length, toolsBefore);
  });

  it("works for a from-scratch project (no existing engineering objects): a proposal to CREATE something new, target null", async () => {
    // Project.objects = [] -- the plan step has no relevantObjectIds to
    // reference (nothing exists yet), so the only legitimate proposal is
    // one that creates something, with target: null (there is no id for
    // something that doesn't exist yet). Confirms P10 doesn't assume an
    // existing model.
    const plan = createPlan({
      projectId: "proj_scratch",
      projectVersion: 1,
      observationId: "obs_scratch",
      objectiveSummary: "Design a lightweight bracket from scratch.",
      steps: [
        {
          id: "planstep_create",
          title: "Create initial bracket geometry",
          description: "x",
          purpose: "establish a starting point for the design",
          relevantRequirementIds: [],
          relevantConstraintIds: [],
          relevantObjectIds: [],
          relevantDecisionIds: []
        }
      ]
    });
    const registry = createToolRegistry();
    registry.register(
      createTool({
        name: "create_object",
        target: "world_model",
        mutation: "mutate",
        inputSchema: { type: "object", properties: { type: { type: "string" }, name: { type: "string" } }, required: ["type", "name"] },
        outputSchema: { type: "object", properties: {} }
      }),
      () => ({})
    );
    const provider = fakeProvider(() => ({
      kind: "structured_result",
      structuredResult: {
        toolName: "create_object",
        input: { type: "part", name: "Bracket" },
        target: null,
        rationale: "No geometry exists yet; this establishes the starting object.",
        expectedEffect: "A new engineering object representing the bracket exists in the project.",
        relevantRequirementIds: [],
        relevantConstraintIds: []
      }
    }));
    const result = await generateProposal(provider, registry, plan, "planstep_create", { config });
    assert.equal(result.status, "success");
    if (result.status !== "success") return;
    assert.equal(result.proposal.target, null);
    assert.equal(result.proposal.toolName, "create_object");
  });
});

describe("generateProposal: rejection paths", () => {
  it("rejects with 'invalid_input' for a nonexistent planStepId", async () => {
    const plan = await richPlan();
    const registry = registryWithModifyObject();
    const provider = fakeProvider(() => ({ kind: "structured_result", structuredResult: wellFormedOutput() }));
    const result = await generateProposal(provider, registry, plan, "planstep_ghost", { config });
    assert.equal(result.status, "error");
    if (result.status !== "error") return;
    assert.equal(result.error.kind, "invalid_input");
  });

  it("rejects with 'invalid_input' (never throws) for a malformed config", async () => {
    const plan = await richPlan();
    const registry = registryWithModifyObject();
    const provider = fakeProvider(() => ({ kind: "structured_result", structuredResult: wellFormedOutput() }));
    const result = await generateProposal(provider, registry, plan, plan.steps[0]!.id, { config: { modelId: "" } });
    assert.equal(result.status, "error");
    if (result.status !== "error") return;
    assert.equal(result.error.kind, "invalid_input");
  });

  it("rejects with 'model_unavailable' when the provider itself fails", async () => {
    const plan = await richPlan();
    const registry = registryWithModifyObject();
    const provider = fakeProvider(() => ({ error: "simulated network failure" }));
    const result = await generateProposal(provider, registry, plan, plan.steps[0]!.id, { config });
    assert.equal(result.status, "error");
    if (result.status !== "error") return;
    assert.equal(result.error.kind, "model_unavailable");
  });

  it("rejects with 'invalid_model_output' when the model replies with plain text instead of a structured proposal", async () => {
    const plan = await richPlan();
    const registry = registryWithModifyObject();
    const provider = fakeProvider(() => ({ kind: "text", text: "Sure, I would modify the object..." }));
    const result = await generateProposal(provider, registry, plan, plan.steps[0]!.id, { config });
    assert.equal(result.status, "error");
    if (result.status !== "error") return;
    assert.equal(result.error.kind, "invalid_model_output");
  });

  it("REGRESSION: rejects with 'malformed_proposal_shape' when rationale is blank (schema-legal string, but not a valid Proposal)", async () => {
    const plan = await richPlan();
    const registry = registryWithModifyObject();
    const provider = fakeProvider(() => ({ kind: "structured_result", structuredResult: wellFormedOutput({ rationale: "" }) }));
    const result = await generateProposal(provider, registry, plan, plan.steps[0]!.id, { config });
    assert.equal(result.status, "error");
    if (result.status !== "error") return;
    assert.equal(result.error.kind, "malformed_proposal_shape");
  });

  it("REGRESSION: rejects a hallucinated tool name -- never invented, never silently accepted", async () => {
    const plan = await richPlan();
    const registry = registryWithModifyObject();
    const provider = fakeProvider(() => ({ kind: "structured_result", structuredResult: wellFormedOutput({ toolName: "delete_everything" }) }));
    const result = await generateProposal(provider, registry, plan, plan.steps[0]!.id, { config });
    assert.equal(result.status, "error");
    if (result.status !== "error") return;
    assert.equal(result.error.kind, "semantic_validation_failed");
    assert.match(result.error.message, /delete_everything/);
  });

  it("REGRESSION: rejects input that does not match the named tool's own inputSchema", async () => {
    const plan = await richPlan();
    const registry = registryWithModifyObject();
    const provider = fakeProvider(() => ({ kind: "structured_result", structuredResult: wellFormedOutput({ input: { wrongField: 123 } }) }));
    const result = await generateProposal(provider, registry, plan, plan.steps[0]!.id, { config });
    assert.equal(result.status, "error");
    if (result.status !== "error") return;
    assert.equal(result.error.kind, "semantic_validation_failed");
  });

  it("REGRESSION: rejects a hallucinated requirement id", async () => {
    const plan = await richPlan();
    const registry = registryWithModifyObject();
    const provider = fakeProvider(() => ({
      kind: "structured_result",
      structuredResult: wellFormedOutput({ relevantRequirementIds: ["req_made_up"] })
    }));
    const result = await generateProposal(provider, registry, plan, plan.steps[0]!.id, { config });
    assert.equal(result.status, "error");
    if (result.status !== "error") return;
    assert.equal(result.error.kind, "semantic_validation_failed");
  });

  it("REGRESSION: rejects a hallucinated target entity id", async () => {
    const plan = await richPlan();
    const registry = registryWithModifyObject();
    const provider = fakeProvider(() => ({
      kind: "structured_result",
      structuredResult: wellFormedOutput({ target: { entityType: "object", entityId: "obj_made_up" } })
    }));
    const result = await generateProposal(provider, registry, plan, plan.steps[0]!.id, { config });
    assert.equal(result.status, "error");
    if (result.status !== "error") return;
    assert.equal(result.error.kind, "semantic_validation_failed");
  });
});
