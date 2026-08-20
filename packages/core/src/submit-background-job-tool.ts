import {
  AUTONOMY_LEVELS,
  ToolError,
  WorldModelValidationError,
  createBackgroundJob,
  createTool,
  type AutonomyLevel,
  type BackgroundJobInput,
  type JobBudgetInput,
  type Tool,
  type ToolValueSchema,
  type WorldModelState
} from "@naqsh/schemas";
import type { CandidateStore } from "./candidate-store.js";
import type { BackgroundJobStore } from "./background-job-store.js";
import type { JobEventStore } from "./job-event-store.js";
import { createJobEvent } from "@naqsh/schemas";
import type { ToolHandler } from "./tool-registry.js";

/**
 * Phase 25's job-DEFINITION tool -- the ONE place a `BackgroundJob` is ever
 * created, mirroring `create_optimization_problem`'s (P23) exact shape:
 * flat, already-decided fields in (which candidates, what budget, which
 * tools, what autonomy level -- all already settled by the caller's own
 * reasoning or a human), a validated, stored, `"queued"` job out. This tool
 * never itself RUNS anything -- see `background-job-runner.ts`'s
 * `runBackgroundJob`, a separate, explicit step a caller invokes after
 * submission (matching `run_optimization`'s (P23) identical
 * "defining a unit of work" vs "executing it" split).
 *
 * `projectId`/`projectVersion` are NOT caller-supplied -- read from LIVE
 * `WorldModelState`, closing the same spoofing path every prior
 * "create_X" tool already closes. Every `candidateId` is cross-checked
 * against a REAL `CandidateStore`, scoped to the current project, AND
 * required to already carry a `designSpecificationId` (`background-job-
 * runner.ts` cannot build a candidate with no design -- rejecting that
 * here, at submission time, is what lets the runner treat an unresolvable
 * candidate as a genuine system anomaly rather than an expected case it
 * must handle gracefully).
 *
 * `allowedTools` is REQUIRED and non-empty -- there is no "all tools"
 * default (the brief's own explicit requirement); `autonomyLevel` is one
 * of the real, existing `AutonomyLevel`s (P4) -- a background job carries
 * no more authority than any other caller at the same level.
 *
 * AUDIT FIX: A JOB MUST NOT INHERIT MORE AUTHORITY THAN ITS CREATOR
 * POSSESSES. `background-job-runner.ts` builds its OWN
 * `createExecuteToolAuthorizer` from `job.autonomyLevel` at RUN time --
 * with nothing checking `input.autonomyLevel` at SUBMIT time, a caller
 * whose own current session was operating at, say, `"suggest"` (every
 * mutation individually approved) could submit a job requesting
 * `"autonomous"` (standing `AutonomyGrant`s, no per-call approval) and
 * have it run with meaningfully LESS friction than the caller itself
 * could ever act with directly -- a genuine privilege escalation, not
 * merely a missing nicety. `maxAutonomyLevel` (constructor parameter,
 * required) is the ceiling the SUBMITTING session itself is currently
 * operating under -- exactly the same value that session's own
 * `createExecuteToolAuthorizer` was configured with -- and
 * `submit_background_job` rejects any `autonomyLevel` request ranked
 * higher than it (`AUTONOMY_LEVELS`'s own index order, the same ordering
 * `authorization.ts`'s `levelRank` uses). A caller can delegate AT MOST
 * its own current authority to a background job, never more.
 *
 * Classified `mutation: "suggest"` -- a `BackgroundJob` lives in its own
 * store, never `WorldModelState`, the same classification every other
 * process/execution record (`Candidate`/`OptimizationProblem`/
 * `MemoryRecord`) already uses.
 */

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    objective: { type: "string" },
    candidateIds: { type: "array", items: { type: "string" }, description: "Real Candidate ids (P22) this job will attempt to build, in order. May be empty (a no-op job)." },
    optimizationProblemId: { type: "string", nullable: true },
    autonomyLevel: { type: "string", enum: AUTONOMY_LEVELS as string[] },
    allowedTools: { type: "array", items: { type: "string" }, description: "The explicit tool allowlist this job is bounded to. Required, non-empty." },
    budget: {
      type: "object",
      properties: {
        maxIterations: { type: "number" },
        maxDurationMs: { type: "number" },
        maxToolCalls: { type: "number" },
        maxModelCalls: { type: "number" },
        maxCandidates: { type: "number" }
      },
      required: ["maxIterations", "maxDurationMs", "maxToolCalls", "maxModelCalls", "maxCandidates"],
      description: "Every dimension is required -- there is no way to express 'unlimited'."
    }
  },
  required: ["objective", "candidateIds", "autonomyLevel", "allowedTools", "budget"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: { job: { type: "object", properties: {}, additionalProperties: true } },
  required: ["job"]
};

