import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createModelInvocationResult,
  createModelProviderDescriptor,
  createModelResponse,
  createWorldModelState,
  type ModelInvocationResult,
  type ModelRequest,
  type ObservationResult
} from "@naqsh/schemas";
import { validateStructuredResult, type ModelProvider } from "../src/index.js";
import { observeProject } from "../src/observe-project.js";
import { generatePlanProposal } from "../src/planner.js";

function richObservation(): ObservationResult {
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
  return observeProject(state, { scope: "project" });
}

function emptyObservation(): ObservationResult {
  const state = createWorldModelState({
    project: { name: "From Scratch", description: "x", objective: { summary: "Design a lightweight bracket." } },
    session: {}
  });
  return observeProject(state, { scope: "project" });
}

/** A project with NO objective at all -- `objective.summary` is empty, so
 * `observeProject` stamps `objectiveSummary: null` (see observe-project.ts).
 * The absolute beginning of the beginner workflow: before even an
 * objective has been stated. */
function objectivelessObservation(): ObservationResult {
  const state = createWorldModelState({
    project: { name: "Untitled", description: "x", objective: { summary: "" } },
    session: {}
  });
  return observeProject(state, { scope: "project" });
}

type FakeOutcome =
  | { kind: "structured_result"; structuredResult: Record<string, unknown> }
  | { kind: "text"; text: string }
  | { kind: "tool_call" }
  | { error: string };

/** A hand-rolled `ModelProvider` for testing `generatePlanProposal` in
 * isolation, without depending on `@naqsh/model-providers` (which itself
 * depends on `@naqsh/core` -- the reverse dependency would violate the
 * package boundary `repo-boundaries.test.ts` enforces). Mirrors
 * `createMockModelProvider`'s own real behavior closely: it runs
 * `validateStructuredResult` before ever returning `status: "success"`,
 * exactly like every real `ModelProvider` implementation must. */
function fakeProvider(respond: (request: ModelRequest) => FakeOutcome): ModelProvider {
  const descriptor = createModelProviderDescriptor({
    providerId: "fake",
    modelId: "fake-v1",
    supportsStructuredOutput: true
  });
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

/** A well-formed model-output shape matching `planGenerationOutputSchema`
 * exactly -- the "everything the model was asked to produce" object, not a
 * full `Plan`. */
function wellFormedOutput(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    steps: [
      {
        id: "step-1",
        title: "Select material",
        description: "Choose a material meeting the mass constraint.",
        purpose: "Unblock geometry work.",
        dependsOn: [],
        inputs: ["mass requirement"],
        expectedOutputs: ["chosen material"],
        relevantRequirementIds: ["req_mass"],
        relevantConstraintIds: ["con_material"],
        relevantObjectIds: ["obj_bracket"],
        relevantDecisionIds: [],
        verificationIntent: "Material meets the mass constraint",
        assumptionRefs: ["asm-1"]
      }
    ],
    assumptions: [{ id: "asm-1", description: "Aluminum is acceptable", rationale: "no material requirement exists yet" }],
    unresolvedQuestions: [{ id: "q-1", question: "What is the max load?", reason: "affects wall thickness" }],
    risks: [{ id: "risk-1", description: "Supply delay", impact: "schedule slip", severity: "low" }],
    additionalMissingInformation: ["No load requirement has been defined yet."],
    ...overrides
  };
}

const config = { modelId: "fake-v1" };

