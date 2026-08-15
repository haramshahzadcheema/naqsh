import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createAgentLoopRun,
  createModelInvocationResult,
  createModelProviderDescriptor,
  createModelResponse,
  createProposal,
  createTool,
  createWorldModelState,
  type ModelRequest,
  type WorldModelState
} from "@naqsh/schemas";
import {
  beginAgentLoopRun,
  isProposalStale,
  resumeAgentLoopRunAfterApproval,
  selectFirstPendingPlanStep,
  validateStructuredResult,
  type AgentLoopRunResult,
  type ModelProvider
} from "../src/index.js";
import { createModifyObjectTool } from "../src/modify-object-tool.js";
import { createToolRegistry, type ToolRegistry } from "../src/tool-registry.js";
import { createChangeHistory, type ChangeHistory } from "../src/change-history.js";
import { createApprovalStore, type ApprovalStore } from "../src/approval-store.js";
import { createAutonomyGrantStore, type AutonomyGrantStore } from "../src/autonomy-grant-store.js";
import { recordTransition } from "../src/record-transition.js";

/**
 * A single fake ModelProvider whose response depends on WHICH stage is
 * asking (distinguished by outputSchema shape, the same way a real caller
 * would never need to since planner.ts/proposal-generator.ts always send a
 * DIFFERENT outputSchema per stage) -- this is what lets one provider
 * stand in for the two different model calls beginAgentLoopRun makes
 * (REASON, then PROPOSE), matching `fakeProvider` in
 * proposal-generator.test.ts's own "no real network, no real Gemini"
 * discipline.
 */