interface SubmitBackgroundJobToolInput {
  objective: string;
  candidateIds: string[];
  optimizationProblemId: string | null;
  autonomyLevel: AutonomyLevel;
  allowedTools: string[];
  budget: JobBudgetInput;
}

function toSubmitBackgroundJobToolInput(rawInput: unknown): SubmitBackgroundJobToolInput {
  const record = rawInput as {
    objective?: unknown;
    candidateIds?: unknown;
    optimizationProblemId?: unknown;
    autonomyLevel?: unknown;
    allowedTools?: unknown;
    budget?: unknown;
  };
  if (typeof record.objective !== "string" || record.objective.trim().length === 0) {
    throw new ToolError("invalid_input", "objective is required and must be a non-empty string");
  }
  if (!Array.isArray(record.candidateIds) || !record.candidateIds.every((id) => typeof id === "string" && id.trim().length > 0)) {
    throw new ToolError("invalid_input", "candidateIds must be an array of non-empty strings");
  }
  if (typeof record.autonomyLevel !== "string" || !(AUTONOMY_LEVELS as readonly string[]).includes(record.autonomyLevel)) {
    throw new ToolError("invalid_input", `autonomyLevel is required and must be one of: ${AUTONOMY_LEVELS.join(", ")}`);
  }
  if (!Array.isArray(record.allowedTools) || record.allowedTools.length === 0 || !record.allowedTools.every((name) => typeof name === "string" && name.trim().length > 0)) {
    throw new ToolError("invalid_input", "allowedTools is required and must be a non-empty array of non-empty strings");
  }
  if (typeof record.budget !== "object" || record.budget === null) {
    throw new ToolError("invalid_input", "budget is required");
  }
  return {
    objective: record.objective,
    candidateIds: record.candidateIds,
    optimizationProblemId: typeof record.optimizationProblemId === "string" ? record.optimizationProblemId : null,
    autonomyLevel: record.autonomyLevel as AutonomyLevel,
    allowedTools: record.allowedTools,
    budget: record.budget as JobBudgetInput
  };
}

export function createSubmitBackgroundJobTool(
  candidateStore: CandidateStore,
  jobStore: BackgroundJobStore,
  eventStore: JobEventStore,
  getState: () => WorldModelState,
  /** The submitting session's OWN current autonomy ceiling -- see this
   * file's own AUDIT FIX doc comment above. A job's requested
   * `autonomyLevel` may never rank higher than this. */
  maxAutonomyLevel: AutonomyLevel
): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "submit_background_job",
    description:
      "Defines and queues a new BackgroundJob: a bounded amount of engineering work (build + optionally verify up to N real Candidates) to be run later via runBackgroundJob. Never runs anything itself; never mutates the World Model or the environment.",
    target: "job",
    mutation: "suggest",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = (rawInput) => {
    const input = toSubmitBackgroundJobToolInput(rawInput);
    const state = getState();

    if (AUTONOMY_LEVELS.indexOf(input.autonomyLevel) > AUTONOMY_LEVELS.indexOf(maxAutonomyLevel)) {
      throw new ToolError(
        "policy_rejected",
        `autonomy_ceiling_exceeded: this session may submit a job at autonomyLevel "${maxAutonomyLevel}" or lower, not "${input.autonomyLevel}" -- a job can never carry more authority than its creator`
      );
    }

    for (const candidateId of input.candidateIds) {
      const candidate = candidateStore.getById(candidateId);
      if (!candidate || candidate.projectId !== state.project.id) {
        throw new ToolError("invalid_input", `candidate_not_found: no candidate "${candidateId}" exists in the current project`);
      }
      if (!candidate.designSpecificationId) {
        throw new ToolError("invalid_input", `candidate_has_no_design: candidate "${candidateId}" has no designSpecificationId, so it cannot be run by a background job`);
      }
    }

    const jobInput: BackgroundJobInput = {
      projectId: state.project.id,
      projectVersion: state.project.version,
      objective: input.objective,
      candidateIds: input.candidateIds,
      optimizationProblemId: input.optimizationProblemId,
      autonomyLevel: input.autonomyLevel,
      allowedTools: input.allowedTools,
      budget: input.budget
    };

    let job;
    try {
      job = createBackgroundJob(jobInput);
    } catch (error) {
      if (error instanceof WorldModelValidationError) {
        throw new ToolError("invalid_input", `background job is invalid: ${error.message}`);
      }
      throw error;
    }

    jobStore.save(job);
    eventStore.save(createJobEvent({ jobId: job.id, projectId: job.projectId, kind: "submitted", message: `Job submitted: ${job.objective}` }));
    return { job };
  };

  return { tool, handler };
}
