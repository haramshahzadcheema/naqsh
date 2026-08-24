import { createExecuteToolAuthorizer, executeTool, runBackgroundJob, verifyCandidateBuild } from "@naqsh/core";
import type { AutonomyLevel, BackgroundJob, JobBudgetInput, JobEvent } from "@naqsh/schemas";
import { ensureEnvironmentSession, type ProjectRuntime } from "./projectRuntime.js";

/**
 * Part L's service layer: background jobs (P25), wired to a real HTTP
 * surface and a real async execution kickoff for the first time (the
 * audit found `runBackgroundJob` had zero callers anywhere in apps/api --
 * a real, tested executor with nothing that ever invoked it). Candidate/
 * experiment/optimization TOOLS (P22/23) are registered in
 * projectRuntime.ts and reachable through `executeTool` exactly like every
 * other tool. This file only owns turning an already-decided candidate set
 * into a real, running job; a caller (e.g. a chat-triggered exploration
 * flow that first calls `generateProjectCandidates`, engineeringWorkflow.ts)
 * supplies the `candidateIds`.
 *
 * `verifyCandidateBuild` (P25+, @naqsh/core) is wired as the `verifyCandidate`
 * hook -- not left at its "build-only" default -- so a job's candidates are
 * actually checked against what their builds claim to have done.
 *
 * `rollbackAfterEachCandidate` is deliberately left at its default
 * (`false`), NOT set to `true`, even though that sounds like the "safer"
 * choice for isolating candidates from each other: `restore_checkpoint`
 * (P15) restores BOTH the environment AND the World Model together (one
 * atomic Checkpoint covers both -- see that tool's own doc comment), so
 * `rollbackAfterEachCandidate: true` would revert each candidate's
 * `add_experiment`/`update_experiment` writes right along with its
 * environment mutation. That would leave `state.project.experiments` (and
 * therefore `compareCandidates`, P22, which reads verification data
 * exclusively off `Experiment.verificationResultIds`) with NOTHING to show
 * once the job finishes -- exactly the data this whole pipeline exists to
 * produce for a human to compare. Since candidate generation defaults to
 * `targetObjectId: null` (create a NEW object per candidate --
 * design-specification-types.ts's own "the original, and still default,
 * shape"), candidates don't typically collide on the same object anyway;
 * leaving their real, independent mutations AND Experiment records in place
 * is what makes them genuinely comparable afterward, matching the goal
 * (generate -> execute -> verify -> compare) rather than the narrower goal
 * of environment isolation for its own sake.
 */

export interface WorkflowFailure {
  kind: string;
  message: string;
}

function approvedModifyAuthorizer(runtime: ProjectRuntime) {
  return createExecuteToolAuthorizer({ autonomyLevel: "approved_modify", approvals: runtime.approvals, autonomyGrants: runtime.autonomyGrants });
}

export interface SubmitJobInput {
  objective: string;
  candidateIds: string[];
  optimizationProblemId?: string | null;
  autonomyLevel: AutonomyLevel;
  allowedTools: string[];
  budget: JobBudgetInput;
}

export type SubmitJobOutcome = { status: "success"; job: BackgroundJob } | { status: "error"; error: WorkflowFailure };

/**
 * Defines and queues a job (`submit_background_job`, through the normal
 * `executeTool` boundary), then immediately kicks off the REAL executor
 * (`runBackgroundJob`) as a background async task -- the HTTP response
 * returns the freshly `"queued"` job right away; a caller polls
 * `getBackgroundJob` for progress/completion. This is a genuine in-process
 * async task tracked through real `BackgroundJob` state transitions
 * (`queued -> running -> completed/failed/cancelled`), not a fabricated
 * "running" flag with nothing behind it.
 */
