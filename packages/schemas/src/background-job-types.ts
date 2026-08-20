import type { AutonomyLevel, EntitySource } from "./types.js";

/**
 * Phase 25: BOUNDED BACKGROUND EXPERIMENTATION.
 *
 * P25 is NOT "make the agent autonomous." A `BackgroundJob` is a bounded
 * amount of engineering work -- "evaluate up to N candidates" -- executed
 * asynchronously but never unboundedly: every dimension that could let a
 * job run forever (iterations, wall-clock time, tool calls, model calls,
 * candidate count) carries an explicit, validated, finite cap
 * (`JobBudget`), enforced centrally by the runner (`background-job-runner.ts`,
 * core) before every bounded operation -- never left for an individual
 * tool call to remember to check.
 *
 * ARCHITECTURAL RULE: P25 sits ABOVE the existing systems, never replaces
 * or duplicates them:
 *   - `candidateIds` REFERENCE real `Candidate`s (P22) by id -- a
 *     `BackgroundJob` never re-describes a candidate or invents a second
 *     candidate concept.
 *   - Candidate execution is delegated to the EXISTING, unmodified
 *     `executeExperimentForCandidate` (P22) -- checkpoint isolation,
 *     `Experiment` recording, and build execution all stay exactly as P22
 *     already built them.
 *   - Verification stays P16's job: a `JobCandidateResult` carries
 *     `verificationResultIds` REFERENCING real `VerificationResult`s a
 *     caller-supplied verification step produced through the real,
 *     registered `run_verification` tool -- the runner never invents its
 *     own notion of "passed."
 *   - `optimizationResultId`/`objectiveSatisfactionResultId` on `JobResult`
 *     REFERENCE real P23/P17 records computed AFTER the bounded candidate
 *     loop finishes -- the runner never recomputes Pareto dominance or an
 *     objective-satisfaction verdict itself.
 *   - Authorization is P4's, unmodified: a job carries an `autonomyLevel`
 *     and an `allowedTools` scope, both consumed by the EXISTING
 *     `createExecuteToolAuthorizer`/`evaluateToolAuthorization` -- P25
 *     never invents a second permission model, and a job created under
 *     `"observe"` can no more mutate the environment than any other
 *     `"observe"`-level caller.
 *
 * `BackgroundJob` therefore does NOT duplicate `Experiment`/`Candidate`/
 * `VerificationResult`/`OptimizationResult`/`ObjectiveSatisfactionResult`
 * -- it is the SCOPE + BUDGET + PROGRESS wrapper around bounded,
 * already-real execution of them, living in its own store
 * (`BackgroundJobStore`, core), never `WorldModelState` and never written
 * via the Change Model (mirrors `MemoryRecord`'s (P24) identical "process/
 * execution record, not project state" precedent).
 */

// ---------------------------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------------------------

/**
 * The finite job state machine (brief's own exact vocabulary). Invalid
 * transitions (e.g. `completed` -> `running`) are rejected by
 * `BackgroundJobStore` (core), never silently allowed -- there is no
 * retry/resume model in this phase that would make `completed` a
 * non-terminal state (see this file's own top doc comment on
 * `JobStopReason` for why a fresh job, not a resurrected one, is how a
 * retry is expressed).
 *
 *   queued     -- created, not yet started. Only state `submit_background_job`
 *                 (core) ever produces.
 *   running    -- the bounded loop is actively executing.
 *   paused     -- explicitly suspended at a safe iteration boundary; no
 *                 candidate is mid-execution while paused. HONEST STATUS
 *                 NOTE: this transition exists in the state machine for a
 *                 FUTURE caller to build on, but as of this phase NOTHING
 *                 in `background-job-runner.ts` or any P25 tool ever
 *                 actually produces it -- `runBackgroundJob`'s own loop
 *                 checks for cancellation only, never a pause request. Do
 *                 not infer that pausing a running job is currently
 *                 possible through any code path this repository ships.
 *   cancelling -- a cancellation was requested but the worker has not yet
 *                 acknowledged it at a safe boundary (cooperative
 *                 cancellation, never a forced kill -- see
 *                 `background-job-runner.ts`'s own doc comment).
 *   cancelled  -- terminal. The worker acknowledged cancellation at a safe
 *                 boundary and stopped.
 *   completed  -- terminal. The bounded loop ran to its natural end (every
 *                 candidate attempted, or the runner otherwise reports
 *                 `stopReason: "completed"`).
 *   failed     -- terminal. An unrecoverable error stopped the job before
 *                 it could reach `completed`/`cancelled`.
 */
export type JobStatus = "queued" | "running" | "paused" | "cancelling" | "cancelled" | "completed" | "failed";

export const JOB_STATUSES: readonly JobStatus[] = ["queued", "running", "paused", "cancelling", "cancelled", "completed", "failed"];

