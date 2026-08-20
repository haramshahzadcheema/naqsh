import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createBackgroundJob,
  createJobBudget,
  createJobBudgetConsumption,
  createJobCandidateResult,
  createJobEvent,
  createJobResult,
  deserializeBackgroundJob,
  deserializeJobEvent,
  isJobStatusTransitionAllowed,
  serializeBackgroundJob,
  serializeJobEvent,
  WorldModelValidationError,
  type BackgroundJobInput,
  type JobBudgetInput,
  type JobEventInput
} from "../src/index.js";

function validBudget(overrides: Partial<JobBudgetInput> = {}): JobBudgetInput {
  return { maxIterations: 10, maxDurationMs: 60000, maxToolCalls: 100, maxModelCalls: 10, maxCandidates: 10, ...overrides };
}

function jobInput(overrides: Partial<BackgroundJobInput> = {}): BackgroundJobInput {
  return {
    projectId: "proj_1",
    projectVersion: 1,
    objective: "Evaluate candidates A-D against the mass/strength objective.",
    candidateIds: ["candidate_a", "candidate_b"],
    autonomyLevel: "suggest",
    allowedTools: ["create_checkpoint", "add_experiment"],
    budget: validBudget(),
    ...overrides
  };
}

describe("JobBudget: validation", () => {
  it("creates a valid budget", () => {
    const budget = createJobBudget(validBudget());
    assert.equal(budget.maxCandidates, 10);
  });

  it("is frozen", () => {
    const budget = createJobBudget(validBudget());
    assert.throws(() => {
      (budget as { maxCandidates: number }).maxCandidates = 999;
    });
  });

  for (const field of ["maxIterations", "maxDurationMs", "maxToolCalls", "maxModelCalls", "maxCandidates"] as const) {
    it(`rejects a zero ${field}`, () => {
      assert.throws(() => createJobBudget(validBudget({ [field]: 0 })), WorldModelValidationError);
    });
    it(`rejects a negative ${field}`, () => {
      assert.throws(() => createJobBudget(validBudget({ [field]: -1 })), WorldModelValidationError);
    });
    it(`rejects NaN for ${field}`, () => {
      assert.throws(() => createJobBudget(validBudget({ [field]: Number.NaN })), WorldModelValidationError);
    });
    it(`rejects Infinity for ${field}`, () => {
      assert.throws(() => createJobBudget(validBudget({ [field]: Number.POSITIVE_INFINITY })), WorldModelValidationError);
    });
    it(`rejects a non-integer ${field}`, () => {
      assert.throws(() => createJobBudget(validBudget({ [field]: 1.5 })), WorldModelValidationError);
    });
  }

  it("AUDIT FIX: rejects undefined/null input as a controlled WorldModelValidationError, never a raw TypeError -- reachable through deserializeBackgroundJobStore on a hand-corrupted record missing 'budget' entirely", () => {
    assert.throws(() => createJobBudget(undefined as never), WorldModelValidationError);
    assert.throws(() => createJobBudget(null as never), WorldModelValidationError);
  });
});

describe("JobBudgetConsumption: defaults and validation", () => {
  it("defaults every field to 0", () => {
    const consumption = createJobBudgetConsumption();
    assert.deepEqual(consumption, { iterationsUsed: 0, durationMsUsed: 0, toolCallsUsed: 0, modelCallsUsed: 0, candidatesEvaluated: 0 });
  });

  it("accepts non-negative values", () => {
    const consumption = createJobBudgetConsumption({ iterationsUsed: 3, toolCallsUsed: 12 });
    assert.equal(consumption.iterationsUsed, 3);
    assert.equal(consumption.toolCallsUsed, 12);
  });
});

describe("JobStatus: transition table", () => {
  it("allows every documented legal transition", () => {
    const legal: Array<[string, string]> = [
      ["queued", "running"],
      ["queued", "cancelled"],
      ["running", "paused"],
      ["running", "cancelling"],
      ["running", "completed"],
      ["running", "failed"],
      ["paused", "running"],
      ["paused", "cancelling"],
      ["cancelling", "cancelled"]
    ];
    for (const [from, to] of legal) {
      assert.equal(isJobStatusTransitionAllowed(from as never, to as never), true, `${from} -> ${to} should be allowed`);
    }
  });

  it("rejects nonsense transitions", () => {
    const illegal: Array<[string, string]> = [
      ["completed", "running"],
      ["cancelled", "running"],
      ["failed", "running"],
      ["queued", "completed"],
      ["queued", "paused"],
      ["cancelling", "running"]
    ];
    for (const [from, to] of illegal) {
      assert.equal(isJobStatusTransitionAllowed(from as never, to as never), false, `${from} -> ${to} should be rejected`);
    }
  });
});

