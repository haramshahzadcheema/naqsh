import { ToolError, WorldModelValidationError, createTool, createJobCandidateResult, createJobEvent, createJobResult, type Tool, type ToolValueSchema, type WorldModelState } from "@naqsh/schemas";
import type { BackgroundJobStore } from "./background-job-store.js";
import type { JobEventStore } from "./job-event-store.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * Phase 25's cancellation tool -- REQUESTS cancellation; it never forcibly
 * stops anything itself (there is no "kill" primitive anywhere in this
 * repo, matching the brief's own explicit "never a forced kill"). What it
 * actually does depends on where the job currently is in
 * `JOB_STATUS_TRANSITIONS` (schemas):
 *   "queued"              -- never started; transitions straight to
 *                             `"cancelled"` (there is no cooperative worker
 *                             to wait for).
 *   "running" / "paused"  -- transitions to `"cancelling"`. The actual stop
 *                             happens later, cooperatively, the next time
 *                             `background-job-runner.ts`'s loop checks its
 *                             iteration boundary and observes this status.
 *   anything else          -- rejected (a terminal or already-`"cancelling"`
 *                             job cannot be cancelled again).
 *
 * Classified `mutation: "suggest"` -- like every other `BackgroundJob`
 * lifecycle operation, this never touches `WorldModelState`.
 */

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    jobId: { type: "string" },
    reason: { type: "string", nullable: true }
  },
  required: ["jobId"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: { job: { type: "object", properties: {}, additionalProperties: true } },
  required: ["job"]
};

function toCancelBackgroundJobToolInput(rawInput: unknown): { jobId: string; reason: string | null } {
  const record = rawInput as { jobId?: unknown; reason?: unknown };
  if (typeof record.jobId !== "string" || record.jobId.trim().length === 0) {
    throw new ToolError("invalid_input", "jobId is required and must be a non-empty string");
  }
  return { jobId: record.jobId, reason: typeof record.reason === "string" ? record.reason : null };
}

export function createCancelBackgroundJobTool(
  jobStore: BackgroundJobStore,
  eventStore: JobEventStore,
  getState: () => WorldModelState
): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "cancel_background_job",
    description:
      "Requests cancellation of a BackgroundJob. A queued job is cancelled immediately; a running/paused job moves to 'cancelling' and stops cooperatively at its next safe iteration boundary. Never forcibly terminates anything.",
    target: "job",
    mutation: "suggest",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = (rawInput) => {
    const { jobId, reason } = toCancelBackgroundJobToolInput(rawInput);
    const state = getState();
    const existing = jobStore.getById(jobId);
    if (!existing || existing.projectId !== state.project.id) {
      throw new ToolError("invalid_input", `job_not_found: no background job "${jobId}" exists in the current project`);
    }

    const target = existing.status === "queued" ? "cancelled" : "cancelling";
    // "cancelled" is terminal -- assertBackgroundJob (schemas) requires a
    // JobResult for every terminal status. A queued job never attempted
    // any candidate, so every declared candidate is honestly "not_attempted".
    const patch =
      target === "cancelled"
        ? {
            result: createJobResult({
              stopReason: "cancelled" as const,
              candidateResults: existing.candidateIds.map((candidateId) => createJobCandidateResult({ candidateId, outcome: "not_attempted" as const })),
              summary: `Evaluated 0 of ${existing.candidateIds.length} candidate(s); stopped: cancelled.`
            })
          }
        : {};
    let job;
    try {
      job = jobStore.transition(jobId, target, patch);
    } catch (error) {
      if (error instanceof WorldModelValidationError) {
        throw new ToolError("invalid_input", `job_not_cancellable: background job "${jobId}" is "${existing.status}" and cannot be cancelled -- ${error.message}`);
      }
      throw error;
    }

    eventStore.save(
      createJobEvent({
        jobId: job.id,
        projectId: job.projectId,
        kind: target === "cancelled" ? "cancelled" : "cancellation_requested",
        message: reason ? `Cancellation requested: ${reason}` : "Cancellation requested",
        metadata: reason ? { reason } : {}
      })
    );
    return { job };
  };

  return { tool, handler };
}
