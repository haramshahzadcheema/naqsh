import {
  createJobCandidateResult,
  createJobEvent,
  createJobResult,
  ToolError,
  type BackgroundJob,
  type Candidate,
  type BuildResult,
  type EntitySource,
  type JobCandidateResult,
  type JobEventKind,
  type JobStopReason
} from "@naqsh/schemas";
import type { ToolRegistry } from "./tool-registry.js";
import { executeTool, type ToolAuthorizationContext, type ToolAuthorizationOutcome } from "./execute-tool.js";
import { createExecuteToolAuthorizer } from "./authorization.js";
import type { ApprovalStore } from "./approval-store.js";
import type { AutonomyGrantStore } from "./autonomy-grant-store.js";
import { executeExperimentForCandidate } from "./experiment-executor.js";
import type { CandidateStore } from "./candidate-store.js";
import type { DesignSpecificationStore } from "./design-specification-store.js";
import type { BuildResultStore } from "./build-result-store.js";
import type { BackgroundJobStore } from "./background-job-store.js";
import type { JobEventStore } from "./job-event-store.js";
import { accountCandidateEvaluated, accountDuration, accountIteration, accountModelCall, accountToolCall, checkBudgetExhausted, createSystemClock, type Clock } from "./background-job-budget.js";

/**
 * P25's bounded executor -- the ONE place `BackgroundJob.candidateIds` is
 * actually walked and turned into real, authorized, budgeted work. This
 * file deliberately contains NO agent loop, NO model-driven decision
 * making, and NO unbounded construct (`while (true)`, "retry until
 * successful", "keep going until the objective is satisfied") -- see
 * `checkBudgetExhausted` (this package), consulted before every candidate
 * attempt, as the sole thing that can ever keep this loop running.
 *
 * COMPOSITION, NOT REIMPLEMENTATION: every actual unit of work is
 * delegated to an EXISTING, unmodified system:
 *   - `executeExperimentForCandidate` (P22) performs the isolation
 *     checkpoint, `Experiment` bookkeeping, and build for one candidate.
 *   - Verification (P16) is never reinvented here -- a caller-supplied
 *     `verifyCandidate` hook is the only way `JobCandidateResult.
 *     verificationResultIds` is ever populated, and it can only ever
 *     contain real `VerificationResult.id`s (see that type's own doc
 *     comment on why this is structurally, not just conventionally, true).
 *   - Authorization (P4) is never reinvented -- `createExecuteToolAuthorizer`
 *     is called UNMODIFIED; this file only LAYERS a tool-allowlist
 *     pre-check on top of it (see `wrapAuthorize` below), never replaces
 *     its decision.
 *   - Rollback, if requested, goes through the real, registered
 *     `restore_checkpoint` tool -- never a direct checkpoint-store call.
 *
 * COOPERATIVE CANCELLATION: the loop re-reads the job's live status from
 * `jobStore` at the top of every iteration (the "safe boundary" -- no
 * candidate is left half-executed) and stops there if another actor has
 * already moved the job to `"cancelling"`. This is deliberately the ONLY
 * cancellation checkpoint: `executeExperimentForCandidate` is already an
 * atomic unit in P22's own design (nothing safely interruptible exists
 * mid-way through it), so subdividing cancellation further would require
 * either forcibly killing an in-flight operation (explicitly prohibited --
 * "never a forced kill") or fabricating a false mid-operation safe point.
 * Documented here, not glossed over, as the honest boundary of what
 * "cooperative" can mean for a single synchronous unit of work.
 *
 * CONCURRENCY POLICY: `runBackgroundJob` refuses to start a job if
 * `jobStore.getRunningJobForProject` already reports a running job for the
 * same project -- "one mutating job per project at a time," enforced here,
 * not merely documented.
 *
 * BUDGET GRANULARITY (an honest, documented tradeoff): all five `JobBudget`
 * dimensions are checked once per ITERATION (before each candidate starts),
 * never subdivided within one candidate's atomic
 * `executeExperimentForCandidate` call (or, identically, within one
 * caller-supplied `verifyCandidate` invocation). A candidate already in
 * progress can therefore slightly overshoot `maxToolCalls` -- and a
 * `verifyCandidate` hook can likewise overshoot `maxModelCalls` by calling
 * `recordModelCall()` any number of times within its own single call --
 * before the run stops on the NEXT iteration boundary. The alternative
 * (interrupting `executeExperimentForCandidate`/`verifyCandidate` mid-call)
 * is not safely possible without either a forced kill or a second,
 * competing checkpoint mechanism, both explicitly out of scope.
 * `maxDurationMs` is re-measured before every iteration against a
 * monotonic `Clock`, so a slow candidate's wall-clock usage IS still
 * captured before the next one is allowed to start.
 */

