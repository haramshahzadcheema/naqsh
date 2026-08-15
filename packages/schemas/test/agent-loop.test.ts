import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertAgentLoopRun,
  assertExecutionResult,
  createAgentLoopRun,
  createApproval,
  createObservationResult,
  createPlan,
  createProposal,
  createToolResult,
  createExecutionResult,
  deserializeAgentLoopRun,
  serializeAgentLoopRun,
  WorldModelValidationError,
  type AgentLoopRunInput,
  type ExecutionResultInput,
  type ObservationResult,
  type Plan,
  type Proposal
} from "../src/index.js";

function observation(overrides: Partial<Parameters<typeof createObservationResult>[0]> = {}): ObservationResult {
  return createObservationResult({ projectId: "proj_1", projectVersion: 1, scope: "project", ...overrides });
}

function plan(overrides: Partial<Parameters<typeof createPlan>[0]> = {}): Plan {
  return createPlan({
    projectId: "proj_1",
    projectVersion: 1,
    observationId: "obs_1",
    objectiveSummary: "Reduce mass by 20%.",
    steps: [{ id: "planstep_1", title: "Select material", description: "x", purpose: "x" }],
    ...overrides
  });
}

function proposal(overrides: Partial<Parameters<typeof createProposal>[0]> = {}): Proposal {
  return createProposal({
    projectId: "proj_1",
    projectVersion: 1,
    planId: "plan_1",
    planStepId: "planstep_1",
    objectiveSummary: "Reduce mass by 20%.",
    toolName: "modify_object",
    toolTarget: "world_model",
    input: { objectId: "obj_1", propertyKey: "material", value: "aluminum_6061" },
    target: { entityType: "object", entityId: "obj_1" },
    rationale: "Aluminum satisfies the mass requirement.",
    expectedEffect: "The bracket's material property updates to aluminum 6061.",
    ...overrides
  });
}

function buildExecutionResultInput(overrides: Partial<ExecutionResultInput> = {}): ExecutionResultInput {
  return {
    proposalId: "proposal_1",
    approvalId: "appr_1",
    toolRequestId: "treq_1",
    outcome: "succeeded",
    toolResult: createToolResult({ requestId: "treq_1", toolName: "modify_object", status: "success", output: {}, startedAt: new Date().toISOString() }),
    startedAt: new Date().toISOString(),
    ...overrides
  };
}

describe("ExecutionResult: creation and validation", () => {
  it("creates a valid execution result for a succeeded outcome", () => {
    const result = createExecutionResult(buildExecutionResultInput());
    assert.match(result.id, /^execres_/);
    assert.equal(result.outcome, "succeeded");
    assert.notEqual(result.toolResult, null);
  });

  it("rejects a 'succeeded' outcome with no toolResult -- a real execution attempt must carry real evidence", () => {
    assert.throws(
      () => createExecutionResult(buildExecutionResultInput({ toolResult: null })),
      /executionResult.toolResult must be present unless outcome is 'rejected' or 'stale'/
    );
  });

  it("accepts 'rejected'/'stale' outcomes with no toolResult -- these never reached executeTool", () => {
    const rejected = createExecutionResult(buildExecutionResultInput({ outcome: "rejected", toolResult: null, toolRequestId: null }));
    assert.equal(rejected.toolResult, null);
    const stale = createExecutionResult(buildExecutionResultInput({ outcome: "stale", toolResult: null, toolRequestId: null }));
    assert.equal(stale.toolResult, null);
  });

  it("REGRESSION: rejects a 'rejected'/'stale' outcome that DOES carry a toolResult -- these must never fabricate evidence of an attempt that never happened", () => {
    assert.throws(
      () => createExecutionResult(buildExecutionResultInput({ outcome: "rejected" })),
      /executionResult.toolResult must be null when outcome is 'rejected' or 'stale'/
    );
  });

  it("rejects an invalid outcome", () => {
    assert.throws(() => createExecutionResult(buildExecutionResultInput({ outcome: "partially_completed" as never })), /invalid executionResult.outcome/);
  });

  it("freezes the returned execution result", () => {
    const result = createExecutionResult(buildExecutionResultInput());
    assert.throws(() => {
      (result as { outcome: string }).outcome = "failed";
    }, TypeError);
  });

  it("assertExecutionResult accepts a well-formed result and rejects a malformed one", () => {
    const result = createExecutionResult(buildExecutionResultInput());
    assert.doesNotThrow(() => assertExecutionResult(result));
    assert.throws(() => assertExecutionResult({ ...result, outcome: "bogus" }), /invalid executionResult.outcome/);
  });
});