describe("BackgroundJob: creation and validation", () => {
  it("creates a valid queued job with defaults", () => {
    const job = createBackgroundJob(jobInput());
    assert.equal(job.status, "queued");
    assert.equal(job.result, null);
    assert.equal(job.failureReason, null);
    assert.equal(job.startedAt, null);
    assert.equal(job.completedAt, null);
    assert.equal(job.cancelRequestedAt, null);
    assert.ok(job.id.startsWith("job_"));
    assert.deepEqual(job.consumption, { iterationsUsed: 0, durationMsUsed: 0, toolCallsUsed: 0, modelCallsUsed: 0, candidatesEvaluated: 0 });
  });

  it("is frozen (immutable) after creation", () => {
    const job = createBackgroundJob(jobInput());
    assert.throws(() => {
      (job as { objective: string }).objective = "tampered";
    });
  });

  it("rejects an empty objective", () => {
    assert.throws(() => createBackgroundJob(jobInput({ objective: "" })), WorldModelValidationError);
  });

  it("rejects an empty allowedTools array", () => {
    assert.throws(() => createBackgroundJob(jobInput({ allowedTools: [] })), WorldModelValidationError);
  });

  it("accepts an empty candidateIds array (a legitimately no-op job)", () => {
    const job = createBackgroundJob(jobInput({ candidateIds: [] }));
    assert.deepEqual(job.candidateIds, []);
  });

  it("rejects an invalid autonomyLevel", () => {
    assert.throws(() => createBackgroundJob(jobInput({ autonomyLevel: "godmode" as never })), WorldModelValidationError);
  });

  it("rejects an invalid status", () => {
    assert.throws(() => createBackgroundJob({ ...jobInput(), status: "sleeping" as never }), WorldModelValidationError);
  });

  it("accepts a completed job with a result", () => {
    const job = createBackgroundJob({
      ...jobInput(),
      status: "completed",
      result: { stopReason: "completed", candidateResults: [], summary: "Evaluated 0 of 0 candidates." }
    });
    assert.equal(job.status, "completed");
    assert.ok(job.result);
    assert.equal(job.result!.stopReason, "completed");
    assert.ok(job.completedAt);
  });

  it("rejects a completed job with no result (via deserialize, bypassing factory defaulting)", () => {
    const job = createBackgroundJob(jobInput());
    const raw = { ...job, status: "completed", completedAt: job.createdAt };
    assert.throws(() => deserializeBackgroundJob(JSON.stringify(raw)), WorldModelValidationError);
  });

  it("rejects a failed job with no failureReason (via deserialize)", () => {
    const job = createBackgroundJob(jobInput());
    const raw = { ...job, status: "failed", completedAt: job.createdAt, result: { stopReason: "failed", candidateResults: [], summary: "x" } };
    assert.throws(() => deserializeBackgroundJob(JSON.stringify(raw)), WorldModelValidationError);
  });

  it("createBackgroundJob silently drops a result/failureReason for a non-terminal status", () => {
    const job = createBackgroundJob({
      ...jobInput(),
      result: { stopReason: "completed", candidateResults: [], summary: "x" },
      failureReason: "should be dropped"
    });
    assert.equal(job.result, null);
    assert.equal(job.failureReason, null);
  });

  it("cancelRequestedAt is set for cancelling/cancelled and null for queued", () => {
    const cancelling = createBackgroundJob({ ...jobInput(), status: "cancelling" });
    assert.ok(cancelling.cancelRequestedAt);
    const queued = createBackgroundJob(jobInput());
    assert.equal(queued.cancelRequestedAt, null);
  });

  it("serialization round-trips", () => {
    const job = createBackgroundJob(jobInput());
    const restored = deserializeBackgroundJob(serializeBackgroundJob(job));
    assert.deepEqual(restored, job);
  });

  it("rejects corrupted JSON on deserialize", () => {
    assert.throws(() => deserializeBackgroundJob("{not json"), SyntaxError);
  });

  it("rejects a well-formed but invalid object on deserialize", () => {
    assert.throws(() => deserializeBackgroundJob(JSON.stringify({ not: "a job" })), WorldModelValidationError);
  });
});

describe("JobResult: creation and validation", () => {
  it("creates a valid result with candidate results", () => {
    const result = createJobResult({
      stopReason: "candidate_limit_reached",
      candidateResults: [
        createJobCandidateResult({ candidateId: "candidate_a", outcome: "evaluated", buildStatus: "completed", experimentId: "experiment_1", checkpointBeforeId: "checkpoint_1" }),
        createJobCandidateResult({ candidateId: "candidate_b", outcome: "not_attempted" })
      ],
      summary: "Evaluated 1 of 2 candidates."
    });
    assert.equal(result.candidateResults.length, 2);
    assert.equal(result.candidateResults[1]!.outcome, "not_attempted");
  });

  it("rejects an empty summary", () => {
    assert.throws(() => createJobResult({ stopReason: "completed", candidateResults: [], summary: "" }), WorldModelValidationError);
  });

  it("rejects an invalid stopReason", () => {
    assert.throws(() => createJobResult({ stopReason: "vibes" as never, candidateResults: [], summary: "x" }), WorldModelValidationError);
  });
});

describe("JobEvent: creation, validation, serialization", () => {
  function eventInput(overrides: Partial<JobEventInput> = {}): JobEventInput {
    return { jobId: "job_1", projectId: "proj_1", kind: "submitted", message: "Job submitted.", ...overrides };
  }

  it("creates a valid event", () => {
    const event = createJobEvent(eventInput());
    assert.ok(event.id.startsWith("jobevent_"));
    assert.equal(event.kind, "submitted");
  });

  it("rejects an invalid kind", () => {
    assert.throws(() => createJobEvent(eventInput({ kind: "teleported" as never })), WorldModelValidationError);
  });

  it("serialization round-trips", () => {
    const event = createJobEvent(eventInput());
    const restored = deserializeJobEvent(serializeJobEvent(event));
    assert.deepEqual(restored, event);
  });

  it("rejects corrupted JSON on deserialize", () => {
    assert.throws(() => deserializeJobEvent("{not json"), SyntaxError);
  });
});
