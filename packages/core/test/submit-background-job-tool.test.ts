import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCandidate, createDesignSpecification, createWorldModelState, type AutonomyLevel, type BackgroundJob, type CandidateInput, type DesignSpecificationInput, type WorldModelState } from "@naqsh/schemas";
import { createSubmitBackgroundJobTool } from "../src/submit-background-job-tool.js";
import { createCandidateStore } from "../src/candidate-store.js";
import { createBackgroundJobStore } from "../src/background-job-store.js";
import { createJobEventStore } from "../src/job-event-store.js";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry } from "../src/tool-registry.js";

function designInput(overrides: Partial<DesignSpecificationInput> = {}): DesignSpecificationInput {
  return {
    projectId: "proj_1",
    projectVersion: 1,
    planId: "plan_1",
    planStepId: "step_1",
    objectiveSummary: "Design a bracket.",
    description: "A plate.",
    components: [{ id: "comp_1", name: "Plate", type: "plate", geometryIntent: "Rectangular" }],
    expectedOutputs: [{ componentId: "comp_1", environmentObjectType: "part", environmentGenericType: "solid" }],
    ...overrides
  };
}

function candidateInput(overrides: Partial<CandidateInput> = {}): CandidateInput {
  return { projectId: "proj_1", projectVersion: 1, planId: "plan_1", planStepId: "step_1", hypothesis: "h", rationale: "r", ...overrides };
}

function validBudget() {
  return { maxIterations: 10, maxDurationMs: 60000, maxToolCalls: 100, maxModelCalls: 10, maxCandidates: 10 };
}

function buildHarness(maxAutonomyLevel: AutonomyLevel = "autonomous") {
  const candidateStore = createCandidateStore();
  const jobStore = createBackgroundJobStore();
  const eventStore = createJobEventStore();
  let state: WorldModelState = createWorldModelState({ project: { id: "proj_1", name: "Bracket Study" }, session: {} });
  const registry = createToolRegistry();
  const { tool, handler } = createSubmitBackgroundJobTool(candidateStore, jobStore, eventStore, () => state, maxAutonomyLevel);
  registry.register(tool, handler);
  return { registry, candidateStore, jobStore, eventStore, getState: () => state };
}

function saveBuildableCandidate(harness: ReturnType<typeof buildHarness>, overrides: Partial<CandidateInput> = {}) {
  const design = createDesignSpecification(designInput());
  const candidate = createCandidate(candidateInput({ designSpecificationId: design.id, ...overrides }));
  harness.candidateStore.save(candidate);
  return candidate;
}

describe("createSubmitBackgroundJobTool: identity and classification", () => {
  it("is classified suggest/job -- never mutates the World Model or the environment", () => {
    const { registry } = buildHarness();
    const tool = registry.getByName("submit_background_job")!;
    assert.equal(tool.mutation, "suggest");
    assert.equal(tool.target, "job");
  });
});

describe("createSubmitBackgroundJobTool: creation", () => {
  it("creates a queued job, referencing real candidates, reading projectId/projectVersion from LIVE state (never caller-supplied)", async () => {
    const harness = buildHarness();
    const candidate = saveBuildableCandidate(harness);
    const { result } = await executeTool(harness.registry, {
      toolName: "submit_background_job",
      input: {
        objective: "Evaluate the candidate.",
        candidateIds: [candidate.id],
        autonomyLevel: "autonomous",
        allowedTools: ["create_checkpoint"],
        budget: validBudget(),
        projectId: "proj_spoofed"
      }
    });
    assert.equal(result.status, "success");
    const job = (result.output as { job: BackgroundJob }).job;
    assert.equal(job.status, "queued");
    assert.equal(job.projectId, "proj_1");
    assert.deepEqual(job.candidateIds, [candidate.id]);
    assert.deepEqual(harness.jobStore.getById(job.id), job);
  });

  it("records a 'submitted' JobEvent", async () => {
    const harness = buildHarness();
    const candidate = saveBuildableCandidate(harness);
    const { result } = await executeTool(harness.registry, {
      toolName: "submit_background_job",
      input: { objective: "x", candidateIds: [candidate.id], autonomyLevel: "suggest", allowedTools: ["create_checkpoint"], budget: validBudget() }
    });
    const job = (result.output as { job: BackgroundJob }).job;
    const events = harness.eventStore.listForJob(job.id);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, "submitted");
  });

  it("accepts an empty candidateIds array (a legitimate no-op job)", async () => {
    const harness = buildHarness();
    const { result } = await executeTool(harness.registry, {
      toolName: "submit_background_job",
      input: { objective: "no-op", candidateIds: [], autonomyLevel: "suggest", allowedTools: ["create_checkpoint"], budget: validBudget() }
    });
    assert.equal(result.status, "success");
  });
});

