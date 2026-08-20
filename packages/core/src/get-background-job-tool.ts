import { ToolError, createTool, type Tool, type ToolValueSchema, type WorldModelState } from "@naqsh/schemas";
import type { BackgroundJobStore } from "./background-job-store.js";
import type { JobEventStore } from "./job-event-store.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * Phase 25's read-only job lookup -- a single `BackgroundJob` plus its full
 * `JobEvent` audit trail, scoped to the current project (mirrors
 * `memory_get`'s (P24) identical "look up by id, cross-project id is not
 * found" precedent). `mutation: "observe"`.
 */

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: { jobId: { type: "string" } },
  required: ["jobId"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    job: { type: "object", properties: {}, additionalProperties: true },
    events: { type: "array", items: { type: "object", properties: {}, additionalProperties: true } }
  },
  required: ["job", "events"]
};

function toGetBackgroundJobToolInput(rawInput: unknown): { jobId: string } {
  const record = rawInput as { jobId?: unknown };
  if (typeof record.jobId !== "string" || record.jobId.trim().length === 0) {
    throw new ToolError("invalid_input", "jobId is required and must be a non-empty string");
  }
  return { jobId: record.jobId };
}

export function createGetBackgroundJobTool(
  jobStore: BackgroundJobStore,
  eventStore: JobEventStore,
  getState: () => WorldModelState
): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "get_background_job",
    description: "Retrieves a single BackgroundJob by id, with its full JobEvent audit trail, scoped to the current project. Read-only.",
    target: "job",
    mutation: "observe",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = (rawInput) => {
    const { jobId } = toGetBackgroundJobToolInput(rawInput);
    const state = getState();
    const job = jobStore.getById(jobId);
    if (!job || job.projectId !== state.project.id) {
      throw new ToolError("invalid_input", `job_not_found: no background job "${jobId}" exists in the current project`);
    }
    const events = eventStore.listForJob(jobId);
    return { job, events };
  };

  return { tool, handler };
}