export async function submitBackgroundJob(runtime: ProjectRuntime, input: SubmitJobInput, onJobSettled?: () => void): Promise<SubmitJobOutcome> {
  const executed = await executeTool(runtime.registry, {
    toolName: "submit_background_job",
    input: { ...input, optimizationProblemId: input.optimizationProblemId ?? null },
    source: "human",
    target: null,
    authorize: approvedModifyAuthorizer(runtime)
  });
  if (executed.result.status === "error") {
    const message = executed.result.error?.message ?? "Could not submit this job.";
    runtime.logActivity("note", "Could not submit job", message);
    return { status: "error", error: { kind: executed.result.error?.kind ?? "submit_failed", message } };
  }
  const job = (executed.result.output as { job: BackgroundJob }).job;
  runtime.logActivity("recommendation", "Job submitted", `"${job.objective}" (${job.candidateIds.length} candidate(s))`);

  // A candidate build needs a CONNECTED environment session (the real
  // create_environment_object/modify_environment_object tool handlers
  // require one) -- mirrors executeProposal/syncEnvironmentObjectsIntoWorldModel's
  // own "lazily connect before the first real mutation" precedent
  // (engineeringWorkflow.ts). Best-effort: if the environment genuinely
  // can't connect, this is logged and the run proceeds anyway -- each
  // candidate's own build then fails honestly with a real, specific
  // "no connected session" error (never silently skipped), exactly as it
  // already would without this call; this only removes the AVOIDABLE
  // failure of every candidate in a job that would otherwise have worked.
  try {
    await ensureEnvironmentSession(runtime);
  } catch (error) {
    runtime.logActivity("note", "Environment unavailable before job start", error instanceof Error ? error.message : String(error));
  }

  void runBackgroundJob({
    registry: runtime.registry,
    jobStore: runtime.backgroundJobStore,
    eventStore: runtime.jobEventStore,
    candidateStore: runtime.candidateStore,
    designSpecificationStore: runtime.designSpecificationStore,
    buildResultStore: runtime.buildResultStore,
    approvals: runtime.approvals,
    autonomyGrants: runtime.autonomyGrants,
    jobId: job.id,
    source: "agent",
    verifyCandidate: verifyCandidateBuild
  })
    .then((finalJob) => {
      const message = finalJob.result?.summary ?? finalJob.failureReason ?? finalJob.status;
      runtime.logActivity(finalJob.status === "completed" ? "recommendation" : "note", `Job ${finalJob.status}`, message);
    })
    .catch((error) => {
      runtime.logActivity("note", "Job runner failed unexpectedly", error instanceof Error ? error.message : String(error));
    })
    .finally(() => {
      // The job's terminal state lands well after the HTTP response for
      // this submit request already went out (and with it, the normal
      // `res.on("finish")` persistence hook -- server.ts). Without this,
      // a completed/failed job would only ever get persisted if some
      // LATER, unrelated request happened to touch this same project
      // first -- easy to lose to a restart in the meantime.
      onJobSettled?.();
    });

  return { status: "success", job };
}

export function listBackgroundJobs(runtime: ProjectRuntime): BackgroundJob[] {
  return [...runtime.backgroundJobStore.listForProject(runtime.projectId)];
}

export type GetJobOutcome = { status: "success"; job: BackgroundJob; events: JobEvent[] } | { status: "error"; error: WorkflowFailure };

export async function getBackgroundJob(runtime: ProjectRuntime, jobId: string): Promise<GetJobOutcome> {
  const executed = await executeTool(runtime.registry, { toolName: "get_background_job", input: { jobId }, source: "human", target: null, authorize: approvedModifyAuthorizer(runtime) });
  if (executed.result.status === "error") {
    const message = executed.result.error?.message ?? "No such job.";
    return { status: "error", error: { kind: executed.result.error?.kind ?? "job_not_found", message } };
  }
  const output = executed.result.output as { job: BackgroundJob; events: JobEvent[] };
  return { status: "success", job: output.job, events: output.events };
}

export type CancelJobOutcome = { status: "success"; job: BackgroundJob } | { status: "error"; error: WorkflowFailure };

export async function cancelBackgroundJob(runtime: ProjectRuntime, jobId: string, reason?: string): Promise<CancelJobOutcome> {
  const executed = await executeTool(runtime.registry, {
    toolName: "cancel_background_job",
    input: { jobId, reason: reason ?? null },
    source: "human",
    target: null,
    authorize: approvedModifyAuthorizer(runtime)
  });
  if (executed.result.status === "error") {
    const message = executed.result.error?.message ?? "Could not cancel this job.";
    return { status: "error", error: { kind: executed.result.error?.kind ?? "cancel_failed", message } };
  }
  const job = (executed.result.output as { job: BackgroundJob }).job;
  runtime.logActivity("note", "Job cancellation requested", job.status);
  return { status: "success", job };
}
