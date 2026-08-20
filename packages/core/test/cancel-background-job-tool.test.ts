import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBackgroundJob, createWorldModelState, type BackgroundJob, type BackgroundJobInput, type WorldModelState } from "@naqsh/schemas";
import { createCancelBackgroundJobTool } from "../src/cancel-background-job-tool.js";
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
  const { tool, handler } = createCancelBackgroundJobTool(jobStore, eventStore, () => state);
  registry.register(tool, handler);
  return { registry, jobStore, eventStore, getState: () => state };
}

describe("createCancelBackgroundJobTool: identity and classification", () => {
  it("is classified suggest/job -- never forcibly stops anything, only requests it", () => {
    const { registry } = buildHarness();
    const tool = registry.getByName("cancel_background_job")!;
    assert.equal(tool.mutation, "suggest");
    assert.equal(tool.target, "job");
  });
});

describe("createCancelBackgroundJobTool: a queued job is cancelled immediately", () => {
  it("moves straight to 'cancelled' -- there is no cooperative worker to wait for", async () => {
    const harness = buildHarness();
    const job = createBackgroundJob(jobInput());
    harness.jobStore.save(job);
    const { result } = await executeTool(harness.registry, { toolName: "cancel_background_job", input: { jobId: job.id } });
    assert.equal(result.status, "success");
    const cancelled = (result.output as { job: BackgroundJob }).job;
    assert.equal(cancelled.status, "cancelled");
    assert.ok(cancelled.cancelRequestedAt);
    const events = harness.eventStore.listForJob(job.id);
    assert.equal(events[0]!.kind, "cancelled");
  });
});

describe("createCancelBackgroundJobTool: a running/paused job moves to 'cancelling'", () => {
  it("requests cancellation without immediately stopping -- the runner acknowledges it later", async () => {
    const harness = buildHarness();
    const job = createBackgroundJob(jobInput());
    harness.jobStore.save(job);
    harness.jobStore.transition(job.id, "running");
    const { result } = await executeTool(harness.registry, { toolName: "cancel_background_job", input: { jobId: job.id, reason: "no longer needed" } });
    assert.equal(result.status, "success");
    const cancelling = (result.output as { job: BackgroundJob }).job;
    assert.equal(cancelling.status, "cancelling");
    const events = harness.eventStore.listForJob(job.id);
    assert.equal(events[0]!.kind, "cancellation_requested");
    assert.equal(events[0]!.metadata.reason, "no longer needed");
  });
});

describe("createCancelBackgroundJobTool: guards", () => {
  it("rejects cancelling an already-terminal job", async () => {
    const harness = buildHarness();
    const job = createBackgroundJob(jobInput());
    harness.jobStore.save(job);
    harness.jobStore.transition(job.id, "cancelled", {
      result: { stopReason: "cancelled", candidateResults: [], optimizationResultId: null, objectiveSatisfactionResultId: null, summary: "done" }
    });
    const { result } = await executeTool(harness.registry, { toolName: "cancel_background_job", input: { jobId: job.id } });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /job_not_cancellable/);
  });

  it("rejects an unknown jobId", async () => {
    const harness = buildHarness();
    const { result } = await executeTool(harness.registry, { toolName: "cancel_background_job", input: { jobId: "job_ghost" } });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /job_not_found/);
  });

  it("rejects a job belonging to a different project", async () => {
    const harness = buildHarness();
    const job = createBackgroundJob(jobInput({ projectId: "proj_other" }));
    harness.jobStore.save(job);
    const { result } = await executeTool(harness.registry, { toolName: "cancel_background_job", input: { jobId: job.id } });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /job_not_found/);
  });
});