export interface VerifyCandidateContext {
  candidate: Candidate;
  buildResult: BuildResult;
  registry: ToolRegistry;
  authorize: (context: ToolAuthorizationContext) => ToolAuthorizationOutcome | Promise<ToolAuthorizationOutcome>;
  source: EntitySource;
  /** Reports one model call against this job's OWN central budget -- see
   * `JobBudget.maxModelCalls`'s doc comment (schemas). The runner makes no
   * model calls itself; this is the only way `modelCallsUsed` ever grows. */
  recordModelCall: () => void;
}

export interface RunBackgroundJobInput {
  registry: ToolRegistry;
  jobStore: BackgroundJobStore;
  eventStore: JobEventStore;
  candidateStore: CandidateStore;
  designSpecificationStore: DesignSpecificationStore;
  buildResultStore: BuildResultStore;
  approvals: ApprovalStore;
  autonomyGrants: AutonomyGrantStore;
  /** Defaults to `createSystemClock()`. Tests supply a `FakeClock` for
   * deterministic `maxDurationMs` enforcement. */
  clock?: Clock;
  jobId: string;
  source?: EntitySource;
  /** Optional P16 integration point -- see this file's top doc comment.
   * Omitted entirely means this job never verifies its candidates (a
   * legitimate "build-only" job). */
  verifyCandidate?: (context: VerifyCandidateContext) => Promise<{ id: string }[]>;
  /** When `true`, the real `restore_checkpoint` tool is called with each
   * candidate's `checkpointBeforeId` immediately after that candidate
   * finishes (build + optional verification), before the next candidate
   * starts -- proving candidate N+1 never inherits candidate N's mutations.
   * Defaults to `false` (a job that wants to keep the LAST candidate's
   * mutations applied, e.g. to hand off to a human, leaves this off). */
  rollbackAfterEachCandidate?: boolean;
}

function recordEvent(eventStore: JobEventStore, job: BackgroundJob, kind: JobEventKind, message: string, metadata: Record<string, unknown> = {}): void {
  eventStore.save(createJobEvent({ jobId: job.id, projectId: job.projectId, kind, message, metadata }));
}

function summarizeJobResult(totalCandidates: number, candidateResults: JobCandidateResult[], stopReason: JobStopReason): string {
  const attempted = candidateResults.filter((result) => result.outcome !== "not_attempted").length;
  return `Evaluated ${attempted} of ${totalCandidates} candidate(s); stopped: ${stopReason}.`;
}

/**
 * Transitions a job to `"failed"`, attaching a `JobResult` that lists every
 * declared candidate as either the (partial) work already recorded or
 * `"not_attempted"` -- `assertBackgroundJob` (schemas) requires `result` to
 * be non-null for ANY terminal status, `"failed"` included, so a system-
 * level anomaly can never produce a job that is terminal but structurally
 * incomplete. Never invented as a separate, looser "failure record" shape.
 */
function failJob(
  jobStore: BackgroundJobStore,
  eventStore: JobEventStore,
  job: BackgroundJob,
  consumption: BackgroundJob["consumption"],
  resultsByCandidateId: Map<string, JobCandidateResult>,
  failureReason: string
): BackgroundJob {
  const candidateResults = job.candidateIds.map(
    (candidateId) => resultsByCandidateId.get(candidateId) ?? createJobCandidateResult({ candidateId, outcome: "not_attempted" })
  );
  const summary = summarizeJobResult(job.candidateIds.length, candidateResults, "failed");
  const result = createJobResult({ stopReason: "failed", candidateResults, summary });
  const failed = jobStore.transition(job.id, "failed", { consumption, failureReason, result });
  recordEvent(eventStore, failed, "failed", failureReason);
  return failed;
}

/**
 * Runs ONE `BackgroundJob`, from `"queued"` to a terminal (or `"cancelled"`)
 * status, in a single bounded pass. Never resumes a job that isn't
 * currently `"queued"` -- there is no "call this again to continue a
 * running job" re-entrancy in this phase (see the P25 report's own
 * "pause/resume" limitation).
 */