describe("AgentLoopRun: creation and validation", () => {
  function buildInput(overrides: Partial<AgentLoopRunInput> = {}): AgentLoopRunInput {
    return {
      projectId: "proj_1",
      observationBefore: observation(),
      plan: plan(),
      planStepId: "planstep_1",
      proposal: proposal(),
      ...overrides
    };
  }

  it("creates a run defaulting to status 'observed', with no approval/executionResult/observationAfter/discrepancy yet", () => {
    const run = createAgentLoopRun(buildInput());
    assert.match(run.id, /^looprun_/);
    assert.equal(run.status, "observed");
    assert.equal(run.approval, null);
    assert.equal(run.executionResult, null);
    assert.equal(run.observationAfter, null);
    assert.equal(run.discrepancy, null);
    assert.equal(run.source, "agent");
  });

  it("honors an explicit status and nested approval/executionResult", () => {
    const approval = createApproval({ toolName: "modify_object", proposalId: "proposal_x" });
    const run = createAgentLoopRun(buildInput({ status: "awaiting_approval", approval }));
    assert.equal(run.status, "awaiting_approval");
    assert.equal(run.approval?.id, approval.id);
  });

  it("rejects a malformed nested observationBefore", () => {
    assert.throws(
      () => createAgentLoopRun(buildInput({ observationBefore: { not: "an observation" } as never })),
      WorldModelValidationError
    );
  });

  it("rejects a malformed nested plan", () => {
    assert.throws(() => createAgentLoopRun(buildInput({ plan: { not: "a plan" } as never })), WorldModelValidationError);
  });

  it("rejects a malformed nested proposal", () => {
    assert.throws(() => createAgentLoopRun(buildInput({ proposal: { not: "a proposal" } as never })), WorldModelValidationError);
  });

  it("rejects an invalid status", () => {
    assert.throws(() => createAgentLoopRun(buildInput({ status: "executing_autonomously" as never })), /invalid agentLoopRun.status/);
  });

  it("rejects a discrepancy that isn't a well-formed {detected, description} shape", () => {
    assert.throws(
      () => createAgentLoopRun(buildInput({ discrepancy: { detected: "yes" } as never })),
      /detected must be a boolean/
    );
  });

  it("accepts a well-formed discrepancy", () => {
    const run = createAgentLoopRun(buildInput({ discrepancy: { detected: true, description: "Object unchanged." } }));
    assert.deepEqual(run.discrepancy, { detected: true, description: "Object unchanged." });
  });

  it("freezes the returned run", () => {
    const run = createAgentLoopRun(buildInput());
    assert.throws(() => {
      (run as { status: string }).status = "completed";
    }, TypeError);
  });

  it("round-trips through JSON with full fidelity", () => {
    const approval = createApproval({ toolName: "modify_object", proposalId: "proposal_x", status: "approved", decidedBy: "human" });
    const executionResult = createExecutionResult(buildExecutionResultInput({ approvalId: approval.id }));
    const run = createAgentLoopRun(
      buildInput({
        status: "completed",
        approval,
        executionResult,
        observationAfter: observation({ projectVersion: 2 }),
        discrepancy: { detected: false, description: "No discrepancy detected." }
      })
    );
    const roundTripped = JSON.parse(JSON.stringify(run));
    assert.deepEqual(roundTripped, run);
  });

  it("REGRESSION: serializeAgentLoopRun/deserializeAgentLoopRun round-trip with full fidelity and re-validate on the way back in", () => {
    const run = createAgentLoopRun(buildInput());
    const serialized = serializeAgentLoopRun(run);
    assert.equal(typeof serialized, "string");
    const deserialized = deserializeAgentLoopRun(serialized);
    assert.deepEqual(deserialized, run);
  });

  it("deserializeAgentLoopRun rejects a malformed serialized run rather than silently accepting it", () => {
    assert.throws(() => deserializeAgentLoopRun(JSON.stringify({ not: "a run" })), WorldModelValidationError);
    assert.throws(() => deserializeAgentLoopRun(""), WorldModelValidationError);
  });

  it("assertAgentLoopRun accepts a well-formed run and rejects a malformed one", () => {
    const run = createAgentLoopRun(buildInput());
    assert.doesNotThrow(() => assertAgentLoopRun(run));
    assert.throws(() => assertAgentLoopRun({ ...run, status: "bogus" }), /invalid agentLoopRun.status/);
  });
});