describe("createSubmitBackgroundJobTool: candidate validation", () => {
  it("rejects a candidateId that does not exist", async () => {
    const harness = buildHarness();
    const { result } = await executeTool(harness.registry, {
      toolName: "submit_background_job",
      input: { objective: "x", candidateIds: ["candidate_ghost"], autonomyLevel: "suggest", allowedTools: ["create_checkpoint"], budget: validBudget() }
    });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /candidate_not_found/);
  });

  it("rejects a candidateId belonging to a different project", async () => {
    const harness = buildHarness();
    const design = createDesignSpecification(designInput({ projectId: "proj_other", projectVersion: 1 }));
    const foreignCandidate = createCandidate(candidateInput({ projectId: "proj_other", projectVersion: 1, designSpecificationId: design.id }));
    harness.candidateStore.save(foreignCandidate);
    const { result } = await executeTool(harness.registry, {
      toolName: "submit_background_job",
      input: { objective: "x", candidateIds: [foreignCandidate.id], autonomyLevel: "suggest", allowedTools: ["create_checkpoint"], budget: validBudget() }
    });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /candidate_not_found/);
  });

  it("rejects a candidate with no designSpecificationId -- it could never be built by the runner", async () => {
    const harness = buildHarness();
    const candidate = createCandidate(candidateInput());
    harness.candidateStore.save(candidate);
    const { result } = await executeTool(harness.registry, {
      toolName: "submit_background_job",
      input: { objective: "x", candidateIds: [candidate.id], autonomyLevel: "suggest", allowedTools: ["create_checkpoint"], budget: validBudget() }
    });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /candidate_has_no_design/);
  });
});

describe("createSubmitBackgroundJobTool: AUDIT FIX -- a job can never carry more authority than its creator", () => {
  it("rejects a request for 'autonomous' when the submitting session's own ceiling is only 'suggest'", async () => {
    const harness = buildHarness("suggest");
    const { result } = await executeTool(harness.registry, {
      toolName: "submit_background_job",
      input: { objective: "x", candidateIds: [], autonomyLevel: "autonomous", allowedTools: ["create_checkpoint"], budget: validBudget() }
    });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /autonomy_ceiling_exceeded/);
  });

  it("rejects a request for 'approved_modify' when the ceiling is 'observe'", async () => {
    const harness = buildHarness("observe");
    const { result } = await executeTool(harness.registry, {
      toolName: "submit_background_job",
      input: { objective: "x", candidateIds: [], autonomyLevel: "approved_modify", allowedTools: ["create_checkpoint"], budget: validBudget() }
    });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /autonomy_ceiling_exceeded/);
  });

  it("accepts a request exactly AT the ceiling", async () => {
    const harness = buildHarness("suggest");
    const { result } = await executeTool(harness.registry, {
      toolName: "submit_background_job",
      input: { objective: "x", candidateIds: [], autonomyLevel: "suggest", allowedTools: ["create_checkpoint"], budget: validBudget() }
    });
    assert.equal(result.status, "success");
  });

  it("accepts a request BELOW the ceiling", async () => {
    const harness = buildHarness("autonomous");
    const { result } = await executeTool(harness.registry, {
      toolName: "submit_background_job",
      input: { objective: "x", candidateIds: [], autonomyLevel: "observe", allowedTools: ["create_checkpoint"], budget: validBudget() }
    });
    assert.equal(result.status, "success");
  });
});

describe("createSubmitBackgroundJobTool: input validation", () => {
  it("rejects a missing objective", async () => {
    const harness = buildHarness();
    const { result } = await executeTool(harness.registry, {
      toolName: "submit_background_job",
      input: { candidateIds: [], autonomyLevel: "suggest", allowedTools: ["create_checkpoint"], budget: validBudget() }
    });
    assert.equal(result.status, "error");
  });

  it("rejects an empty allowedTools array -- there is no 'all tools' default", async () => {
    const harness = buildHarness();
    const { result } = await executeTool(harness.registry, {
      toolName: "submit_background_job",
      input: { objective: "x", candidateIds: [], autonomyLevel: "suggest", allowedTools: [], budget: validBudget() }
    });
    assert.equal(result.status, "error");
  });

  it("rejects an invalid autonomyLevel", async () => {
    const harness = buildHarness();
    const { result } = await executeTool(harness.registry, {
      toolName: "submit_background_job",
      input: { objective: "x", candidateIds: [], autonomyLevel: "godmode", allowedTools: ["create_checkpoint"], budget: validBudget() }
    });
    assert.equal(result.status, "error");
  });

  it("rejects an invalid budget (e.g. maxCandidates: 0) -- never silently unlimited", async () => {
    const harness = buildHarness();
    const { result } = await executeTool(harness.registry, {
      toolName: "submit_background_job",
      input: { objective: "x", candidateIds: [], autonomyLevel: "suggest", allowedTools: ["create_checkpoint"], budget: { ...validBudget(), maxCandidates: 0 } }
    });
    assert.equal(result.status, "error");
  });

  it("rejects a missing budget entirely", async () => {
    const harness = buildHarness();
    const { result } = await executeTool(harness.registry, {
      toolName: "submit_background_job",
      input: { objective: "x", candidateIds: [], autonomyLevel: "suggest", allowedTools: ["create_checkpoint"] }
    });
    assert.equal(result.status, "error");
  });
});
