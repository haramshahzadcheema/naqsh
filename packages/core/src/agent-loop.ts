import {
  createAgentLoopRun,
  createExecutionResult,
  toIsoTimestamp,
  type AgentLoopErrorKind,
  type AgentLoopRun,
  type AutonomyLevel,
  type EntitySource,
  type LoopDiscrepancy,
  type ObservationResult,
  type Plan,
  type Proposal,
  type WorldModelState
} from "@naqsh/schemas";
import type { ApprovalStore } from "./approval-store.js";
import type { AutonomyGrantStore } from "./autonomy-grant-store.js";
import { createExecuteToolAuthorizer } from "./authorization.js";
import { executeTool } from "./execute-tool.js";
import { observeProject, type ObserveProjectOptions } from "./observe-project.js";
import { generatePlanProposal, type GeneratePlanOptions } from "./planner.js";
import { generateProposal, type GenerateProposalOptions } from "./proposal-generator.js";
import { requestProposalApproval } from "./proposal-approval.js";
import type { ModelProvider } from "./model-provider.js";
import type { ToolRegistry } from "./tool-registry.js";

/**
 * The Phase 11 controlled agent loop:
 *
 *   OBSERVE -> REASON -> PROPOSE -> APPROVAL -> EXECUTE -> OBSERVE
 *
 * Deliberately implemented as TWO separately-callable, independently-
 * testable entry points rather than one function, because approval is a
 * genuinely asynchronous, human-in-the-loop boundary -- a single function
 * spanning it would either have to block indefinitely or fake synchronous
 * approval, neither of which reflects how this system is meant to work:
 *
 *   beginAgentLoopRun()             : OBSERVE -> REASON -> PROPOSE ->
 *                                      (request) APPROVAL, then STOPS.
 *                                      Returns an `AgentLoopRun` with
 *                                      status "awaiting_approval" (or an
 *                                      earlier failure status).
 *   resumeAgentLoopRunAfterApproval(): reads back whatever a human (or a
 *                                      future policy) already decided on
 *                                      the requested Approval, and ONLY
 *                                      THEN -> EXECUTE -> OBSERVE.
 *
 * Every stage this file touches is either an ALREADY-real, independently
 * tested P8/P9/P10 function (`observeProject`, `generatePlanProposal`,
 * `generateProposal`) or P4's unmodified authorization machinery
 * (`createExecuteToolAuthorizer`, `ApprovalStore`, `AutonomyGrantStore`) --
 * this file adds orchestration and the audit record, never a second
 * implementation of anything those phases already built.
 *
 * THE critical invariant this file exists to enforce: NO APPROVAL -> NO
 * MUTATION. `resumeAgentLoopRunAfterApproval` never calls `executeTool`
 * unless (a) the run is genuinely `"awaiting_approval"`, (b) the CURRENT
 * state of the referenced `Approval` (re-read from the store, never trusted
 * from a stale in-memory copy) is `"approved"`, (c) that approval's own
 * `proposalId` matches this exact proposal, and (d) the proposal's
 * `projectVersion` still matches the CURRENT World Model version (not
 * stale). Any one of these failing routes to a terminal, non-executing
 * status ("rejected"/"stale") before `executeTool` is ever reached -- there
 * is no path in this file from a Proposal to a mutation that skips these
 * checks.
 */

export function isProposalStale(proposal: Proposal, state: WorldModelState): boolean {
  return proposal.projectVersion !== state.project.version;
}

/** Default step selection: the first `"pending"` step in dependency order
 * (`plan.steps` is already ordered; a real caller -- a future UI, or a more
 * deliberate agent -- may supply its own selector). Returns `null` when no
 * pending step exists, which `beginAgentLoopRun` reports as `invalid_input`
 * rather than guessing. */
export function selectFirstPendingPlanStep(plan: Plan): string | null {
  const step = plan.steps.find((candidate) => candidate.status === "pending");
  return step ? step.id : null;
}

export interface BeginAgentLoopRunInput {
  getState: () => WorldModelState;
  observe: ObserveProjectOptions;
  provider: ModelProvider;
  registry: ToolRegistry;
  approvals: ApprovalStore;
  planOptions: GeneratePlanOptions;
  proposalOptions: GenerateProposalOptions;
  /** Chooses which step of the freshly-generated plan to realize. Defaults
   * to `selectFirstPendingPlanStep`. P11 never chooses autonomously beyond
   * this simple, deterministic, overridable default -- prioritizing among
   * multiple candidate steps is a planning concern out of this phase's
   * scope. */
  selectPlanStepId?: (plan: Plan) => string | null;
  source?: EntitySource;
  requestedBy?: EntitySource;
  approvalExpiresAt?: string | null;
}

