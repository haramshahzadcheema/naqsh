import type { Approval, EntitySource, ToolResult } from "./types.js";
import type { ObservationResult } from "./observation-types.js";
import type { Plan } from "./plan-types.js";
import type { Proposal } from "./proposal-types.js";

/**
 * The Controlled Agent Loop contracts (P11):
 *
 *   OBSERVE -> REASON -> PROPOSE -> APPROVAL -> EXECUTE -> OBSERVE
 *
 * These types describe the auditable RECORD of one pass through that loop,
 * not a new parallel state system. Every stage already has a real,
 * independently-validated type from an earlier phase: OBSERVE produces an
 * `ObservationResult` (P8), REASON produces a `Plan` (P9), PROPOSE produces
 * a `Proposal` (P10), and EXECUTE runs through the exact same `executeTool`
 * boundary (P3/P4) every other tool call does. `AgentLoopRun` (below) is
 * simply the traceable THREAD tying one instance of each together, the same
 * relationship `Change` (P2) has to `WorldModelTransition`: it records that
 * a sequence of already-real operations happened, in order, with real
 * before/after evidence -- it does not reimplement any of them.
 *
 * Nothing here can construct a "successful execution" out of a model's
 * claim: `ExecutionResult.outcome`/`toolResult` are always derived from a
 * real `ToolResult` returned by `packages/core`'s `executeTool` (or from a
 * deterministic pre-execution rejection -- stale proposal, missing/invalid
 * approval -- that never even reaches `executeTool`), never from
 * `Proposal.expectedEffect` (free text) or any other model-authored prose.
 */

/**
 * An `AgentLoopRun`'s own lifecycle. Each value corresponds to exactly one
 * stage boundary in the OBSERVE->REASON->PROPOSE->APPROVAL->EXECUTE->OBSERVE
 * pipeline having been reached:
 *   "observed"          -> stage 1 done (an ObservationResult exists)
 *   "reasoned"           -> stage 2 done (a Plan exists)
 *   "proposed"           -> stage 3 done (a Proposal exists)
 *   "awaiting_approval"  -> stage 4 requested, not yet decided
 *   "rejected"           -> the requested approval was rejected/revoked --
 *                            the loop ends here, nothing executes
 *   "stale"              -> the World Model changed after the proposal was
 *                            generated in a way that makes it unsafe to
 *                            execute -- the loop ends here, nothing executes
 *   "execution_failed"   -> stage 5 was attempted and the underlying tool
 *                            call itself failed (ToolResult.status "error")
 *   "executed"           -> stage 5 succeeded (ToolResult.status "success")
 *                            but stage 6 (the post-execution OBSERVE) could
 *                            not be completed -- e.g. the targeted entity no
 *                            longer resolves under the requested scope. The
 *                            execution evidence (ExecutionResult) is still
 *                            fully recorded; only `observationAfter`/
 *                            `discrepancy` are absent. Terminal, not retried
 *                            automatically.
 *   "completed"          -> stage 6 also done: a post-execution
 *                            ObservationResult was recorded (with or
 *                            without a discrepancy)
 *   "failed"             -> a stage itself could not even be attempted
 *                            (e.g. reasoning/proposal generation errored)
 */
export type AgentLoopRunStatus =
  | "observed"
  | "reasoned"
  | "proposed"
  | "awaiting_approval"
  | "rejected"
  | "stale"
  | "execution_failed"
  | "executed"
  | "completed"
  | "failed";

export const AGENT_LOOP_RUN_STATUSES: readonly AgentLoopRunStatus[] = [
  "observed",
  "reasoned",
  "proposed",
  "awaiting_approval",
  "rejected",
  "stale",
  "execution_failed",
  "executed",
  "completed",
  "failed"
];

/**
 * The specific set of outcomes an actual EXECUTE attempt can reach.
 * Deliberately narrower than the P11 brief's full illustrative list
 * (requested/approved/started/succeeded/failed/rejected/stale/partially_
 * completed): "requested"/"approved"/"started" are already represented by
 * `AgentLoopRun.status`'s own progression leading up to execution, not by
 * `ExecutionResult` (which only exists once an execution attempt was either
 * made or deterministically blocked) -- duplicating them here would be a
 * second, driftable copy of the same axis. "partially_completed" is
 * omitted because this architecture's execution primitive (one
 * `executeTool` call) is atomic by construction: a `ToolResult` is always
 * wholly "success" or wholly "error", so a "partially_completed" value
 * could never be genuinely reachable -- adding it now would be exactly the
 * kind of fabricated, unreachable status this codebase's `missingInformation`/
 * `ambiguityIndicators` precedent (P8) forbids.
 */
export type ExecutionOutcome = "succeeded" | "failed" | "rejected" | "stale";

export const EXECUTION_OUTCOMES: readonly ExecutionOutcome[] = ["succeeded", "failed", "rejected", "stale"];

/**
 * The structured record of one EXECUTE attempt. `toolResult` is `null`
 * exactly when `outcome` is `"rejected"` or `"stale"` -- both are
 * deterministic PRE-execution rejections (no approval, or a stale proposal)
 * that never reach `executeTool` at all, so there is no `ToolResult` to
 * report; for `"succeeded"`/`"failed"`, `toolResult` is always the REAL
 * `ToolResult` `executeTool` returned, never fabricated.
 */
