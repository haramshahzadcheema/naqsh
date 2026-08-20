import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBackgroundJob, WorldModelValidationError, type BackgroundJobInput, type JobBudgetInput } from "@naqsh/schemas";
import { createBackgroundJobStore, deserializeBackgroundJobStore } from "../src/background-job-store.js";

function validBudget(overrides: Partial<JobBudgetInput> = {}): JobBudgetInput {
  return { maxIterations: 10, maxDurationMs: 60000, maxToolCalls: 100, maxModelCalls: 10, maxCandidates: 10, ...overrides };
}

function jobInput(overrides: Partial<BackgroundJobInput> = {}): BackgroundJobInput {
  return {
    projectId: "proj_1",
    projectVersion: 1,
    objective: "Evaluate candidates.",
    candidateIds: ["candidate_a"],
    autonomyLevel: "suggest",
    allowedTools: ["create_checkpoint"],
    budget: validBudget(),
    ...overrides
  };
}

/** Every terminal `BackgroundJob` (`completed`/`cancelled`/`failed`) must
 * carry a non-null `result` -- `assertBackgroundJob` (schemas) enforces
 * this structurally, so any test that constructs or transitions a job into
 * a terminal status needs one too. */
function terminalResult(stopReason: "completed" | "cancelled" | "failed" = "completed") {
  return { stopReason, candidateResults: [], optimizationResultId: null, objectiveSatisfactionResultId: null, summary: "done" };
}

describe("BackgroundJobStore: save", () => {
  it("saves a queued job and retrieves it by id", () => {
    const store = createBackgroundJobStore();
    const job = createBackgroundJob(jobInput());
    store.save(job);
    assert.deepEqual(store.getById(job.id), job);
  });

  it("rejects saving a job that is not 'queued'", () => {
    const store = createBackgroundJobStore();
    const job = createBackgroundJob({ ...jobInput(), status: "cancelled", result: terminalResult("cancelled") });
    assert.throws(() => store.save(job), WorldModelValidationError);
  });

  it("rejects a duplicate id", () => {
    const store = createBackgroundJobStore();
    const job = createBackgroundJob(jobInput());
    store.save(job);
    assert.throws(() => store.save(job), WorldModelValidationError);
  });
});

describe("BackgroundJobStore: listing", () => {
  it("listForProject scopes correctly", () => {
    const store = createBackgroundJobStore();
    const jobA = createBackgroundJob(jobInput({ projectId: "proj_a" }));
    const jobB = createBackgroundJob(jobInput({ projectId: "proj_b" }));
    store.save(jobA);
    store.save(jobB);
    assert.deepEqual(store.listForProject("proj_a"), [jobA]);
    assert.equal(store.list().length, 2);
  });

  it("getRunningJobForProject returns undefined when nothing is running, and the running job once one is", () => {
    const store = createBackgroundJobStore();
    const job = createBackgroundJob(jobInput());
    store.save(job);
    assert.equal(store.getRunningJobForProject(job.projectId), undefined);
    store.transition(job.id, "running");
    assert.equal(store.getRunningJobForProject(job.projectId)?.id, job.id);
  });

  it("getRunningJobForProject never conflates two different projects", () => {
    const store = createBackgroundJobStore();
    const jobA = createBackgroundJob(jobInput({ projectId: "proj_a" }));
    store.save(jobA);
    store.transition(jobA.id, "running");
    assert.equal(store.getRunningJobForProject("proj_b"), undefined);
  });
});

describe("BackgroundJobStore: AUDIT FIX -- transition's patch cannot smuggle scope/authority/budget changes through", () => {
  it("a runtime-bypassed patch (as if TypeScript's own narrower type were circumvented) carrying budget/autonomyLevel/allowedTools/projectId is silently ignored -- only consumption/result/failureReason are ever applied", () => {
    const store = createBackgroundJobStore();
    const job = createBackgroundJob(jobInput());
    store.save(job);
    const maliciousPatch = {
      budget: { maxIterations: 999999, maxDurationMs: 999999, maxToolCalls: 999999, maxModelCalls: 999999, maxCandidates: 999999 },
      autonomyLevel: "autonomous",
      allowedTools: ["*"],
      projectId: "proj_stolen",
      candidateIds: ["candidate_injected"]
    } as never;
    const running = store.transition(job.id, "running", maliciousPatch);
    assert.deepEqual(running.budget, job.budget, "budget must be completely unaffected by an out-of-band patch field");
    assert.equal(running.autonomyLevel, job.autonomyLevel);
    assert.deepEqual(running.allowedTools, job.allowedTools);
    assert.equal(running.projectId, job.projectId);
    assert.deepEqual(running.candidateIds, job.candidateIds);
  });
});

