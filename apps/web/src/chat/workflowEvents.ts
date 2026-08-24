import type { Approval, Candidate, Check, DesignSpecification, ObjectiveSatisfactionResult, Plan, Proposal, VerificationResult } from "@naqsh/schemas";

/**
 * The frontend counterpart of `apps/api/src/workflowEvents.ts`'s
 * `ChatWorkflowEvent` -- redeclared here (never imported across the
 * apps/api <-> apps/web boundary, which only exists as HTTP) with a
 * `messageId` added so a card can be anchored under the exact assistant
 * message that produced it, the same pattern `ExtractionEvent.messageId`
 * (`onboarding/types.ts`) already uses for requirement-capture chips.
 */
export type ChatWorkflowUiEvent =
  | { id: string; messageId: string; kind: "plan_created"; plan: Plan }
  | { id: string; messageId: string; kind: "proposal_created"; proposal: Proposal; approvalId: string }
  | {
      id: string;
      messageId: string;
      kind: "exploration_prepared";
      planId: string;
      planStepId: string;
      candidates: Array<{ designSpecification: DesignSpecification; candidate: Candidate }>;
      failures: Array<{ kind: string; message: string }>;
      pendingApprovals: Approval[];
      allowedTools: string[];
      /** Set once the human-approved job has actually been submitted --
       * `null` until then. Rendered by ExplorationCard as "Exploration
       * started" instead of the approval checklist. */
      submittedJobId: string | null;
    }
  | { id: string; messageId: string; kind: "workflow_failed"; stage: "planning" | "proposal" | "exploration"; message: string };

/** Mirrors `apps/api/src/engineeringWorkflow.ts`'s `ExecutionReport` --
 * the exact JSON `POST /proposals/:proposalId/execute` returns. Kept as
 * three explicitly separate verdicts (never collapsed into one boolean):
 * execution success, deterministic verification, and objective
 * satisfaction are genuinely different questions with genuinely different
 * answers. */
export interface ExecutionReport {
  execution: { status: "success" | "failed"; message: string; checkpointId: string | null; propertyChanges: unknown[] };
  verification: { status: "passed" | "failed" | "inconclusive" | "not_run"; results: VerificationResult[]; checks: Check[] };
  objective: { status: "satisfied" | "not_satisfied" | "unknown"; result: ObjectiveSatisfactionResult | null };
  /** P11's real "COMMAND SUCCEEDED != OBJECTIVE SATISFIED" structural
   * check: a deterministic before/after comparison of the proposal's
   * target entity, computed by the real controlled agent loop
   * (`resumeAgentLoopRunAfterApproval`, @naqsh/core) -- independent of
   * `verification` (which checks one specific property against one
   * specific expected value). `null` when discrepancy detection never ran
   * (execution was rejected/stale/failed before reaching it). */
  discrepancy: { detected: boolean; description: string } | null;
}

/** The real, currently-in-flight state of approving/executing one
 * proposal -- rendered as an execution-state indicator that corresponds
 * to an actual backend call in flight, never a fabricated progress
 * animation (see `ExecutionStatus.tsx`'s own doc comment). */
export type ExecutionUiState =
  | { status: "approving" }
  | { status: "executing" }
  | { status: "done"; report: ExecutionReport }
  | { status: "error"; kind: string; message: string };