export type AgentLoopRunResult =
  | { status: "success"; run: AgentLoopRun }
  | { status: "error"; error: { kind: AgentLoopErrorKind; message: string } };

/**
 * OBSERVE -> REASON -> PROPOSE -> (request) APPROVAL. Never throws for an
 * expected failure mode -- the same discipline `generatePlanProposal`/
 * `generateProposal` already established: a caller branches on
 * `result.status`. Stops the instant any stage fails; a failure at any
 * stage produces zero World Model mutation (nothing before EXECUTE can
 * mutate anything -- see `repo-boundaries.test.ts`'s P11 guards).
 */
export async function beginAgentLoopRun(input: BeginAgentLoopRunInput): Promise<AgentLoopRunResult> {
  const state = input.getState();

  let observation: ObservationResult;
  try {
    observation = observeProject(state, input.observe);
  } catch (error) {
    return { status: "error", error: { kind: "observation_failed", message: error instanceof Error ? error.message : String(error) } };
  }

  const planResult = await generatePlanProposal(input.provider, observation, input.planOptions);
  if (planResult.status === "error") {
    return { status: "error", error: { kind: "reasoning_failed", message: planResult.error.message } };
  }
  const plan = planResult.plan;

  const selectPlanStepId = input.selectPlanStepId ?? selectFirstPendingPlanStep;
  const planStepId = selectPlanStepId(plan);
  if (!planStepId) {
    return { status: "error", error: { kind: "invalid_input", message: "No plan step was selected to realize" } };
  }

  const proposalResult = await generateProposal(input.provider, input.registry, plan, planStepId, input.proposalOptions);
  if (proposalResult.status === "error") {
    return { status: "error", error: { kind: "proposal_failed", message: proposalResult.error.message } };
  }
  const proposal = proposalResult.proposal;

  const approval = requestProposalApproval(input.approvals, proposal, {
    requestedBy: input.requestedBy ?? "agent",
    expiresAt: input.approvalExpiresAt ?? null
  });

  const run = createAgentLoopRun({
    projectId: observation.projectId,
    observationBefore: observation,
    plan,
    planStepId,
    proposal,
    approval,
    status: "awaiting_approval",
    source: input.source ?? "agent"
  });

  return { status: "success", run };
}

/** Structural, deterministic "COMMAND SUCCEEDED != OBJECTIVE SATISFIED"
 * check (P11 brief): compares the proposal's declared target entity between
 * the pre- and post-execution observations. Never re-interprets
 * `Proposal.expectedEffect` prose -- only entityType "object" (the only
 * kind `modify-object-tool.ts`/`modify-environment-object-tool.ts` can
 * currently affect) is checked; any other target shape, or no target at
 * all (a CREATE-flavored proposal), is reported as "not checked" rather
 * than guessed. */
function detectDiscrepancy(before: ObservationResult, after: ObservationResult, proposal: Proposal): LoopDiscrepancy {
  if (proposal.toolTarget !== "world_model") {
    // The post-execution `observationAfter` this function is handed is
    // ALWAYS a re-observation of WorldModelState (see
    // resumeAgentLoopRunAfterApproval) -- for an "environment"-target
    // proposal (e.g. modify_environment_object), a successful execution
    // never touches WorldModelState at all by design (see this file's own
    // module doc comment and modify-environment-object-tool.ts). Comparing
    // World Model snapshots for such a proposal would ALWAYS report a false
    // "unchanged" discrepancy regardless of whether the environment update
    // actually succeeded -- reporting "not checked" here is the honest
    // answer, not a guess in either direction.
    return {
      detected: false,
      description: `Discrepancy detection is only implemented for toolTarget "world_model" (got "${proposal.toolTarget}") -- this proposal's effect is not observable through WorldModelState.`
    };
  }
  if (!proposal.target || proposal.target.entityId === null) {
    return {
      detected: false,
      description: "Proposal did not target a specific existing entity; no before/after comparison is defined."
    };
  }
  if (proposal.target.entityType !== "object") {
    return {
      detected: false,
      description: `Discrepancy detection is only implemented for entityType "object" (got "${proposal.target.entityType}").`
    };
  }
  const entityId = proposal.target.entityId;
  const beforeObject = before.objects.find((object) => object.id === entityId) ?? null;
  const afterObject = after.objects.find((object) => object.id === entityId) ?? null;
  if (!afterObject) {
    return { detected: true, description: `Object "${entityId}" no longer exists after execution reported success.` };
  }
  if (beforeObject && JSON.stringify(beforeObject) === JSON.stringify(afterObject)) {
    return {
      detected: true,
      description: `Execution reported success, but object "${entityId}" is unchanged from before execution.`
    };
  }
  return { detected: false, description: "No discrepancy detected." };
}