describe("BackgroundJobStore: transition", () => {
  it("applies a legal transition and updates the matching lifecycle timestamp", () => {
    const store = createBackgroundJobStore();
    const job = createBackgroundJob(jobInput());
    store.save(job);
    assert.equal(job.startedAt, null);
    const running = store.transition(job.id, "running");
    assert.ok(running.startedAt);
    assert.equal(running.status, "running");
  });

  it("rejects an illegal transition (completed -> running)", () => {
    const store = createBackgroundJobStore();
    const job = createBackgroundJob(jobInput());
    store.save(job);
    store.transition(job.id, "running");
    store.transition(job.id, "completed", { result: terminalResult() });
    assert.throws(() => store.transition(job.id, "running"), WorldModelValidationError);
  });

  it("rejects transitioning an unknown job id", () => {
    const store = createBackgroundJobStore();
    assert.throws(() => store.transition("job_does_not_exist", "running"), WorldModelValidationError);
  });

  it("sets cancelRequestedAt exactly once, on the first move into cancelling/cancelled", () => {
    const store = createBackgroundJobStore();
    const job = createBackgroundJob(jobInput());
    store.save(job);
    store.transition(job.id, "running");
    const cancelling = store.transition(job.id, "cancelling");
    assert.ok(cancelling.cancelRequestedAt);
    const firstCancelRequestedAt = cancelling.cancelRequestedAt;
    const cancelled = store.transition(job.id, "cancelled", { result: terminalResult("cancelled") });
    assert.equal(cancelled.cancelRequestedAt, firstCancelRequestedAt, "cancelRequestedAt must not be overwritten once already set");
  });

  it("sets completedAt exactly on entering a terminal status", () => {
    const store = createBackgroundJobStore();
    const job = createBackgroundJob(jobInput({ candidateIds: [] }));
    store.save(job);
    store.transition(job.id, "running");
    const completed = store.transition(job.id, "completed", {
      result: terminalResult()
    });
    assert.ok(completed.completedAt);
  });

  it("a queued job can be cancelled directly without ever running", () => {
    const store = createBackgroundJobStore();
    const job = createBackgroundJob(jobInput());
    store.save(job);
    const cancelled = store.transition(job.id, "cancelled", { result: terminalResult("cancelled") });
    assert.equal(cancelled.status, "cancelled");
    assert.ok(cancelled.cancelRequestedAt);
    assert.ok(cancelled.completedAt);
  });
});

describe("BackgroundJobStore: serialization", () => {
  it("round-trips a mixed set of jobs at various lifecycle stages", () => {
    const store = createBackgroundJobStore();
    const queued = createBackgroundJob(jobInput());
    const toRun = createBackgroundJob(jobInput());
    store.save(queued);
    store.save(toRun);
    store.transition(toRun.id, "running");
    store.transition(toRun.id, "completed", {
      result: terminalResult()
    });

    const restored = deserializeBackgroundJobStore(store.serialize());
    assert.deepEqual([...restored.list()].sort((a, b) => a.id.localeCompare(b.id)), [...store.list()].sort((a, b) => a.id.localeCompare(b.id)));
  });

  it("rejects corrupted JSON", () => {
    assert.throws(() => deserializeBackgroundJobStore("{not json"), SyntaxError);
  });

  it("rejects a well-formed array of invalid job shapes", () => {
    assert.throws(() => deserializeBackgroundJobStore(JSON.stringify([{ not: "a job" }])), WorldModelValidationError);
  });

  it("rejects an empty string", () => {
    assert.throws(() => deserializeBackgroundJobStore(""), WorldModelValidationError);
  });
});