/** Every legal `JobStatus` transition -- the single source of truth
 * `BackgroundJobStore.transition` (core) enforces. Deliberately explicit
 * (a Set of `"from->to"` strings) rather than a permissive "any non-terminal
 * status can move to any other" rule, so a nonsense transition like
 * `completed -> running` is rejected by construction, not by convention. */
export const JOB_STATUS_TRANSITIONS: ReadonlySet<string> = new Set([
  "queued->running",
  "queued->cancelled",
  "running->paused",
  "running->cancelling",
  "running->completed",
  "running->failed",
  "paused->running",
  "paused->cancelling",
  "cancelling->cancelled"
]);

export function isJobStatusTransitionAllowed(from: JobStatus, to: JobStatus): boolean {
  return JOB_STATUS_TRANSITIONS.has(`${from}->${to}`);
}

/**
 * WHY a job stopped -- always present on a terminal `JobResult`, distinct
 * from `JobStatus` itself (`stopReason` explains the terminal status;
 * `status` IS the terminal status). The brief's own exact vocabulary, plus
 * `candidate_limit_reached` (the fifth budget dimension) and `failed` (an
 * unrecoverable error, distinct from any budget limit).
 */
export type JobStopReason =
  | "completed"
  | "cancelled"
  | "failed"
  | "iteration_limit_reached"
  | "time_limit_reached"
  | "tool_call_limit_reached"
  | "model_call_limit_reached"
  | "candidate_limit_reached";

export const JOB_STOP_REASONS: readonly JobStopReason[] = [
  "completed",
  "cancelled",
  "failed",
  "iteration_limit_reached",
  "time_limit_reached",
  "tool_call_limit_reached",
  "model_call_limit_reached",
  "candidate_limit_reached"
];

// ---------------------------------------------------------------------------
// Budget (every dimension REQUIRED and validated -- see assertJobBudget)
// ---------------------------------------------------------------------------

/**
 * Every dimension of a job's bound. Deliberately has NO optional/nullable
 * field -- "no cap supplied" is never treated as "unlimited" (the brief's
 * own explicit "Do NOT silently convert invalid budgets into unlimited
 * execution"). A caller who genuinely wants a small job passes small
 * numbers; there is no way to express "unbounded" at all, by construction.
 * `assertJobBudget` (schemas) rejects anything that is not a finite,
 * positive integer for EVERY field -- `Infinity`, `NaN`, `0`, and negative
 * numbers are all invalid job budgets, never silently accepted.
 *
 * Only five dimensions are modeled, each because a REAL, existing part of
 * this repo's architecture actually consumes it:
 *   maxIterations         -- the bounded candidate-evaluation loop
 *                             (`background-job-runner.ts`) increments this
 *                             once per candidate attempted.
 *   maxDurationMs         -- wall-clock budget, enforced against a
 *                             MONOTONIC clock (`Clock`, `background-job-budget.ts`),
 *                             never system time alone.
 *   maxToolCalls          -- every `executeTool` call the job's own
 *                             `authorize` wrapper observes (P22's
 *                             `executeExperimentForCandidate` alone makes
 *                             several per candidate: `create_checkpoint`,
 *                             `add_experiment`, the build's own tool calls,
 *                             `update_experiment`; a caller-supplied
 *                             verification step adds more).
 *   maxModelCalls         -- accounted for by `JobRunContext.recordModelCall`
 *                             (core) -- ANY caller-supplied extension hook
 *                             (e.g. a verification step that also calls a
 *                             `ModelProvider`) reports its own usage against
 *                             this SAME central budget; the runner itself
 *                             makes no model calls in its default path.
 *   maxCandidates          -- the size of `BackgroundJob.candidateIds` the
 *                             runner will ever actually attempt in one run.
 *
 * Deliberately NOT modeled (see the P25 report for the full reasoning):
 * `maxEnvironmentOperations` (P25 never calls an `EnvironmentAdapter`
 * directly -- environment operations already happen INSIDE a tool call,
 * so `maxToolCalls` is the correct, existing-architecture boundary);
 * `maxCost`/token budget (no cost/token accounting exists anywhere in this
 * repo's `ModelInvocationResult` yet -- inventing one here would be
 * speculative infrastructure, not integration); `maxMemoryRecords` (the
 * runner never auto-creates `MemoryRecord`s itself -- see this file's own
 * top doc comment -- so nothing internal could grow unboundedly).
 */
export interface JobBudget {
  maxIterations: number;
  maxDurationMs: number;
  maxToolCalls: number;
  maxModelCalls: number;
  maxCandidates: number;
}

export type JobBudgetInput = JobBudget;