export interface ResumeAgentLoopRunInput {
  run: AgentLoopRun;
  getState: () => WorldModelState;
  registry: ToolRegistry;
  approvals: ApprovalStore;
  autonomyGrants: AutonomyGrantStore;
  autonomyLevel: AutonomyLevel;
  source?: EntitySource;
}

/**
 * (read back) APPROVAL -> EXECUTE -> OBSERVE. Only ever called after
 * `beginAgentLoopRun` produced a run with status `"awaiting_approval"` AND
 * a human (or a future policy) has since decided the requested `Approval`
 * via the SAME `ApprovalStore` (`approvals.approve`/`reject`/`revoke` --
 * P4, unmodified). This function re-reads that decision itself; it never
 * trusts `run.approval`'s own (necessarily stale, "pending") snapshot for
 * the actual authorization decision.
 *
 * Note there is no `setState` here: this function never writes
 * `WorldModelState` itself. If `executeTool` invokes a "mutate" tool (e.g.
 * `modify_object`), the actual write happens inside THAT tool's own
 * handler, through its own `recordTransition` call and its own
 * `getState`/`setState` closure (see `modify-object-tool.ts`) -- the same
 * "the handler owns its effect, the boundary only decides whether to call
 * it" separation `executeTool` (P3) already established for every other
 * tool. `getState` below is read-only: used for the staleness check and to
 * observe again after `executeTool` returns.
 */