export async function runBackgroundJob(input: RunBackgroundJobInput): Promise<BackgroundJob> {
  const { registry, jobStore, eventStore, candidateStore, designSpecificationStore, buildResultStore, approvals, autonomyGrants } = input;
  const clock = input.clock ?? createSystemClock();
  const source = input.source ?? "agent";

  const queuedJob = jobStore.getById(input.jobId);
  if (!queuedJob) {
    throw new ToolError("invalid_input", `job_not_found: no background job "${input.jobId}" exists`);
  }
  if (queuedJob.status !== "queued") {
    throw new ToolError("invalid_input", `job_not_queued: background job "${input.jobId}" is "${queuedJob.status}", not "queued"`);
  }

  // CONCURRENCY POLICY: one mutating job per project at a time.
  const alreadyRunning = jobStore.getRunningJobForProject(queuedJob.projectId);
  if (alreadyRunning) {
    throw new ToolError(
      "invalid_input",
      `project_job_conflict: project "${queuedJob.projectId}" already has a running background job "${alreadyRunning.id}"`
    );
  }

  let job = jobStore.transition(queuedJob.id, "running");
  recordEvent(eventStore, job, "started", `Job started: ${job.objective}`);

  const startedAtMonotonic = clock.now();
  let consumption = job.consumption;

  // P4, UNMODIFIED. `wrapAuthorize` layers the job's explicit tool
  // allowlist ON TOP of this real decision -- it never substitutes for it.
  const realAuthorize = createExecuteToolAuthorizer({ autonomyLevel: job.autonomyLevel, approvals, autonomyGrants });
  const authorize = (context: ToolAuthorizationContext): ToolAuthorizationOutcome => {
    consumption = accountToolCall(consumption);
    if (!job.allowedTools.includes(context.tool.name)) {
      return { allowed: false, reason: `tool_not_allowlisted: "${context.tool.name}" is not in this job's allowedTools` };
    }
    return realAuthorize(context);
  };

  const resultsByCandidateId = new Map<string, JobCandidateResult>();
  let stopReason: JobStopReason | null = null;

  for (const candidateId of job.candidateIds) {
    // Cooperative cancellation: the ONLY checkpoint, at the top of every
    // iteration -- see this file's top doc comment for why.
    const liveJob = jobStore.getById(job.id)!;
    if (liveJob.status === "cancelling") {
      stopReason = "cancelled";
      break;
    }

    consumption = accountDuration(consumption, clock.now() - startedAtMonotonic);
    const exhausted = checkBudgetExhausted(job.budget, consumption);
    if (exhausted) {
      stopReason = exhausted;
      recordEvent(eventStore, job, "budget_exhausted", `Budget exhausted before candidate "${candidateId}": ${exhausted}`);
      break;
    }

    consumption = accountIteration(consumption);
    recordEvent(eventStore, job, "candidate_started", `Starting candidate "${candidateId}"`, { candidateId });

    const candidate = candidateStore.getById(candidateId);
    if (!candidate || !candidate.designSpecificationId) {
      // Cannot happen through `submit_background_job` (it validates every
      // candidateId resolves to a real, buildable Candidate at submission
      // time) -- reaching this branch means state was corrupted between
      // submission and run, a genuine system-level anomaly, not a
      // per-candidate engineering outcome. Fail the whole job, loudly.
      return failJob(jobStore, eventStore, job, consumption, resultsByCandidateId, `unresolvable_candidate: candidate "${candidateId}" no longer resolves to a buildable Candidate`);
    }
    // AUDIT FIX (PROJECT ISOLATION IS CRITICAL): `submit_background_job`
    // already checks `candidate.projectId === state.project.id` at
    // SUBMISSION time -- but the runner previously just trusted
    // `job.candidateIds` at RUN time with no re-check of its own. That
    // made cross-project isolation a CONVENTION (true only as long as
    // every job was created through that one tool) rather than a
    // STRUCTURAL guarantee (true no matter how the job was constructed) --
    // exactly the gap this repo's own prior phase audits (e.g. P23's
    // `computeOptimizationResult` defending its own invariants rather than
    // trusting an unvalidated caller) exist to close. Defended here too,
    // independently.
    if (candidate.projectId !== job.projectId) {
      return failJob(
        jobStore,
        eventStore,
        job,
        consumption,
        resultsByCandidateId,
        `cross_project_candidate: candidate "${candidateId}" belongs to project "${candidate.projectId}", not this job's project "${job.projectId}"`
      );
    }
    const design = designSpecificationStore.getById(candidate.designSpecificationId);
    if (!design) {
      return failJob(jobStore, eventStore, job, consumption, resultsByCandidateId, `unresolvable_design: candidate "${candidateId}" names a designSpecificationId that no longer resolves`);
    }
    if (design.projectId !== job.projectId) {
      return failJob(
        jobStore,
        eventStore,
        job,
        consumption,
        resultsByCandidateId,
        `cross_project_design: candidate "${candidateId}"'s design belongs to project "${design.projectId}", not this job's project "${job.projectId}"`
      );
    }

    let experimentId: string | null = null;
    let checkpointBeforeId: string | null = null;
    let buildResultId: string | null = null;
    let buildStatus: "completed" | "failed" | null = null;
    let verificationResultIds: string[] = [];
    let rolledBack = false;
    let outcome: "evaluated" | "build_failed";
    let latestBuildResult: BuildResult | null = null;

    let threwMessage: string | null = null;
    try {
      const execResult = await executeExperimentForCandidate(registry, candidate, design, buildResultStore, {
        source,
        authorize,
        checkpointReason: `Background job "${job.id}", candidate "${candidateId}"`
      });
      experimentId = execResult.experiment.id;
      checkpointBeforeId = execResult.checkpointBefore.id;
      buildResultId = execResult.buildResult.id;
      buildStatus = execResult.buildResult.status === "completed" ? "completed" : "failed";
      outcome = buildStatus === "completed" ? "evaluated" : "build_failed";
      latestBuildResult = execResult.buildResult;
    } catch (error) {
      // A per-candidate failure -- "failure is data": recorded on this
      // candidate's own result, the loop continues to the next candidate,
      // the JOB itself does not fail.
      buildStatus = "failed";
      outcome = "build_failed";
      threwMessage = error instanceof Error ? error.message : String(error);
    }

    consumption = accountCandidateEvaluated(consumption);

    // AUDIT FIX: exactly ONE "candidate_completed" event per candidate
    // attempt, regardless of outcome -- the earlier version only recorded
    // one on the THROWN-error path or the build-succeeded path, silently
    // leaving no audit trail at all for a candidate whose build failed
    // WITHOUT throwing (executeExperimentForCandidate's own documented,
    // non-exceptional "records a failed Experiment when the build fails"
    // outcome) -- exactly the gap section 24's auditability requirement
    // exists to catch.
    recordEvent(
      eventStore,
      job,
      "candidate_completed",
      threwMessage ? `Candidate "${candidateId}" errored before a build result could be produced: ${threwMessage}` : `Candidate "${candidateId}" build ${buildStatus}`,
      { candidateId, experimentId, ...(threwMessage ? { error: threwMessage } : {}) }
    );

    if (buildStatus === "completed" && latestBuildResult) {
      if (input.verifyCandidate) {
        try {
          const results = await input.verifyCandidate({
            candidate,
            buildResult: latestBuildResult,
            registry,
            authorize,
            source,
            recordModelCall: () => {
              consumption = accountModelCall(consumption);
            }
          });
          verificationResultIds = results.map((result) => result.id);
          recordEvent(eventStore, job, "verification_completed", `Candidate "${candidateId}" verification produced ${results.length} result(s)`, {
            candidateId,
            verificationResultIds
          });

          // AUDIT FIX: verificationResultIds was previously recorded ONLY on
          // this job's own JobCandidateResult bookkeeping, never on the real
          // Experiment (World Model) record `experimentId` names -- meaning
          // `compareCandidates` (which reads verification data exclusively
          // from `state.project.experiments[].verificationResultIds`, see
          // that file's own doc comment) could never see a background job's
          // verification results, no matter how many real VerificationResults
          // this hook produced. Persisted here through the registered,
          // authorized update_experiment tool -- the same boundary every
          // other Experiment write in this file already goes through.
          // Best-effort: if the caller's allowedTools doesn't include
          // update_experiment, or authorization denies it, this candidate's
          // OWN JobCandidateResult.verificationResultIds (set above) is
          // unaffected -- only the World-Model-level copy is missing.
          if (experimentId && verificationResultIds.length > 0) {
            await executeTool(registry, {
              toolName: "update_experiment",
              input: { experimentId, verificationResultIds },
              source,
              target: { entityType: "experiment", entityId: experimentId },
              authorize
            });
          }
        } catch (error) {
          recordEvent(eventStore, job, "verification_completed", `Candidate "${candidateId}" verification failed: ${error instanceof Error ? error.message : String(error)}`, {
            candidateId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      if (input.rollbackAfterEachCandidate && checkpointBeforeId) {
        const { result: restoreResult } = await executeTool(registry, {
          toolName: "restore_checkpoint",
          input: { checkpointId: checkpointBeforeId, reason: `Rollback after background job "${job.id}" candidate "${candidateId}"` },
          source,
          authorize
        });
        rolledBack = restoreResult.status === "success";
      }
    }

    resultsByCandidateId.set(
      candidateId,
      createJobCandidateResult({ candidateId, experimentId, checkpointBeforeId, buildResultId, buildStatus, verificationResultIds, rolledBack, outcome })
    );
  }

  consumption = accountDuration(consumption, clock.now() - startedAtMonotonic);
  if (stopReason === null) {
    stopReason = "completed";
  }

  const candidateResults = job.candidateIds.map(
    (candidateId) => resultsByCandidateId.get(candidateId) ?? createJobCandidateResult({ candidateId, outcome: "not_attempted" })
  );
  const summary = summarizeJobResult(job.candidateIds.length, candidateResults, stopReason);
  const jobResult = createJobResult({ stopReason, candidateResults, summary });

  const finalStatus = stopReason === "cancelled" ? "cancelled" : "completed";
  job = jobStore.transition(job.id, finalStatus, { consumption, result: jobResult });
  recordEvent(eventStore, job, finalStatus === "cancelled" ? "cancelled" : "completed", summary);

  return job;
}