export interface ExecutionResult {
  id: string;
  /** The `Proposal.id` this execution attempt realizes. */
  proposalId: string;
  /** The `Approval.id` that authorized this attempt, or `null` if none was
   * ever granted (the `"rejected"`/`"stale"` outcomes). */
  approvalId: string | null;
  /** The `ToolRequest.id` `executeTool` produced, or `null` when execution
   * never reached `executeTool` (`"rejected"`/`"stale"`). */
  toolRequestId: string | null;
  outcome: ExecutionOutcome;
  /** The real `ToolResult` from `executeTool`, or `null` for a pre-execution
   * rejection -- see this type's own doc comment. */
  toolResult: ToolResult | null;
  startedAt: string;
  completedAt: string;
  metadata: Record<string, unknown>;
}

export interface ExecutionResultInput {
  id?: string;
  proposalId: string;
  approvalId?: string | null;
  toolRequestId?: string | null;
  outcome: ExecutionOutcome;
  toolResult?: ToolResult | null;
  startedAt: string;
  completedAt?: string;
  metadata?: Record<string, unknown>;
}

/**
 * "COMMAND SUCCEEDED != OBJECTIVE SATISFIED" (P11 brief) made concrete: a
 * structural, deterministic comparison of the proposal's declared
 * `target` entity between the pre- and post-execution `ObservationResult`s,
 * never a re-interpretation of `Proposal.expectedEffect` prose. `detected:
 * true` means execution reported success but the targeted entity's
 * observable state did not actually change -- a real, checkable discrepancy,
 * not a guess.
 */
export interface LoopDiscrepancy {
  detected: boolean;
  description: string;
}

/**
 * The complete, traceable audit record of one pass through the controlled
 * agent loop (P11 brief, "CHANGE / AUDIT RECORD"): a reviewer can
 * reconstruct what was observed, what objective was pursued, what was
 * reasoned about, what was proposed and why, what approval was requested
 * and by whom it was decided, what exactly executed, what the environment/
 * World Model reported, and what the post-execution observation showed --
 * entirely from this one value, without a second hidden state system.
 *
 * Every nested value is the REAL object each stage produced (an actual
 * `ObservationResult`/`Plan`/`Proposal`/`Approval`/`ExecutionResult`), the
 * same "embed the real evidence, don't just point at it" discipline
 * `Change.before`/`Change.after` (P2) already established -- there is no
 * `ObservationStore`/`PlanStore`/`ProposalStore` this run could dangle a
 * reference into (none exist yet, by deliberate P9/P10 design), so an
 * id-only reference would be unresolvable the moment this value outlives
 * its creating call.
 */
export interface AgentLoopRun {
  id: string;
  projectId: string;
  observationBefore: ObservationResult;
  plan: Plan;
  planStepId: string;
  proposal: Proposal;
  /** The approval requested/decided for `proposal`, or `null` before one
   * has been requested yet. */
  approval: Approval | null;
  executionResult: ExecutionResult | null;
  observationAfter: ObservationResult | null;
  discrepancy: LoopDiscrepancy | null;
  status: AgentLoopRunStatus;
  /** Who/what initiated this run. Typically `"agent"`. */
  source: EntitySource;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface AgentLoopRunInput {
  id?: string;
  projectId: string;
  observationBefore: ObservationResult;
  plan: Plan;
  planStepId: string;
  proposal: Proposal;
  approval?: Approval | null;
  executionResult?: ExecutionResult | null;
  observationAfter?: ObservationResult | null;
  discrepancy?: LoopDiscrepancy | null;
  status?: AgentLoopRunStatus;
  source?: EntitySource;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Every distinct way the AGENT LOOP ORCHESTRATION ITSELF can decline to
 * advance -- never a bare `Error("loop failed")`. Mirrors
 * `ProposalGenerationErrorKind`/`PlanGenerationErrorKind`'s granularity and
 * "be specific, not generic" discipline, extended with the stage-specific
 * denial reasons P11 introduces:
 *   "invalid_input"              -> malformed caller input (a bad run,
 *                                    a bad options object)
 *   "observation_failed"         -> observeProject itself rejected the
 *                                    request (invalid scope/focus)
 *   "reasoning_failed"           -> generatePlanProposal returned an error
 *   "proposal_failed"            -> generateProposal returned an error
 *   "run_not_awaiting_approval"  -> resumeAgentLoopRun was called on a run
 *                                    that never reached "awaiting_approval"
 *   "approval_not_found"         -> the referenced Approval id does not
 *                                    exist in the given ApprovalStore
 *   "approval_not_for_proposal"  -> the approval exists but its
 *                                    `proposalId` does not match this run's
 *                                    proposal -- the exact "approval must be
 *                                    associated with the EXACT proposal"
 *                                    invariant the P11 brief requires
 *   "proposal_stale"             -> the World Model has moved on since this
 *                                    proposal was generated (its
 *                                    projectVersion no longer matches
 *                                    current state) -- execution is refused
 *                                    even if an approval exists
 *   "not_approved"                -> the approval's status is still
 *                                    "pending"/"rejected"/"revoked"
 *   "execution_failed"            -> executeTool itself returned an error
 *                                    result (unknown tool, invalid input,
 *                                    policy rejection, handler failure, or
 *                                    invalid output)
 */
export type AgentLoopErrorKind =
  | "invalid_input"
  | "observation_failed"
  | "reasoning_failed"
  | "proposal_failed"
  | "run_not_awaiting_approval"
  | "approval_not_found"
  | "approval_not_for_proposal"
  | "proposal_stale"
  | "not_approved"
  | "execution_failed";

export const AGENT_LOOP_ERROR_KINDS: readonly AgentLoopErrorKind[] = [
  "invalid_input",
  "observation_failed",
  "reasoning_failed",
  "proposal_failed",
  "run_not_awaiting_approval",
  "approval_not_found",
  "approval_not_for_proposal",
  "proposal_stale",
  "not_approved",
  "execution_failed"
];