export async function resumeAgentLoopRunAfterApproval(input: ResumeAgentLoopRunInput): Promise<AgentLoopRunResult> {
  const { run } = input;

  if (run.status !== "awaiting_approval") {
    return {
      status: "error",
      error: { kind: "run_not_awaiting_approval", message: `Run "${run.id}" is not awaiting approval (status: "${run.status}")` }
    };
  }
  if (!run.approval) {
    return { status: "error", error: { kind: "approval_not_found", message: `Run "${run.id}" has no associated approval` } };
  }

  const currentApproval = input.approvals.getById(run.approval.id);
  if (!currentApproval) {
    return { status: "error", error: { kind: "approval_not_found", message: `No approval with id "${run.approval.id}" exists` } };
  }
  if (currentApproval.proposalId !== run.proposal.id) {
    return {
      status: "error",
      error: {
        kind: "approval_not_for_proposal",
        message: `Approval "${currentApproval.id}" is associated with proposal "${currentApproval.proposalId}", not "${run.proposal.id}"`
      }
    };
  }

  const startedAt = toIsoTimestamp();

  if (currentApproval.status === "rejected" || currentApproval.status === "revoked") {
    const executionResult = createExecutionResult({
      proposalId: run.proposal.id,
      approvalId: currentApproval.id,
      outcome: "rejected",
      startedAt
    });
    return {
      status: "success",
      run: createAgentLoopRun({ ...run, approval: currentApproval, executionResult, status: "rejected", updatedAt: toIsoTimestamp() })
    };
  }
  if (currentApproval.status === "pending") {
    return { status: "error", error: { kind: "not_approved", message: `Approval "${currentApproval.id}" is still pending` } };
  }
  if (currentApproval.consumedAt !== null) {
    // Defense in depth against APPROVAL REPLAY: `executeTool`'s own
    // authorize hook (createExecuteToolAuthorizer -> evaluateApproval)
    // already denies an already-consumed approval when IT is the only
    // approval matching this tool+target -- but that decision is derived
    // generically by tool+target, not by this run's specific approval id.
    // If a second, distinct, still-valid approval happens to exist for the
    // same tool+target (a legitimate but unusual scenario -- e.g. the same
    // proposal was approved twice by two different reviewers),
    // evaluateApproval's "most specific match" logic could pick THAT one
    // instead and authorize execution even though THIS run's own approval
    // was already used. Checking here, against this run's own resolved
    // `currentApproval` specifically, closes that gap independently of
    // whatever else exists in the store.
    return {
      status: "error",
      error: { kind: "not_approved", message: `Approval "${currentApproval.id}" was already consumed and cannot authorize another execution` }
    };
  }

  // currentApproval.status === "approved" and unconsumed from here on.
  const stateBeforeExecution = input.getState();
  if (isProposalStale(run.proposal, stateBeforeExecution)) {
    const executionResult = createExecutionResult({
      proposalId: run.proposal.id,
      approvalId: currentApproval.id,
      outcome: "stale",
      startedAt
    });
    return {
      status: "success",
      run: createAgentLoopRun({ ...run, approval: currentApproval, executionResult, status: "stale", updatedAt: toIsoTimestamp() })
    };
  }

  const authorize = createExecuteToolAuthorizer({
    autonomyLevel: input.autonomyLevel,
    approvals: input.approvals,
    autonomyGrants: input.autonomyGrants
  });

  const { request, result } = await executeTool(input.registry, {
    toolName: run.proposal.toolName,
    input: run.proposal.input,
    source: input.source ?? "agent",
    target: run.proposal.target,
    authorize
  });

  // Capture the POST-consume snapshot (createApproval/ApprovalStore.consume
  // never mutates the object currentApproval already points at -- every
  // store transition returns a NEW frozen snapshot, see approval-store.ts)
  // so the run's own embedded `approval` field reflects that this approval
  // was actually used, not the pre-consume "approved but unconsumed" state.
  let finalApproval = currentApproval;
  if (result.status === "success" && currentApproval.consumedAt === null) {
    try {
      finalApproval = input.approvals.consume(currentApproval.id);
    } catch {
      // A racing caller already consumed it -- the execution itself still
      // happened and is reported accurately regardless; this is not a
      // reason to fail an already-completed execution. Re-read the current
      // stored snapshot so the run still reflects reality.
      finalApproval = input.approvals.getById(currentApproval.id) ?? currentApproval;
    }
  }

  const executionResult = createExecutionResult({
    proposalId: run.proposal.id,
    approvalId: currentApproval.id,
    toolRequestId: request.id,
    outcome: result.status === "success" ? "succeeded" : "failed",
    toolResult: result,
    startedAt
  });

  if (result.status !== "success") {
    return {
      status: "success",
      run: createAgentLoopRun({ ...run, approval: currentApproval, executionResult, status: "execution_failed", updatedAt: toIsoTimestamp() })
    };
  }

  const stateAfterExecution = input.getState();
  let observationAfter: ObservationResult;
  try {
    observationAfter =
      run.proposal.target && run.proposal.target.entityType === "object" && run.proposal.target.entityId
        ? observeProject(stateAfterExecution, { scope: "object", objectId: run.proposal.target.entityId })
        : observeProject(stateAfterExecution, { scope: "project" });
  } catch (error) {
    // Execution already genuinely SUCCEEDED at this point -- the tool ran,
    // `executionResult` above is real evidence of it, and `finalApproval`
    // reflects it was consumed. Discarding all of that in favor of a bare
    // top-level error (as an earlier version of this function did) would
    // lose exactly the audit trail Phase 11 exists to preserve: a caller
    // would have no `AgentLoopRun` at all reflecting that the mutation
    // happened, purely because the SEPARATE post-execution observation
    // step failed (e.g. the targeted object no longer resolves under the
    // requested scope). "executed" is the honest terminal status here --
    // execution completed, but the loop could not complete its own
    // post-execution OBSERVE step to confirm/deny the outcome.
    return {
      status: "success",
      run: createAgentLoopRun({
        ...run,
        approval: finalApproval,
        executionResult,
        status: "executed",
        updatedAt: toIsoTimestamp(),
        metadata: { ...run.metadata, postExecutionObservationError: error instanceof Error ? error.message : String(error) }
      })
    };
  }

  const discrepancy = detectDiscrepancy(run.observationBefore, observationAfter, run.proposal);

  return {
    status: "success",
    run: createAgentLoopRun({
      ...run,
      approval: finalApproval,
      executionResult,
      observationAfter,
      discrepancy,
      status: "completed",
      updatedAt: toIsoTimestamp()
    })
  };
}
