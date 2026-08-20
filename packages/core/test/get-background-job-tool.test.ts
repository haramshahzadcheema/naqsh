import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBackgroundJob, createJobEvent, createWorldModelState, type BackgroundJob, type BackgroundJobInput, type JobEvent, type WorldModelState } from "@naqsh/schemas";
import { createGetBackgroundJobTool } from "../src/get-background-job-tool.js";
import { createBackgroundJobStore } from "../src/background-job-store.js";
import { createJobEventStore } from "../src/job-event-store.js";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry } from "../src/tool-registry.js";

function jobInput(overrides: Partial<BackgroundJobInput> = {}): BackgroundJobInput {
  return {
    projectId: "proj_1",
    projectVersion: 1,
    objective: "Evaluate candidates.",
    candidateIds: [],
    autonomyLevel: "suggest",
    allowedTools: ["create_checkpoint"],
    budget: { maxIterations: 10, maxDurationMs: 60000, maxToolCalls: 100, maxModelCalls: 10, maxCandidates: 10 },
    ...overrides
  };
}

function buildHarness() {
  const jobStore = createBackgroundJobStore();
  const eventStore = createJobEventStore();
  let state: WorldModelState = createWorldModelState({ project: { id: "proj_1", name: "Bracket Study" }, session: {} });
  const registry = createToolRegistry();
  const { tool, handler } = createGetBackgroundJobTool(jobStore, eventStore, () => state);
  registry.register(tool, handler);
  return { registry, jobStore, eventStore, getState: () => state };
}

describe("createGetBackgroundJobTool: identity and classification", () => {
  it("is classified observe/job -- read-only", () => {
    const { registry } = buildHarness();
    const tool = registry.getByName("get_background_job")!;
    assert.equal(tool.mutation, "observe");
    assert.equal(tool.target, "job");
  });
});

describe("createGetBackgroundJobTool: lookup", () => {
  it("retrieves a job by id, along with its JobEvent audit trail in save order", async () => {
    const harness = buildHarness();
    const job = createBackgroundJob(jobInput());
    harness.jobStore.save(job);
    harness.eventStore.save(createJobEvent({ jobId: job.id, projectId: job.projectId, kind: "submitted", message: "Submitted." }));
    harness.eventStore.save(createJobEvent({ jobId: job.id, projectId: job.projectId, kind: "started", message: "Started." }));

    const { result } = await executeTool(harness.registry, { toolName: "get_background_job", input: { jobId: job.id } });
    assert.equal(result.status, "success");
    const output = result.output as { job: BackgroundJob; events: JobEvent[] };
    assert.deepEqual(output.job, job);
    assert.deepEqual(output.events.map((e) => e.kind), ["submitted", "started"]);
  });

  it("rejects an unknown jobId", async () => {
    const harness = buildHarness();
    const { result } = await executeTool(harness.registry, { toolName: "get_background_job", input: { jobId: "job_ghost" } });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /job_not_found/);
  });

  it("rejects a job belonging to a different project", async () => {
    const harness = buildHarness();
    const job = createBackgroundJob(jobInput({ projectId: "proj_other" }));
    harness.jobStore.save(job);
    const { result } = await executeTool(harness.registry, { toolName: "get_background_job", input: { jobId: job.id } });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /job_not_found/);
  });

  it("rejects a missing jobId", async () => {
    const harness = buildHarness();
    const { result } = await executeTool(harness.registry, { toolName: "get_background_job", input: {} });
    assert.equal(result.status, "error");
  });
});