/** Mirrors `JobBudget`'s shape exactly -- the PROGRESS half. Every field
 * starts at `0` (`createJobBudgetConsumption`'s default) and only ever
 * grows, monotonically, as `background-job-runner.ts` accounts for real
 * work performed -- never decremented, never reset mid-run. */
export interface JobBudgetConsumption {
  iterationsUsed: number;
  durationMsUsed: number;
  toolCallsUsed: number;
  modelCallsUsed: number;
  candidatesEvaluated: number;
}

export type JobBudgetConsumptionInput = Partial<JobBudgetConsumption>;

// ---------------------------------------------------------------------------
// Per-candidate outcome
// ---------------------------------------------------------------------------

/**
 * A coarse, deterministic summary of what happened to ONE candidate --
 * derived from real fields on the same record, never an independent
 * verdict:
 *   "evaluated"           -- the candidate's build ran (successfully or
 *                             not is `buildStatus`'s job to say) and, if a
 *                             verification step was wired, it ran too.
 *   "build_failed"         -- the candidate's build itself failed;
 *                             verification was never attempted (nothing
 *                             to verify).
 *   "not_attempted"        -- the runner reached its budget/cancellation
 *                             limit or stopped before this candidate's
 *                             turn -- included in `JobResult.candidateResults`
 *                             so a caller can see the FULL declared scope,
 *                             including what never ran, never silently
 *                             omitted.
 */
export type JobCandidateOutcome = "evaluated" | "build_failed" | "not_attempted";

export const JOB_CANDIDATE_OUTCOMES: readonly JobCandidateOutcome[] = ["evaluated", "build_failed", "not_attempted"];

export interface JobCandidateResult {
  candidateId: string;
  /** `Experiment.id` (P22) this candidate's run produced, or `null` for
   * `"not_attempted"`. */
  experimentId: string | null;
  /** The isolation baseline `Checkpoint.id` (P15) captured before this
   * candidate ran, or `null` for `"not_attempted"`. */
  checkpointBeforeId: string | null;
  /** `BuildResult.id` (P20), or `null` for `"not_attempted"`. */
  buildResultId: string | null;
  buildStatus: "completed" | "failed" | null;
  /** `VerificationResult.id`s (P16) a caller-supplied verification step
   * produced for this candidate -- empty when no verification step was
   * wired, or the build failed, or the candidate was never attempted.
   * NEVER hand-populated with a fabricated id: every entry here can only
   * have come from the real `evaluateCheck`/`run_verification` pipeline,
   * matching that pipeline's own "no LLM verdict" discipline. */
  verificationResultIds: string[];
  /** Whether the environment was rolled back to `checkpointBeforeId` after
   * this candidate ran (via the real `restore_checkpoint` tool) -- the
   * runner's own policy decides this (see `background-job-runner.ts`); a
   * job that never wires rollback leaves every entry `false`, which is
   * honest, not a defect. */
  rolledBack: boolean;
  outcome: JobCandidateOutcome;
}

export interface JobCandidateResultInput {
  candidateId: string;
  experimentId?: string | null;
  checkpointBeforeId?: string | null;
  buildResultId?: string | null;
  buildStatus?: "completed" | "failed" | null;
  verificationResultIds?: string[];
  rolledBack?: boolean;
  outcome: JobCandidateOutcome;
}

// ---------------------------------------------------------------------------
// JobResult
// ---------------------------------------------------------------------------

/**
 * The terminal outcome of a bounded run. Deliberately carries NO verdict
 * about whether the underlying engineering objective was met --
 * `objectiveSatisfactionResultId` is an OPTIONAL reference a caller
 * attaches AFTER computing it separately (via the existing, unmodified
 * `evaluate_objective_satisfaction`, P17) -- "20 candidates evaluated" (job
 * completed) and "objective still not satisfied" (P17's own, separate
 * verdict) are two different facts this type keeps structurally distinct,
 * exactly as the brief demands. Likewise `optimizationResultId` references
 * a real P23 `OptimizationResult` computed over this run's candidates,
 * never recomputed here.
 */
export interface JobResult {
  stopReason: JobStopReason;
  candidateResults: JobCandidateResult[];
  /** `OptimizationResult.id` (P23), or `null` if optimization was never
   * run for this job's candidate set. */
  optimizationResultId: string | null;
  /** `ObjectiveSatisfactionResult.id` (P17), or `null` if objective
   * satisfaction was never separately evaluated for this run. */
  objectiveSatisfactionResultId: string | null;
  /** A short, deterministic, template-generated summary (e.g. "Evaluated
   * 3 of 4 candidates; stopped: tool_call_limit_reached") -- never
   * free-text model prose, and never itself treated as engineering truth;
   * see `summarizeJobResult` (core) for how it's built. */
  summary: string;
}