describe("generatePlanProposal: the golden path", () => {
  it("produces a valid, semantically-checked, 'proposed' plan from a well-formed model response", async () => {
    const observation = richObservation();
    const provider = fakeProvider(() => ({ kind: "structured_result", structuredResult: wellFormedOutput() }));
    const result = await generatePlanProposal(provider, observation, { config });
    assert.equal(result.status, "success");
    if (result.status !== "success") return;
    assert.equal(result.plan.status, "proposed");
    assert.equal(result.plan.projectId, observation.projectId);
    assert.equal(result.plan.observationId, observation.id);
    assert.equal(result.plan.steps.length, 1);
    assert.equal(result.plan.steps[0]?.title, "Select material");
    assert.deepEqual(result.plan.steps[0]?.relevantRequirementIds, ["req_mass"]);
  });

  it("REGRESSION: remaps the model's own local step/assumption ids to canonical NAQSH ids, preserving dependency/assumption links", async () => {
    const observation = richObservation();
    const provider = fakeProvider(() => ({ kind: "structured_result", structuredResult: wellFormedOutput() }));
    const result = await generatePlanProposal(provider, observation, { config });
    assert.equal(result.status, "success");
    if (result.status !== "success") return;
    const step = result.plan.steps[0]!;
    assert.match(step.id, /^planstep_/, "model's local id 'step-1' was replaced with a canonical id");
    assert.equal(step.assumptionIds.length, 1);
    assert.match(step.assumptionIds[0]!, /^planasm_/, "assumptionRefs were remapped to the canonical assumption id");
    assert.equal(step.assumptionIds[0], result.plan.assumptions[0]!.id, "the remapped id actually matches the stored assumption");
  });

  it("REGRESSION: generating a plan does not mutate the WorldModelState the observation was built from", async () => {
    const state = createWorldModelState({
      project: {
        name: "Bracket Study",
        description: "x",
        objective: { summary: "Reduce mass by 20%." },
        requirements: [{ id: "req_mass", description: "Max mass 350g" }]
      },
      session: {}
    });
    const before = JSON.parse(JSON.stringify(state));
    const observation = observeProject(state, { scope: "project" });
    const provider = fakeProvider(() => ({ kind: "structured_result", structuredResult: wellFormedOutput({ steps: [] }) }));
    await generatePlanProposal(provider, observation, { config });
    assert.deepEqual(state, before);
  });

  it("REGRESSION: generating a plan twice against the same observation does not mutate project state, and both results are semantically identical", async () => {
    const observation = richObservation();
    const provider = fakeProvider(() => ({ kind: "structured_result", structuredResult: wellFormedOutput() }));
    const first = await generatePlanProposal(provider, observation, { config });
    const second = await generatePlanProposal(provider, observation, { config });
    assert.equal(first.status, "success");
    assert.equal(second.status, "success");
    if (first.status !== "success" || second.status !== "success") return;
    assert.equal(first.plan.steps[0]?.title, second.plan.steps[0]?.title);
    assert.deepEqual(first.plan.steps[0]?.relevantRequirementIds, second.plan.steps[0]?.relevantRequirementIds);
  });

  it("preserves the observation's missingInformation and adds the model's own additional findings", async () => {
    const observation = emptyObservation();
    assert.ok(observation.missingInformation.length > 0, "an objective-only project already has known missing information");
    const provider = fakeProvider(() => ({
      kind: "structured_result",
      structuredResult: wellFormedOutput({
        steps: [],
        assumptions: [],
        additionalMissingInformation: ["No manufacturing method has been chosen."]
      })
    }));
    const result = await generatePlanProposal(provider, observation, { config });
    assert.equal(result.status, "success");
    if (result.status !== "success") return;
    for (const entry of observation.missingInformation) {
      assert.ok(result.plan.missingInformation.includes(entry), `expected preserved entry: ${entry}`);
    }
    assert.ok(result.plan.missingInformation.includes("No manufacturing method has been chosen."));
  });

  it("works for an empty, from-scratch project (objects = [])", async () => {
    const observation = emptyObservation();
    assert.deepEqual(observation.objects, []);
    const provider = fakeProvider(() => ({
      kind: "structured_result",
      structuredResult: wellFormedOutput({
        steps: [
          {
            id: "step-1",
            title: "Clarify requirements",
            description: "x",
            purpose: "unblock design",
            dependsOn: [],
            inputs: [],
            expectedOutputs: ["confirmed requirements"],
            relevantRequirementIds: [],
            relevantConstraintIds: [],
            relevantObjectIds: [],
            relevantDecisionIds: [],
            verificationIntent: null,
            assumptionRefs: []
          }
        ],
        assumptions: []
      })
    }));
    const result = await generatePlanProposal(provider, observation, { config });
    assert.equal(result.status, "success");
  });

  it("REGRESSION: a non-compliant ModelProvider that skips its own schema validation cannot crash generatePlanProposal -- it is rejected as 'malformed_plan_shape', never an uncaught exception", async () => {
    // Every real ModelProvider (mock and Gemini) is contractually required
    // to run validateStructuredResult before ever returning status:"success"
    // -- but generatePlanProposal must not simply trust a THIRD-PARTY
    // provider actually did. This fake deliberately skips that check and
    // returns a step object missing dependsOn/assumptionRefs entirely,
    // which previously threw an uncaught TypeError out of the id-remapping
    // .map() calls, breaking the "never throws for an expected failure"
    // contract documented on generatePlanProposal itself.
    const observation = richObservation();
    const nonCompliantProvider: ModelProvider = {
      describe: () => createModelProviderDescriptor({ providerId: "noncompliant", modelId: "fake-v1", supportsStructuredOutput: true }),
      async generate(request) {
        return createModelInvocationResult({
          requestId: request.id,
          providerId: "noncompliant",
          modelId: "fake-v1",
          status: "success",
          response: createModelResponse({
            requestId: request.id,
            kind: "structured_result",
            structuredResult: {
              steps: [{ id: "step-1", title: "x", description: "x", purpose: "x" }],
              assumptions: [],
              unresolvedQuestions: [],
              risks: [],
              additionalMissingInformation: []
            }
          }),
          startedAt: new Date().toISOString()
        });
      }
    };
    const result = await generatePlanProposal(nonCompliantProvider, observation, { config });
    assert.equal(result.status, "error");
    if (result.status !== "error") return;
    assert.equal(result.error.kind, "malformed_plan_shape");
  });

  it("REGRESSION: works end-to-end when the project has no objective at all (objectiveSummary is null, not just empty objects)", async () => {
    // observation.objectiveSummary is `null` here (observe-project.ts stamps
    // null, not ""), which flows through buildPlanningInstruction's fallback
    // text and Plan.objectiveSummary's `?? ""` coercion -- neither path had
    // previously been exercised by any test (every other fixture supplies a
    // non-empty objective).
    const observation = objectivelessObservation();
    assert.equal(observation.objectiveSummary, null);
    const provider = fakeProvider(() => ({
      kind: "structured_result",
      structuredResult: wellFormedOutput({ steps: [], assumptions: [] })
    }));
    const result = await generatePlanProposal(provider, observation, { config });
    assert.equal(result.status, "success");
    if (result.status !== "success") return;
    assert.equal(result.plan.objectiveSummary, "", "null observation.objectiveSummary coerces to an empty string, never null/undefined/a crash");
  });

  it("provenance: plan.source is always 'agent', never 'system' or 'human'", async () => {
    const observation = richObservation();
    const provider = fakeProvider(() => ({ kind: "structured_result", structuredResult: wellFormedOutput() }));
    const result = await generatePlanProposal(provider, observation, { config });
    assert.equal(result.status, "success");
    if (result.status !== "success") return;
    assert.equal(result.plan.source, "agent");
  });
});