function buildLoopProvider(
  proposalOverrides: Partial<{
    toolName: string;
    input: Record<string, unknown>;
    target: { entityType: string; entityId: string | null } | null;
    planRelevantObjectIds: string[];
  }> = {}
): ModelProvider {
  const descriptor = createModelProviderDescriptor({ providerId: "fake", modelId: "fake-v1", supportsStructuredOutput: true });
  return {
    describe: () => descriptor,
    async generate(request: ModelRequest) {
      const startedAt = new Date().toISOString();
      const schema = request.outputSchema as { properties?: Record<string, unknown> } | null;
      const isProposalRequest = !!schema?.properties && "toolName" in schema.properties;
      const structuredResult = isProposalRequest
        ? {
            toolName: proposalOverrides.toolName ?? "modify_object",
            input: proposalOverrides.input ?? { objectId: "obj_bracket", propertyKey: "material", value: "aluminum_6061" },
            target: proposalOverrides.target !== undefined ? proposalOverrides.target : { entityType: "object", entityId: "obj_bracket" },
            rationale: "Aluminum satisfies the mass requirement.",
            expectedEffect: "The bracket's material property updates to aluminum 6061.",
            relevantRequirementIds: ["req_mass"],
            relevantConstraintIds: ["con_material"]
          }
        : {
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
                relevantObjectIds: proposalOverrides.planRelevantObjectIds ?? ["obj_bracket"],
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

function malformedProposalProvider(): ModelProvider {
  const descriptor = createModelProviderDescriptor({ providerId: "fake", modelId: "fake-v1", supportsStructuredOutput: true });
  return {
    describe: () => descriptor,
    async generate(request: ModelRequest) {
      const startedAt = new Date().toISOString();
      const schema = request.outputSchema as { properties?: Record<string, unknown> } | null;
      const isProposalRequest = !!schema?.properties && "toolName" in schema.properties;
      if (isProposalRequest) {
        // Replies with plain text instead of the requested structured
        // proposal -- CASE H: malformed structured output.
        const response = createModelResponse({ requestId: request.id, kind: "text", text: "Sure, I would modify the object..." });
        return createModelInvocationResult({
          requestId: request.id,
          providerId: descriptor.providerId,
          modelId: descriptor.modelId,
          status: "success",
          response,
          startedAt
        });
      }
      const structuredResult = {
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
  setState: (next: WorldModelState) => void;
  history: ChangeHistory;
  registry: ToolRegistry;
  approvals: ApprovalStore;
  autonomyGrants: AutonomyGrantStore;
  provider: ModelProvider;
}

function buildState(objects: Array<{ id: string; properties?: Record<string, unknown> }> = [{ id: "obj_bracket", properties: { material: "steel" } }]): WorldModelState {
  return createWorldModelState({
    project: {
      name: "Bracket Study",
      description: "x",
      objective: { summary: "Reduce mass by 20%." },
      requirements: [{ id: "req_mass", description: "Max mass 350g" }],
      constraints: [{ id: "con_material", description: "Aluminum only" }],
      objects: objects.map((o) => ({ id: o.id, type: "part", name: "Bracket", properties: o.properties ?? {} }))
    },
    session: {}
  });
}

function buildHarness(options: { emptyObjects?: boolean; provider?: ModelProvider } = {}): Harness {
  let state = buildState(options.emptyObjects ? [] : undefined);
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
  const approvals = createApprovalStore();
  const autonomyGrants = createAutonomyGrantStore();
  const provider = options.provider ?? buildLoopProvider();
  return {
    getState: () => state,
    setState: (next) => {
      state = next;
    },
    history,
    registry,
    approvals,
    autonomyGrants,
    provider
  };
}

const config = { modelId: "fake-v1" };

function beginInput(h: Harness) {
  return {
    getState: h.getState,
    observe: { scope: "project" as const },
    provider: h.provider,
    registry: h.registry,
    approvals: h.approvals,
    planOptions: { config },
    proposalOptions: { config }
  };
}

async function beginAndApprove(h: Harness): Promise<AgentLoopRunResult> {
  const begin = await beginAgentLoopRun(beginInput(h));
  if (begin.status !== "success") return begin;
  h.approvals.approve(begin.run.approval!.id, "human");
  return begin;
}

describe("Phase 11 controlled agent loop: CASE A -- the golden path", () => {
  it("observe -> reason -> propose -> approval -> execute -> observe changed parameter", async () => {
    const h = buildHarness();
    const begin = await beginAgentLoopRun(beginInput(h));
    assert.equal(begin.status, "success");
    if (begin.status !== "success") return;
    assert.equal(begin.run.status, "awaiting_approval");
    assert.equal(begin.run.proposal.toolName, "modify_object");
    assert.equal(begin.run.approval?.status, "pending");

    h.approvals.approve(begin.run.approval!.id, "human");

    const resumed = await resumeAgentLoopRunAfterApproval({
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
    assert.equal(resumed.run.executionResult?.outcome, "succeeded");
    assert.equal(h.getState().project.objects[0]!.properties.material, "aluminum_6061");
    assert.equal(resumed.run.observationAfter?.objects[0]!.properties.material, "aluminum_6061");
    assert.equal(resumed.run.discrepancy?.detected, false);
    assert.equal(resumed.run.approval?.consumedAt !== null, true);
  });
});

describe("Phase 11 controlled agent loop: CASE B -- rejection", () => {
  it("proposal rejected -> the loop terminates at status 'rejected' -> nothing changes", async () => {
    const h = buildHarness();
    const before = h.getState();
    const begin = await beginAgentLoopRun(beginInput(h));
    assert.equal(begin.status, "success");
    if (begin.status !== "success") return;
    h.approvals.reject(begin.run.approval!.id, "human", "Not now.");

    const resumed = await resumeAgentLoopRunAfterApproval({
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
    assert.equal(resumed.run.executionResult?.outcome, "rejected");
    assert.equal(resumed.run.executionResult?.toolResult, null);
    assert.deepEqual(h.getState(), before);
  });

  it("a REVOKED approval also terminates the loop as rejected, never executes", async () => {
    const h = buildHarness();
    const before = h.getState();
    const begin = await beginAgentLoopRun(beginInput(h));
    if (begin.status !== "success") return assert.fail();
    h.approvals.approve(begin.run.approval!.id, "human");
    h.approvals.revoke(begin.run.approval!.id, "human", "Changed our mind.");

    const resumed = await resumeAgentLoopRunAfterApproval({
      run: begin.run,
      getState: h.getState,
      registry: h.registry,
      approvals: h.approvals,
      autonomyGrants: h.autonomyGrants,
      autonomyLevel: "approved_modify"
    });
    if (resumed.status !== "success") return assert.fail();
    assert.equal(resumed.run.status, "rejected");
    assert.deepEqual(h.getState(), before);
  });
});

describe("Phase 11 controlled agent loop: CASE C / J -- staleness", () => {
  it("CASE C: the World Model changes before the approval decision is even made -> execution is refused as stale regardless of the (careless) approval", async () => {
    const h = buildHarness();
    const begin = await beginAgentLoopRun(beginInput(h));
    if (begin.status !== "success") return assert.fail();

    // The World Model moves on BEFORE anyone decides the approval.
    const { state: bumped } = recordTransition(h.history, h.getState(), { kind: "set_project_metadata", metadata: { touched: true } });
    h.setState(bumped);

    h.approvals.approve(begin.run.approval!.id, "human");
    const stateBeforeResume = h.getState();

    const resumed = await resumeAgentLoopRunAfterApproval({
      run: begin.run,
      getState: h.getState,
      registry: h.registry,
      approvals: h.approvals,
      autonomyGrants: h.autonomyGrants,
      autonomyLevel: "approved_modify"
    });
    if (resumed.status !== "success") return assert.fail();
    assert.equal(resumed.run.status, "stale");
    assert.equal(resumed.run.executionResult?.outcome, "stale");
    assert.equal(resumed.run.executionResult?.toolResult, null);
    assert.deepEqual(h.getState(), stateBeforeResume, "resuming a stale run must not itself mutate anything");
    assert.notEqual(h.getState().project.objects[0]!.properties.material, "aluminum_6061");
  });

  it("CASE J: the World Model changes AFTER a valid approval is granted, before execution is attempted -> still refused as stale", async () => {
    const h = buildHarness();
    const begin = await beginAgentLoopRun(beginInput(h));
    if (begin.status !== "success") return assert.fail();

    h.approvals.approve(begin.run.approval!.id, "human");

    // Only NOW does the World Model drift -- proving staleness is checked
    // fresh at execution time, not merely at approval time.
    const { state: bumped } = recordTransition(h.history, h.getState(), { kind: "set_project_metadata", metadata: { touched: true } });
    h.setState(bumped);

    const resumed = await resumeAgentLoopRunAfterApproval({
      run: begin.run,
      getState: h.getState,
      registry: h.registry,
      approvals: h.approvals,
      autonomyGrants: h.autonomyGrants,
      autonomyLevel: "approved_modify"
    });
    if (resumed.status !== "success") return assert.fail();
    assert.equal(resumed.run.status, "stale");
  });

  it("isProposalStale is a pure, direct comparison of projectVersion", async () => {
    const h = buildHarness();
    const begin = await beginAgentLoopRun(beginInput(h));
    if (begin.status !== "success") return assert.fail();
    assert.equal(isProposalStale(begin.run.proposal, h.getState()), false);
    const { state: bumped } = recordTransition(h.history, h.getState(), { kind: "set_project_metadata", metadata: {} });
    assert.equal(isProposalStale(begin.run.proposal, bumped), true);
  });
});

describe("Phase 11 controlled agent loop: CASE D -- execution-time tool input validation (defense in depth)", () => {
  it("even a hand-corrupted proposal whose input no longer matches the tool's schema is rejected AT EXECUTION TIME, never trusted -- zero mutation", async () => {
    const h = buildHarness();
    const begin = await beginAgentLoopRun(beginInput(h));
    if (begin.status !== "success") return assert.fail();
    h.approvals.approve(begin.run.approval!.id, "human");

    // Simulate a proposal whose input has since drifted out of sync with
    // its named tool's schema (generation-time validateProposalSemantics
    // already prevents this in the normal path -- this proves executeTool
    // ALSO independently re-validates, rather than blindly trusting a
    // Proposal that somehow reached this point already malformed).
    const corruptedProposal = createProposal({ ...begin.run.proposal, input: { objectId: "obj_bracket" } });
    const corruptedRun = createAgentLoopRun({ ...begin.run, proposal: corruptedProposal });
    const before = h.getState();

    const resumed = await resumeAgentLoopRunAfterApproval({
      run: corruptedRun,
      getState: h.getState,
      registry: h.registry,
      approvals: h.approvals,
      autonomyGrants: h.autonomyGrants,
      autonomyLevel: "approved_modify"
    });
    if (resumed.status !== "success") return assert.fail();
    assert.equal(resumed.run.status, "execution_failed");
    assert.equal(resumed.run.executionResult?.toolResult?.status, "error");
    assert.equal(resumed.run.executionResult?.toolResult?.error?.kind, "invalid_input");
    assert.deepEqual(h.getState(), before);
  });
});

describe("Phase 11 controlled agent loop: CASE E -- environment/tool execution failure", () => {
  it("SECURITY INVARIANT #8: a failed execution is never represented as success -- World Model does not falsely claim success", async () => {
    // Target an object that will not exist by the time execution actually
    // runs (approved for obj_ghost) -- modify-object-tool.ts's own handler
    // deterministically fails.
    const provider = buildLoopProvider({ input: { objectId: "obj_ghost", propertyKey: "material", value: "aluminum_6061" }, target: null });
    const h = buildHarness({ provider });
    const before = h.getState();
    const begin = await beginAgentLoopRun(beginInput(h));
    if (begin.status !== "success") return assert.fail();
    h.approvals.approve(begin.run.approval!.id, "human");

    const resumed = await resumeAgentLoopRunAfterApproval({
      run: begin.run,
      getState: h.getState,
      registry: h.registry,
      approvals: h.approvals,
      autonomyGrants: h.autonomyGrants,
      autonomyLevel: "approved_modify"
    });
    if (resumed.status !== "success") return assert.fail();
    assert.equal(resumed.run.status, "execution_failed");
    assert.notEqual(resumed.run.status, "completed");
    assert.equal(resumed.run.executionResult?.outcome, "failed");
    assert.equal(resumed.run.executionResult?.toolResult?.status, "error");
    assert.deepEqual(h.getState(), before);
  });
});

describe("Phase 11 controlled agent loop: CASE F -- success without the expected effect", () => {
  it("SECURITY INVARIANT #9: post-execution state comes from re-observation, not from the model's expectedEffect claim -- a no-op tool reporting success is caught as a discrepancy", async () => {
    // A "mutate"-classified tool that reports success but genuinely changes
    // nothing -- the honest way to simulate "the command succeeded but the
    // objective was not satisfied" without needing a real misbehaving
    // environment.
    const provider = buildLoopProvider({ toolName: "noop_modify_object", input: { objectId: "obj_bracket" } });
    const h = buildHarness({ provider });
    h.registry.register(
      createTool({
        name: "noop_modify_object",
        target: "world_model",
        mutation: "mutate",
        inputSchema: { type: "object", properties: { objectId: { type: "string" } }, required: ["objectId"] },
        outputSchema: { type: "object", properties: {} }
      }),
      () => ({})
    );

    const begin = await beginAgentLoopRun(beginInput(h));
    if (begin.status !== "success") return assert.fail();
    h.approvals.approve(begin.run.approval!.id, "human");

    const resumed = await resumeAgentLoopRunAfterApproval({
      run: begin.run,
      getState: h.getState,
      registry: h.registry,
      approvals: h.approvals,
      autonomyGrants: h.autonomyGrants,
      autonomyLevel: "approved_modify"
    });
    if (resumed.status !== "success") return assert.fail();
    assert.equal(resumed.run.status, "completed");
    assert.equal(resumed.run.executionResult?.outcome, "succeeded");
    assert.equal(resumed.run.discrepancy?.detected, true);
    assert.match(resumed.run.discrepancy!.description, /unchanged/);
  });

  it("REGRESSION: an environment-target proposal's successful execution is never reported as a false 'unchanged' discrepancy -- WorldModelState re-observation cannot see an environment-only change by design", async () => {
    const provider = buildLoopProvider({ toolName: "fake_environment_tool", input: { objectId: "envobj_1" }, target: { entityType: "object", entityId: "obj_bracket" } });
    const h = buildHarness({ provider });
    h.registry.register(
      createTool({
        name: "fake_environment_tool",
        target: "environment",
        mutation: "mutate",
        inputSchema: { type: "object", properties: { objectId: { type: "string" } }, required: ["objectId"] },
        outputSchema: { type: "object", properties: {} }
      }),
      () => ({ ok: true })
    );

    const begin = await beginAgentLoopRun(beginInput(h));
    if (begin.status !== "success") return assert.fail();
    assert.equal(begin.run.proposal.toolTarget, "environment");
    h.approvals.approve(begin.run.approval!.id, "human");

    const resumed = await resumeAgentLoopRunAfterApproval({
      run: begin.run,
      getState: h.getState,
      registry: h.registry,
      approvals: h.approvals,
      autonomyGrants: h.autonomyGrants,
      autonomyLevel: "approved_modify"
    });
    if (resumed.status !== "success") return assert.fail();
    assert.equal(resumed.run.status, "completed");
    assert.equal(resumed.run.executionResult?.outcome, "succeeded");
    assert.equal(resumed.run.discrepancy?.detected, false);
    assert.match(resumed.run.discrepancy!.description, /only implemented for toolTarget "world_model"/);
  });
});

describe("Phase 11 controlled agent loop: CASE G -- from-scratch project (no existing objects)", () => {
  it("reasoning and proposing still work from requirements alone, but execution cannot happen without a registered capability -- zero mutation", async () => {
    const emptyRegistryHarness: Harness = (() => {
      let state = buildState([]);
      const registry = createToolRegistry(); // deliberately NO tools registered
      const approvals = createApprovalStore();
      const autonomyGrants = createAutonomyGrantStore();
      return {
        getState: () => state,
        setState: (next) => {
          state = next;
        },
        history: createChangeHistory(),
        registry,
        approvals,
        autonomyGrants,
        provider: buildLoopProvider({ target: null, planRelevantObjectIds: [] })
      };
    })();
    const before = emptyRegistryHarness.getState();
    assert.deepEqual(before.project.objects, []);

    const begin = await beginAgentLoopRun(beginInput(emptyRegistryHarness));
    assert.equal(begin.status, "error");
    if (begin.status !== "error") return;
    assert.equal(begin.error.kind, "proposal_failed");
    assert.deepEqual(emptyRegistryHarness.getState(), before);
  });
});

describe("Phase 11 controlled agent loop: CASE H -- malformed model output", () => {
  it("SECURITY INVARIANT #1: LLM output cannot directly mutate state -- a non-structured (text) proposal response is rejected, zero mutation", async () => {
    const h = buildHarness({ provider: malformedProposalProvider() });
    const before = h.getState();
    const begin = await beginAgentLoopRun(beginInput(h));
    assert.equal(begin.status, "error");
    if (begin.status !== "error") return;
    assert.equal(begin.error.kind, "proposal_failed");
    assert.deepEqual(h.getState(), before);
  });

  it("a malformed PLAN response also stops the loop before any proposal or approval exists", async () => {
    const badPlanProvider: ModelProvider = {
      describe: () => createModelProviderDescriptor({ providerId: "fake", modelId: "fake-v1", supportsStructuredOutput: true }),
      async generate(request) {
        const response = createModelResponse({ requestId: request.id, kind: "text", text: "I refuse to plan." });
        return createModelInvocationResult({
          requestId: request.id,
          providerId: "fake",
          modelId: "fake-v1",
          status: "success",
          response,
          startedAt: new Date().toISOString()
        });
      }
    };
    const h = buildHarness({ provider: badPlanProvider });
    const before = h.getState();
    const begin = await beginAgentLoopRun(beginInput(h));
    assert.equal(begin.status, "error");
    if (begin.status !== "error") return;
    assert.equal(begin.error.kind, "reasoning_failed");
    assert.deepEqual(h.getState(), before);
  });
});

describe("Phase 11 controlled agent loop: CASE I -- unauthorized operation", () => {
  it("SECURITY INVARIANT #4/#5: an approved proposal STILL cannot execute at an autonomy level below what mutation requires -- the permission layer rejects it, zero mutation", async () => {
    const h = buildHarness();
    const before = h.getState();
    const begin = await beginAndApprove(h);
    if (begin.status !== "success") return assert.fail();

    const resumed = await resumeAgentLoopRunAfterApproval({
      run: begin.run,
      getState: h.getState,
      registry: h.registry,
      approvals: h.approvals,
      autonomyGrants: h.autonomyGrants,
      autonomyLevel: "suggest" // below "approved_modify" -- mutation requires it regardless of the Approval
    });
    if (resumed.status !== "success") return assert.fail();
    assert.equal(resumed.run.status, "execution_failed");
    assert.equal(resumed.run.executionResult?.toolResult?.error?.kind, "policy_rejected");
    assert.deepEqual(h.getState(), before);
  });
});

describe("Phase 11 controlled agent loop: approval-identity invariants", () => {
  it("SECURITY INVARIANT: an approval belonging to a DIFFERENT proposal cannot authorize this run's execution", async () => {
    const h = buildHarness();
    const before = h.getState();
    const begin = await beginAgentLoopRun(beginInput(h));
    if (begin.status !== "success") return assert.fail();

    // A second, unrelated, genuinely-approved proposal/approval pair.
    const otherProposal = createProposal({ ...begin.run.proposal, planStepId: begin.run.proposal.planStepId });
    const otherApproval = h.approvals.create({ toolName: "modify_object", targetType: "object", targetId: "obj_bracket" });
    h.approvals.approve(otherApproval.id, "human");
    void otherProposal;

    const tamperedRun = { ...begin.run, approval: otherApproval };

    const resumed = await resumeAgentLoopRunAfterApproval({
      run: tamperedRun,
      getState: h.getState,
      registry: h.registry,
      approvals: h.approvals,
      autonomyGrants: h.autonomyGrants,
      autonomyLevel: "approved_modify"
    });
    assert.equal(resumed.status, "error");
    if (resumed.status !== "error") return;
    assert.equal(resumed.error.kind, "approval_not_for_proposal");
    assert.deepEqual(h.getState(), before);
  });

  it("resuming while the approval is still pending fails with 'not_approved', zero mutation", async () => {
    const h = buildHarness();
    const before = h.getState();
    const begin = await beginAgentLoopRun(beginInput(h));
    if (begin.status !== "success") return assert.fail();

    const resumed = await resumeAgentLoopRunAfterApproval({
      run: begin.run,
      getState: h.getState,
      registry: h.registry,
      approvals: h.approvals,
      autonomyGrants: h.autonomyGrants,
      autonomyLevel: "approved_modify"
    });
    assert.equal(resumed.status, "error");
    if (resumed.status !== "error") return;
    assert.equal(resumed.error.kind, "not_approved");
    assert.deepEqual(h.getState(), before);
  });

  it("resuming a run that is not 'awaiting_approval' (e.g. already completed) is rejected, never re-executed", async () => {
    const h = buildHarness();
    const begin = await beginAndApprove(h);
    if (begin.status !== "success") return assert.fail();
    const firstResume = await resumeAgentLoopRunAfterApproval({
      run: begin.run,
      getState: h.getState,
      registry: h.registry,
      approvals: h.approvals,
      autonomyGrants: h.autonomyGrants,
      autonomyLevel: "approved_modify"
    });
    if (firstResume.status !== "success") return assert.fail();
    assert.equal(firstResume.run.status, "completed");

    const stateAfterFirst = h.getState();
    const secondResume = await resumeAgentLoopRunAfterApproval({
      run: firstResume.run,
      getState: h.getState,
      registry: h.registry,
      approvals: h.approvals,
      autonomyGrants: h.autonomyGrants,
      autonomyLevel: "approved_modify"
    });
    assert.equal(secondResume.status, "error");
    if (secondResume.status !== "error") return;
    assert.equal(secondResume.error.kind, "run_not_awaiting_approval");
    assert.deepEqual(h.getState(), stateAfterFirst, "a second resume attempt on an already-completed run must not execute again");
  });

  it("REGRESSION: an Approval is only consumed on a SUCCESSFUL execution, never on a rejection/staleness/failure", async () => {
    const h = buildHarness();
    const begin = await beginAgentLoopRun(beginInput(h));
    if (begin.status !== "success") return assert.fail();
    h.approvals.reject(begin.run.approval!.id, "human");
    await resumeAgentLoopRunAfterApproval({
      run: begin.run,
      getState: h.getState,
      registry: h.registry,
      approvals: h.approvals,
      autonomyGrants: h.autonomyGrants,
      autonomyLevel: "approved_modify"
    });
    assert.equal(h.approvals.getById(begin.run.approval!.id)?.consumedAt, null);
  });

  it("SECURITY INVARIANT: APPROVAL REPLAY is blocked at the orchestrator's own level, not only inside executeTool -- even when a second, still-valid approval exists for the same tool+target", async () => {
    const h = buildHarness();
    const begin = await beginAgentLoopRun(beginInput(h));
    if (begin.status !== "success") return assert.fail();
    h.approvals.approve(begin.run.approval!.id, "human");

    // Execute once, successfully -- consumes the first approval.
    const first = await resumeAgentLoopRunAfterApproval({
      run: begin.run,
      getState: h.getState,
      registry: h.registry,
      approvals: h.approvals,
      autonomyGrants: h.autonomyGrants,
      autonomyLevel: "approved_modify"
    });
    if (first.status !== "success") return assert.fail();
    assert.equal(first.run.status, "completed");
    const stateAfterFirst = h.getState();

    // A second, independently-granted approval for the SAME tool+target
    // exists (an unusual but legal scenario -- e.g. two reviewers both
    // approved the same proposal). Hand-construct a fresh run bound
    // specifically to the FIRST (already-consumed) approval and attempt to
    // resume it again -- this must be rejected because THIS approval was
    // already used, regardless of what the second one's status is.
    const secondApproval = h.approvals.create({ toolName: "modify_object", targetType: "object", targetId: "obj_bracket", proposalId: begin.run.proposal.id });
    h.approvals.approve(secondApproval.id, "human");

    const replayRun = createAgentLoopRun({ ...begin.run, approval: h.approvals.getById(begin.run.approval!.id)! });
    const replay = await resumeAgentLoopRunAfterApproval({
      run: replayRun,
      getState: h.getState,
      registry: h.registry,
      approvals: h.approvals,
      autonomyGrants: h.autonomyGrants,
      autonomyLevel: "approved_modify"
    });
    assert.equal(replay.status, "error");
    if (replay.status !== "error") return;
    assert.equal(replay.error.kind, "not_approved");
    assert.match(replay.error.message, /already consumed/);
    assert.deepEqual(h.getState(), stateAfterFirst, "the replay attempt must not mutate anything a second time");
    // The second approval remains genuinely available/unconsumed -- this
    // test isn't claiming it's invalid, only that THIS run's own
    // (consumed) approval cannot be replayed.
    assert.equal(h.approvals.getById(secondApproval.id)?.consumedAt, null);
  });
});

describe("Phase 11 controlled agent loop: OBSERVE stage and traceability", () => {
  it("SECURITY INVARIANT #10: World Model remains the source of truth -- observationAfter is a real re-observation of getState(), not a copy of observationBefore", async () => {
    const h = buildHarness();
    const begin = await beginAndApprove(h);
    if (begin.status !== "success") return assert.fail();
    const resumed = await resumeAgentLoopRunAfterApproval({
      run: begin.run,
      getState: h.getState,
      registry: h.registry,
      approvals: h.approvals,
      autonomyGrants: h.autonomyGrants,
      autonomyLevel: "approved_modify"
    });
    if (resumed.status !== "success") return assert.fail();
    assert.notDeepEqual(resumed.run.observationAfter, resumed.run.observationBefore);
    assert.equal(resumed.run.observationAfter?.projectVersion, h.getState().project.version);
  });

  it("the run carries every field needed to reconstruct the full audit trail: observation, plan, proposal, approval, execution, post-observation", async () => {
    const h = buildHarness();
    const begin = await beginAndApprove(h);
    if (begin.status !== "success") return assert.fail();
    const resumed = await resumeAgentLoopRunAfterApproval({
      run: begin.run,
      getState: h.getState,
      registry: h.registry,
      approvals: h.approvals,
      autonomyGrants: h.autonomyGrants,
      autonomyLevel: "approved_modify"
    });
    if (resumed.status !== "success") return assert.fail();
    const run = resumed.run;
    assert.ok(run.observationBefore.id);
    assert.ok(run.plan.id);
    assert.ok(run.proposal.id);
    assert.ok(run.approval?.id);
    assert.ok(run.executionResult?.id);
    assert.ok(run.observationAfter?.id);
    assert.equal(run.proposal.planId, run.plan.id);
    assert.equal(run.approval?.proposalId, run.proposal.id);
    assert.equal(run.executionResult?.proposalId, run.proposal.id);
    assert.equal(run.executionResult?.approvalId, run.approval?.id);
  });
});

describe("Phase 11 controlled agent loop: selectPlanStepId", () => {
  it("defaults to the first pending step", async () => {
    const h = buildHarness();
    const begin = await beginAgentLoopRun(beginInput(h));
    if (begin.status !== "success") return assert.fail();
    assert.equal(begin.run.planStepId, begin.run.plan.steps[0]!.id);
  });

  it("selectFirstPendingPlanStep returns null when no pending step exists", () => {
    const noPendingPlan = { steps: [{ status: "complete" }] } as never;
    assert.equal(selectFirstPendingPlanStep(noPendingPlan), null);
  });

  it("honors a caller-supplied selector, and reports invalid_input when it selects nothing", async () => {
    const h = buildHarness();
    const before = h.getState();
    const begin = await beginAgentLoopRun({ ...beginInput(h), selectPlanStepId: () => null });
    assert.equal(begin.status, "error");
    if (begin.status !== "error") return;
    assert.equal(begin.error.kind, "invalid_input");
    assert.deepEqual(h.getState(), before);
  });
});

describe("Phase 11 controlled agent loop: observation-stage failure", () => {
  it("an invalid observe request stops the loop before any model call is made, zero mutation", async () => {
    const h = buildHarness();
    const before = h.getState();
    const begin = await beginAgentLoopRun({ ...beginInput(h), observe: { scope: "object", objectId: "does_not_exist" } });
    assert.equal(begin.status, "error");
    if (begin.status !== "error") return;
    assert.equal(begin.error.kind, "observation_failed");
    assert.deepEqual(h.getState(), before);
  });

  it("REGRESSION: a POST-EXECUTION observation failure does not discard the audit trail of a genuinely successful execution -- status becomes 'executed', not a bare top-level error", async () => {
    // A tool whose handler reports success but, as a side effect, removes
    // the very object the proposal targeted (simulating an environment/
    // World Model change that makes the post-execution re-observation's
    // scope:"object" lookup fail with entity_not_found) -- proving the
    // ExecutionResult evidence of the successful call is preserved rather
    // than lost behind a generic error.
    const provider = buildLoopProvider({ toolName: "vanish_object", input: { objectId: "obj_bracket" } });
    const h = buildHarness({ provider });
    h.registry.register(
      createTool({
        name: "vanish_object",
        target: "world_model",
        mutation: "mutate",
        inputSchema: { type: "object", properties: { objectId: { type: "string" } }, required: ["objectId"] },
        outputSchema: { type: "object", properties: {} }
      }),
      () => {
        h.setState({ ...h.getState(), project: { ...h.getState().project, objects: [] } });
        return { removed: true };
      }
    );

    const begin = await beginAgentLoopRun(beginInput(h));
    if (begin.status !== "success") return assert.fail();
    h.approvals.approve(begin.run.approval!.id, "human");

    const resumed = await resumeAgentLoopRunAfterApproval({
      run: begin.run,
      getState: h.getState,
      registry: h.registry,
      approvals: h.approvals,
      autonomyGrants: h.autonomyGrants,
      autonomyLevel: "approved_modify"
    });
    assert.equal(resumed.status, "success");
    if (resumed.status !== "success") return;
    assert.equal(resumed.run.status, "executed");
    assert.equal(resumed.run.executionResult?.outcome, "succeeded");
    assert.equal(resumed.run.executionResult?.toolResult?.status, "success");
    assert.equal(resumed.run.observationAfter, null);
    assert.equal(resumed.run.approval?.consumedAt !== null, true, "a genuinely successful execution still consumes its approval even if post-observation later fails");
  });
});