export interface JobResultInput {
  stopReason: JobStopReason;
  candidateResults: JobCandidateResult[];
  optimizationResultId?: string | null;
  objectiveSatisfactionResultId?: string | null;
  summary: string;
}

// ---------------------------------------------------------------------------
// BackgroundJob
// ---------------------------------------------------------------------------

export interface BackgroundJob {
  id: string;
  projectId: string;
  /** `Project.version` at submission time -- the same staleness signal
   * `Candidate`/`OptimizationProblem`/`MemoryRecord.projectVersion` already
   * carry. */
  projectVersion: number;
  status: JobStatus;
  /** Human-readable statement of what this job is bounded to do, e.g.
   * "Evaluate candidates A-D against the mass/strength objective."
   * Required and non-empty -- a job with no stated scope is not yet a real
   * job, matching `Candidate.hypothesis`'s identical "empty is not a real
   * value" discipline. */
  objective: string;
  /** The EXPLICIT, bounded scope of work -- real `Candidate.id`s (P22).
   * MAY be empty (a legitimately no-op job, e.g. one submitted against an
   * already-fully-evaluated experiment) -- see `JOB_STOP_REASONS`'
   * `"completed"` for how that terminates immediately, honestly, without
   * being treated as an error. Order is significant: the runner attempts
   * candidates in exactly this order, deterministically. */
  candidateIds: string[];
  /** Optional link to a real `OptimizationProblem.id` (P23) this job's
   * candidates feed into -- never validated for existence at the schema
   * layer, matching every prior phase's identical "dangling references are
   * a read-time concern" precedent. */
  optimizationProblemId: string | null;
  /** Consumed by the SAME `createExecuteToolAuthorizer`/
   * `evaluateToolAuthorization` (P4) every other tool call already goes
   * through -- reused, not redefined. A job never gains more authority
   * than its own `autonomyLevel` already grants. */
  autonomyLevel: AutonomyLevel;
  /** The explicit tool allowlist -- REQUIRED, non-empty. There is no
   * "all tools" default; a job that attempts a tool outside this set is
   * rejected by the runner's own wrapped `authorize`, layered ON TOP OF
   * (never instead of) P4's real authorization decision. */
  allowedTools: string[];
  budget: JobBudget;
  consumption: JobBudgetConsumption;
  /** `null` until the job reaches a terminal status. */
  result: JobResult | null;
  /** Set only when `status === "failed"`; a short, specific reason (e.g.
   * `"authorization_failed: ..."`, `"model_call_failed: ..."`) -- never a
   * bare `Error`. */
  failureReason: string | null;
  source: EntitySource;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** Set the moment cancellation is REQUESTED (`status` moves to
   * `"cancelling"`) -- distinct from `completedAt`, which is set only once
   * the worker actually acknowledges it and reaches `"cancelled"`. */
  cancelRequestedAt: string | null;
  metadata: Record<string, unknown>;
}

export interface BackgroundJobInput {
  id?: string;
  projectId: string;
  projectVersion: number;
  status?: JobStatus;
  objective: string;
  candidateIds?: string[];
  optimizationProblemId?: string | null;
  autonomyLevel: AutonomyLevel;
  allowedTools: string[];
  budget: JobBudgetInput;
  consumption?: JobBudgetConsumptionInput;
  result?: JobResultInput | null;
  failureReason?: string | null;
  source?: EntitySource;
  createdAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  cancelRequestedAt?: string | null;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// JobEvent -- the auditable trail (own append-only record kind, mirrors
// VerificationResult/CandidateMetricValue's identical "own store, same
// append-only discipline as the Change Model without being a
// WorldModelTransition" precedent -- a job's lifecycle events are process/
// execution facts, not World Model mutations, so they do not belong in
// Change (P2), but they follow the exact same "never mutated, never
// deleted, sequential" discipline Change already established).
// ---------------------------------------------------------------------------

/** The brief's own exact vocabulary of significant job transitions. */
export type JobEventKind =
  | "submitted"
  | "started"
  | "paused"
  | "resumed"
  | "candidate_started"
  | "candidate_completed"
  | "verification_completed"
  | "budget_exhausted"
  | "cancellation_requested"
  | "cancelled"
  | "failed"
  | "completed";

export const JOB_EVENT_KINDS: readonly JobEventKind[] = [
  "submitted",
  "started",
  "paused",
  "resumed",
  "candidate_started",
  "candidate_completed",
  "verification_completed",
  "budget_exhausted",
  "cancellation_requested",
  "cancelled",
  "failed",
  "completed"
];

export interface JobEvent {
  id: string;
  jobId: string;
  projectId: string;
  kind: JobEventKind;
  message: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface JobEventInput {
  id?: string;
  jobId: string;
  projectId: string;
  kind: JobEventKind;
  message?: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}