describe("generatePlanProposal: rejection paths", () => {
  it("rejects with 'invalid_input' for a malformed observation", async () => {
    const provider = fakeProvider(() => ({ kind: "structured_result", structuredResult: wellFormedOutput() }));
    const result = await generatePlanProposal(provider, { not: "an observation" } as never, { config });
    assert.equal(result.status, "error");
    if (result.status !== "error") return;
    assert.equal(result.error.kind, "invalid_input");
  });

  it("REGRESSION: rejects with 'invalid_input' (never throws) for a malformed config, e.g. an empty modelId", async () => {
    const observation = richObservation();
    const provider = fakeProvider(() => ({ kind: "structured_result", structuredResult: wellFormedOutput() }));
    const result = await generatePlanProposal(provider, observation, { config: { modelId: "" } });
    assert.equal(result.status, "error");
    if (result.status !== "error") return;
    assert.equal(result.error.kind, "invalid_input");
  });

  it("rejects with 'model_unavailable' when the provider itself fails", async () => {
    const observation = richObservation();
    const provider = fakeProvider(() => ({ error: "simulated network failure" }));
    const result = await generatePlanProposal(provider, observation, { config });
    assert.equal(result.status, "error");
    if (result.status !== "error") return;
    assert.equal(result.error.kind, "model_unavailable");
  });

  it("rejects with 'invalid_model_output' when the model replies with plain text instead of structured output", async () => {
    const observation = richObservation();
    const provider = fakeProvider(() => ({ kind: "text", text: "Sure, here is a plan..." }));
    const result = await generatePlanProposal(provider, observation, { config });
    assert.equal(result.status, "error");
    if (result.status !== "error") return;
    assert.equal(result.error.kind, "invalid_model_output");
  });

  it("rejects with 'invalid_model_output' when the model asks for a tool call instead of returning a plan", async () => {
    const observation = richObservation();
    const provider = fakeProvider(() => ({ kind: "tool_call" }));
    const result = await generatePlanProposal(provider, observation, { config });
    assert.equal(result.status, "error");
    if (result.status !== "error") return;
    assert.equal(result.error.kind, "invalid_model_output");
  });

  it("rejects with an error (schema layer) when the structured output is missing a required field", async () => {
    const observation = richObservation();
    const malformed = wellFormedOutput();
    delete (malformed as Record<string, unknown>).risks;
    const provider = fakeProvider(() => ({ kind: "structured_result", structuredResult: malformed }));
    const result = await generatePlanProposal(provider, observation, { config });
    assert.equal(result.status, "error");
    // Caught either as model_unavailable (provider's own schema check, matching
    // every real provider's validateStructuredResult call) or invalid_model_output
    // (our narrower runtime shape guard) -- either way, it must not become a plan.
  });

  it("REGRESSION: rejects with 'malformed_plan_shape' when a step's title is blank (schema-legal string, but not a valid PlanStep)", async () => {
    const observation = richObservation();
    const output = wellFormedOutput();
    (output.steps as Record<string, unknown>[])[0]!.title = "";
    const provider = fakeProvider(() => ({ kind: "structured_result", structuredResult: output }));
    const result = await generatePlanProposal(provider, observation, { config });
    assert.equal(result.status, "error");
    if (result.status !== "error") return;
    assert.equal(result.error.kind, "malformed_plan_shape");
  });

  it("REGRESSION: rejects with 'semantic_validation_failed' for a hallucinated requirement id", async () => {
    const observation = richObservation();
    const output = wellFormedOutput();
    (output.steps as Record<string, unknown>[])[0]!.relevantRequirementIds = ["req_totally_made_up"];
    const provider = fakeProvider(() => ({ kind: "structured_result", structuredResult: output }));
    const result = await generatePlanProposal(provider, observation, { config });
    assert.equal(result.status, "error");
    if (result.status !== "error") return;
    assert.equal(result.error.kind, "semantic_validation_failed");
    assert.match(result.error.message, /req_totally_made_up/);
  });

  it("REGRESSION: rejects with 'semantic_validation_failed' for a hallucinated object id", async () => {
    const observation = richObservation();
    const output = wellFormedOutput();
    (output.steps as Record<string, unknown>[])[0]!.relevantObjectIds = ["obj_totally_made_up"];
    const provider = fakeProvider(() => ({ kind: "structured_result", structuredResult: output }));
    const result = await generatePlanProposal(provider, observation, { config });
    assert.equal(result.status, "error");
    if (result.status !== "error") return;
    assert.equal(result.error.kind, "semantic_validation_failed");
  });

  it("REGRESSION: rejects with 'semantic_validation_failed' for a hallucinated constraint id", async () => {
    const observation = richObservation();
    const output = wellFormedOutput();
    (output.steps as Record<string, unknown>[])[0]!.relevantConstraintIds = ["con_totally_made_up"];
    const provider = fakeProvider(() => ({ kind: "structured_result", structuredResult: output }));
    const result = await generatePlanProposal(provider, observation, { config });
    assert.equal(result.status, "error");
    if (result.status !== "error") return;
    assert.equal(result.error.kind, "semantic_validation_failed");
  });

  it("REGRESSION: rejects a circular step dependency the model produced", async () => {
    const observation = richObservation();
    const output = wellFormedOutput({
      steps: [
        { ...(wellFormedOutput().steps as Record<string, unknown>[])[0]!, id: "step-a", dependsOn: ["step-b"] },
        { ...(wellFormedOutput().steps as Record<string, unknown>[])[0]!, id: "step-b", dependsOn: ["step-a"] }
      ]
    });
    const provider = fakeProvider(() => ({ kind: "structured_result", structuredResult: output }));
    const result = await generatePlanProposal(provider, observation, { config });
    assert.equal(result.status, "error");
    if (result.status !== "error") return;
    assert.equal(result.error.kind, "semantic_validation_failed");
    assert.match(result.error.message, /[Cc]ircular/);
  });
});
