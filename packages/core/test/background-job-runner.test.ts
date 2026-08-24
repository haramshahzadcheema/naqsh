import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createBackgroundJob,
  createCandidate,
  createCheck,
  createDesignSpecification,
  createEvidence,
  createWorldModelState,
  deserializeBackgroundJob,
  deserializeJobEvent,
  serializeBackgroundJob,
  serializeJobEvent,
  ToolError,
  UNAVAILABLE_ENVIRONMENT_GEOMETRY,
  type Candidate,
  type CandidateInput,
  type DesignSpecification,
  type DesignSpecificationInput,
  type EnvironmentObject,
  type EnvironmentOperationResult,
  type EnvironmentSession,
  type JobBudgetInput,
  type VerificationResult,
  type WorldModelState
} from "@naqsh/schemas";
import { runBackgroundJob, type VerifyCandidateContext } from "../src/background-job-runner.js";
import { createBackgroundJobStore } from "../src/background-job-store.js";
import { createJobEventStore } from "../src/job-event-store.js";
import { createCandidateStore } from "../src/candidate-store.js";
import { createDesignSpecificationStore } from "../src/design-specification-store.js";
import { createBuildResultStore } from "../src/build-result-store.js";
import { createVerificationResultStore } from "../src/verification-result-store.js";
import { createApprovalStore } from "../src/approval-store.js";
import { createAutonomyGrantStore } from "../src/autonomy-grant-store.js";
import { createFakeClock } from "../src/background-job-budget.js";
import { evaluateCheck } from "../src/verify.js";
import { createToolRegistry } from "../src/tool-registry.js";
import { createCreateEnvironmentObjectTool } from "../src/create-environment-object-tool.js";
import { createCreateCheckpointTool } from "../src/create-checkpoint-tool.js";
import { createRestoreCheckpointTool } from "../src/restore-checkpoint-tool.js";
import { createAddExperimentTool } from "../src/add-experiment-tool.js";
import { createUpdateExperimentTool } from "../src/update-experiment-tool.js";
import { createArtifactStore } from "../src/artifact-store.js";
import { createCheckpointStore } from "../src/checkpoint-store.js";
import { createChangeHistory } from "../src/change-history.js";
import type { EnvironmentAdapter } from "../src/environment-adapter.js";

/** Same fake adapter shape as experiment-executor.test.ts (create + checkpoint
 * + restore) -- P25's runner needs nothing more from the environment than
 * P22's executor already needed, since it delegates to it unmodified. */
function buildFakeAdapter(objects: Map<string, EnvironmentObject>, options: { failOnCreateCallNumber?: number } = {}) {
  const now = () => new Date().toISOString();
  const session: EnvironmentSession = { id: "sess_1", environmentKind: "fake", status: "connected", documentName: "fake.doc", openedAt: now(), metadata: {} };
  const checkpoints = new Map<string, Map<string, EnvironmentObject>>();
  let createCallCount = 0;
  let nextId = 1;

  function ok(operation: EnvironmentOperationResult["operation"], data: unknown): EnvironmentOperationResult {
    return { id: `envop_${Math.random()}`, operation, sessionId: session.id, objectId: null, status: "success", data, error: null, startedAt: now(), completedAt: now(), metadata: {} };
  }
  function err(operation: EnvironmentOperationResult["operation"], kind: "unsupported_capability" | "environment_failure" | "object_not_found", message: string): EnvironmentOperationResult {
    return { id: `envop_${Math.random()}`, operation, sessionId: session.id, objectId: null, status: "error", data: null, error: { kind, message }, startedAt: now(), completedAt: now(), metadata: {} };
  }

  const adapter: EnvironmentAdapter = {
    describe: () => ({ kind: "fake", name: "Fake Environment", version: "0.0.1", capabilities: ["create", "checkpoint"], metadata: {} }),
    health: async () => ok("health", { status: "healthy", message: "", checkedAt: now() }),
    connect: async () => ok("connect", session),
    disconnect: async () => ok("disconnect", null),
    listObjects: async () => ok("list_objects", [...objects.values()]),
    inspectObject: async () => err("unsupported_capability" as never, "unsupported_capability", "not used"),
    inspectDocument: async () => err("unsupported_capability" as never, "unsupported_capability", "not used"),
    createObject: async (_session, input) => {
      createCallCount += 1;
      if (options.failOnCreateCallNumber === createCallCount) {
        return err("create_object", "unsupported_capability", `forced failure on call ${createCallCount}`);
      }
      const id = `envobj_${nextId++}`;
      const object: EnvironmentObject = {
        id,
        type: input.type,
        name: input.name,
        genericType: input.genericType ?? "unknown",
        parentId: input.parentId ?? null,
        visible: input.visible ?? null,
        geometry: UNAVAILABLE_ENVIRONMENT_GEOMETRY,
        properties: (input.properties ?? []).map((p) => ({ key: p.key, value: p.value, readOnly: p.readOnly ?? false })),
        relationships: [],
        metadata: input.metadata ?? {}
      };
      objects.set(id, object);
      return ok("create_object", object);
    },
    modifyObject: async () => err("unsupported_capability" as never, "unsupported_capability", "not used"),
    deleteObject: async () => err("unsupported_capability" as never, "unsupported_capability", "not used"),
    save: async () => ok("save", null),
    checkpoint: async () => {
      const checkpointId = `chkpt_fake_${checkpoints.size + 1}`;
      checkpoints.set(checkpointId, new Map([...objects].map(([id, value]) => [id, { ...value }])));
      return ok("checkpoint", { checkpointId });
    },
    restore: async (_session, checkpointId) => {
      const snapshot = checkpoints.get(checkpointId);
      if (!snapshot) return err("restore", "object_not_found", `No checkpoint "${checkpointId}"`);
      objects.clear();
      for (const [id, value] of snapshot) objects.set(id, value);
      return ok("restore", null);
    }
  };

  return { adapter, session };
}

function designInput(overrides: Partial<DesignSpecificationInput> = {}): DesignSpecificationInput {
  return {
    projectId: "proj_1",
    projectVersion: 1,
    planId: "plan_1",
    planStepId: "step_1",
    objectiveSummary: "Design a lightweight mounting bracket.",
    description: "A rectangular mounting plate.",
    components: [{ id: "comp_plate", name: "Mounting Plate", type: "plate", geometryIntent: "Rectangular plate" }],
    expectedOutputs: [{ componentId: "comp_plate", environmentObjectType: "part", environmentGenericType: "solid" }],
    ...overrides
  };
}

function candidateInput(design: DesignSpecification, overrides: Partial<CandidateInput> = {}): CandidateInput {
  return {
    projectId: design.projectId,
    projectVersion: design.projectVersion,
    planId: design.planId,
    planStepId: design.planStepId,
    designSpecificationId: design.id,
    hypothesis: "This plate design meets the load requirement.",
    rationale: "Ribbing adds stiffness without much added mass.",
    ...overrides
  };
}

function validBudget(overrides: Partial<JobBudgetInput> = {}): JobBudgetInput {
  return { maxIterations: 10, maxDurationMs: 60000, maxToolCalls: 100, maxModelCalls: 10, maxCandidates: 10, ...overrides };
}

function buildHarness(adapterOptions: { failOnCreateCallNumber?: number } = {}) {
  const objects = new Map<string, EnvironmentObject>();
  const { adapter, session } = buildFakeAdapter(objects, adapterOptions);
  let state: WorldModelState = createWorldModelState({ project: { id: "proj_1", name: "Bracket Study" }, session: {} });
  let connectedSession: EnvironmentSession | null = session;
  const history = createChangeHistory();
  const checkpointStore = createCheckpointStore();
  const artifactStore = createArtifactStore();
  const buildResultStore = createBuildResultStore();
  const candidateStore = createCandidateStore();
  const designSpecificationStore = createDesignSpecificationStore();
  const verificationResultStore = createVerificationResultStore();
  const jobStore = createBackgroundJobStore();
  const eventStore = createJobEventStore();
  const approvals = createApprovalStore();
  const autonomyGrants = createAutonomyGrantStore();
  // AUTONOMOUS level (the default for these tests) consults AutonomyGrant,
  // not Approval, for every "mutate"-classified tool -- create_checkpoint
  // is "suggest" and needs no grant, but add_experiment/update_experiment/
  // create_environment_object/restore_checkpoint are all "mutate" and are
  // otherwise denied even under "autonomous" (mirrors experiment-executor.
  // test.ts's own "succeeds end-to-end when every step is granted" setup).
  // Tests that specifically exercise authorization DENIAL use a fresh,
  // ungranted store instead of this harness default.
  autonomyGrants.create({
    toolNames: ["add_experiment", "update_experiment", "create_environment_object", "restore_checkpoint"],
    targetType: null,
    targetId: null,
    reason: "test harness default grant",
    grantedBy: "human"
  });
  const registry = createToolRegistry();

  const getState = () => state;
  const setState = (next: WorldModelState) => {
    state = next;
  };

  const envTool = createCreateEnvironmentObjectTool(() => connectedSession, adapter);
  registry.register(envTool.tool, envTool.handler);
  const checkpointTool = createCreateCheckpointTool(getState, history, () => connectedSession, adapter, checkpointStore, artifactStore);
  registry.register(checkpointTool.tool, checkpointTool.handler);
  const restoreTool = createRestoreCheckpointTool(getState, setState, history, () => connectedSession, adapter, checkpointStore, artifactStore);
  registry.register(restoreTool.tool, restoreTool.handler);
  const addExperimentTool = createAddExperimentTool(getState, setState, history);
  registry.register(addExperimentTool.tool, addExperimentTool.handler);
  const updateExperimentTool = createUpdateExperimentTool(getState, setState, history);
  registry.register(updateExperimentTool.tool, updateExperimentTool.handler);

  function makeCandidate(description: string, hypothesis: string): Candidate {
    const design = createDesignSpecification(designInput({ description }));
    designSpecificationStore.save(design);
    const candidate = createCandidate(candidateInput(design, { hypothesis }));
    candidateStore.save(candidate);
    return candidate;
  }

  return {
    registry,
    history,
    buildResultStore,
    candidateStore,
    designSpecificationStore,
    verificationResultStore,
    jobStore,
    eventStore,
    approvals,
    autonomyGrants,
    getObjects: () => objects,
    getState,
    setState,
    makeCandidate,
    disconnect: () => {
      connectedSession = null;
    }
  };
}

const FULL_ALLOWLIST = ["create_checkpoint", "add_experiment", "update_experiment", "create_environment_object", "restore_checkpoint"];

describe("runBackgroundJob: happy path", () => {
  it("runs every candidate to completion, records events, and produces a correct JobResult", async () => {
    const harness = buildHarness();
    const candidateA = harness.makeCandidate("A", "Hypothesis A");
    const candidateB = harness.makeCandidate("B", "Hypothesis B");

    harness.jobStore.save(
      createBackgroundJob({
        projectId: harness.getState().project.id,
        projectVersion: harness.getState().project.version,
        objective: "Evaluate A and B.",
        candidateIds: [candidateA.id, candidateB.id],
        autonomyLevel: "autonomous",
        allowedTools: FULL_ALLOWLIST,
        budget: validBudget()
      })
    );
    const queued = harness.jobStore.list()[0]!;

    const job = await runBackgroundJob({
      registry: harness.registry,
      jobStore: harness.jobStore,
      eventStore: harness.eventStore,
      candidateStore: harness.candidateStore,
      designSpecificationStore: harness.designSpecificationStore,
      buildResultStore: harness.buildResultStore,
      approvals: harness.approvals,
      autonomyGrants: harness.autonomyGrants,
      jobId: queued.id
    });

    assert.equal(job.status, "completed");
    assert.equal(job.result!.stopReason, "completed");
    assert.equal(job.result!.candidateResults.length, 2);
    assert.ok(job.result!.candidateResults.every((entry) => entry.outcome === "evaluated"));
    assert.equal(job.consumption.candidatesEvaluated, 2);
    assert.equal(job.consumption.iterationsUsed, 2);
    assert.ok(job.consumption.toolCallsUsed > 0);

    const events = harness.eventStore.listForJob(job.id).map((event) => event.kind);
    assert.deepEqual(events, ["started", "candidate_started", "candidate_completed", "candidate_started", "candidate_completed", "completed"]);
  });

  it("preserves job.candidateIds' declared order in candidateResults, deterministically", async () => {
    const harness = buildHarness();
    const candidates = [harness.makeCandidate("A", "H-A"), harness.makeCandidate("B", "H-B"), harness.makeCandidate("C", "H-C")];
    harness.jobStore.save(
      createBackgroundJob({
        projectId: harness.getState().project.id,
        projectVersion: harness.getState().project.version,
        objective: "Order test.",
        candidateIds: candidates.map((c) => c.id),
        autonomyLevel: "autonomous",
        allowedTools: FULL_ALLOWLIST,
        budget: validBudget()
      })
    );
    const queued = harness.jobStore.list()[0]!;
    const job = await runBackgroundJob({
      registry: harness.registry,
      jobStore: harness.jobStore,
      eventStore: harness.eventStore,
      candidateStore: harness.candidateStore,
      designSpecificationStore: harness.designSpecificationStore,
      buildResultStore: harness.buildResultStore,
      approvals: harness.approvals,
      autonomyGrants: harness.autonomyGrants,
      jobId: queued.id
    });
    assert.deepEqual(
      job.result!.candidateResults.map((entry) => entry.candidateId),
      candidates.map((c) => c.id)
    );
  });

  it("an empty candidateIds job completes immediately with no candidates attempted", async () => {
    const harness = buildHarness();
    harness.jobStore.save(
      createBackgroundJob({
        projectId: harness.getState().project.id,
        projectVersion: harness.getState().project.version,
        objective: "No-op job.",
        candidateIds: [],
        autonomyLevel: "autonomous",
        allowedTools: FULL_ALLOWLIST,
        budget: validBudget()
      })
    );
    const queued = harness.jobStore.list()[0]!;
    const job = await runBackgroundJob({
      registry: harness.registry,
      jobStore: harness.jobStore,
      eventStore: harness.eventStore,
      candidateStore: harness.candidateStore,
      designSpecificationStore: harness.designSpecificationStore,
      buildResultStore: harness.buildResultStore,
      approvals: harness.approvals,
      autonomyGrants: harness.autonomyGrants,
      jobId: queued.id
    });
    assert.equal(job.status, "completed");
    assert.equal(job.result!.stopReason, "completed");
    assert.deepEqual(job.result!.candidateResults, []);
  });
});

describe("runBackgroundJob: budget enforcement (each dimension individually)", () => {
  async function makeQueuedJob(harness: ReturnType<typeof buildHarness>, candidateIds: string[], budget: Partial<JobBudgetInput>, allowedTools = FULL_ALLOWLIST) {
    const job = createBackgroundJob({
      projectId: harness.getState().project.id,
      projectVersion: harness.getState().project.version,
      objective: "Budget test.",
      candidateIds,
      autonomyLevel: "autonomous",
      allowedTools,
      budget: validBudget(budget)
    });
    harness.jobStore.save(job);
    return job.id;
  }

  it("maxCandidates stops the run early, leaving the rest not_attempted", async () => {
    const harness = buildHarness();
    const candidates = [harness.makeCandidate("A", "H-A"), harness.makeCandidate("B", "H-B"), harness.makeCandidate("C", "H-C")];
    const jobId = await makeQueuedJob(harness, candidates.map((c) => c.id), { maxCandidates: 1 });
    const job = await runBackgroundJob({
      registry: harness.registry,
      jobStore: harness.jobStore,
      eventStore: harness.eventStore,
      candidateStore: harness.candidateStore,
      designSpecificationStore: harness.designSpecificationStore,
      buildResultStore: harness.buildResultStore,
      approvals: harness.approvals,
      autonomyGrants: harness.autonomyGrants,
      jobId
    });
    assert.equal(job.result!.stopReason, "candidate_limit_reached");
    assert.equal(job.result!.candidateResults[0]!.outcome, "evaluated");
    assert.equal(job.result!.candidateResults[1]!.outcome, "not_attempted");
    assert.equal(job.result!.candidateResults[2]!.outcome, "not_attempted");
  });

  it("maxIterations stops the run identically to maxCandidates in this runner (1:1 today)", async () => {
    const harness = buildHarness();
    const candidates = [harness.makeCandidate("A", "H-A"), harness.makeCandidate("B", "H-B")];
    const jobId = await makeQueuedJob(harness, candidates.map((c) => c.id), { maxIterations: 1, maxCandidates: 10 });
    const job = await runBackgroundJob({
      registry: harness.registry,
      jobStore: harness.jobStore,
      eventStore: harness.eventStore,
      candidateStore: harness.candidateStore,
      designSpecificationStore: harness.designSpecificationStore,
      buildResultStore: harness.buildResultStore,
      approvals: harness.approvals,
      autonomyGrants: harness.autonomyGrants,
      jobId
    });
    assert.equal(job.result!.stopReason, "iteration_limit_reached");
  });

  it("maxDurationMs (monotonic FakeClock) stops the run once elapsed time exceeds the budget", async () => {
    const harness = buildHarness();
    const candidates = [harness.makeCandidate("A", "H-A"), harness.makeCandidate("B", "H-B")];
    const jobId = await makeQueuedJob(harness, candidates.map((c) => c.id), { maxDurationMs: 100, maxCandidates: 10 });
    const clock = createFakeClock(0);
    let calls = 0;
    const job = await runBackgroundJob({
      registry: harness.registry,
      jobStore: harness.jobStore,
      eventStore: harness.eventStore,
      candidateStore: harness.candidateStore,
      designSpecificationStore: harness.designSpecificationStore,
      buildResultStore: harness.buildResultStore,
      approvals: harness.approvals,
      autonomyGrants: harness.autonomyGrants,
      clock,
      jobId,
      verifyCandidate: async () => {
        calls += 1;
        clock.advance(200); // exceeds maxDurationMs after the first candidate
        return [];
      }
    });
    assert.equal(job.result!.stopReason, "time_limit_reached");
    assert.equal(calls, 1, "only the first candidate should have run before the duration budget stopped the loop");
  });

  it("maxToolCalls stops the run at the NEXT iteration boundary once a prior candidate already overshot it (budget is checked once per iteration, never mid-candidate)", async () => {
    const harness = buildHarness();
    const candidates = [harness.makeCandidate("A", "H-A"), harness.makeCandidate("B", "H-B")];
    const jobId = await makeQueuedJob(harness, candidates.map((c) => c.id), { maxToolCalls: 1, maxCandidates: 10 });
    const job = await runBackgroundJob({
      registry: harness.registry,
      jobStore: harness.jobStore,
      eventStore: harness.eventStore,
      candidateStore: harness.candidateStore,
      designSpecificationStore: harness.designSpecificationStore,
      buildResultStore: harness.buildResultStore,
      approvals: harness.approvals,
      autonomyGrants: harness.autonomyGrants,
      jobId
    });
    assert.equal(job.result!.stopReason, "tool_call_limit_reached");
    assert.equal(job.result!.candidateResults[0]!.outcome, "evaluated", "candidate 1 already started before the budget was exhausted, and completes -- an honest, documented tradeoff");
    assert.equal(job.result!.candidateResults[1]!.outcome, "not_attempted");
    assert.ok(job.consumption.toolCallsUsed > 1, "consumption still reflects the real overshoot, even though the run only stops on the next boundary");
  });

  it("maxModelCalls stops the run once a verifyCandidate hook reports enough model calls", async () => {
    const harness = buildHarness();
    const candidates = [harness.makeCandidate("A", "H-A"), harness.makeCandidate("B", "H-B")];
    const jobId = await makeQueuedJob(harness, candidates.map((c) => c.id), { maxModelCalls: 1, maxCandidates: 10 });
    const job = await runBackgroundJob({
      registry: harness.registry,
      jobStore: harness.jobStore,
      eventStore: harness.eventStore,
      candidateStore: harness.candidateStore,
      designSpecificationStore: harness.designSpecificationStore,
      buildResultStore: harness.buildResultStore,
      approvals: harness.approvals,
      autonomyGrants: harness.autonomyGrants,
      jobId,
      verifyCandidate: async (ctx: VerifyCandidateContext) => {
        ctx.recordModelCall();
        return [];
      }
    });
    assert.equal(job.result!.stopReason, "model_call_limit_reached");
    assert.equal(job.result!.candidateResults[0]!.outcome, "evaluated", "the first candidate's own build+verification still completed before the budget check stopped the SECOND iteration");
    assert.equal(job.result!.candidateResults[1]!.outcome, "not_attempted");
  });
});

describe("runBackgroundJob: authorization and tool allowlist", () => {
  it("an 'observe' autonomyLevel cannot mutate -- every candidate is recorded build_failed, but the JOB itself still completes (per-candidate failure is not a job failure)", async () => {
    const harness = buildHarness();
    const candidates = [harness.makeCandidate("A", "H-A")];
    const job = createBackgroundJob({
      projectId: harness.getState().project.id,
      projectVersion: harness.getState().project.version,
      objective: "Observe-only job.",
      candidateIds: candidates.map((c) => c.id),
      autonomyLevel: "observe",
      allowedTools: FULL_ALLOWLIST,
      budget: validBudget()
    });
    harness.jobStore.save(job);
    const result = await runBackgroundJob({
      registry: harness.registry,
      jobStore: harness.jobStore,
      eventStore: harness.eventStore,
      candidateStore: harness.candidateStore,
      designSpecificationStore: harness.designSpecificationStore,
      buildResultStore: harness.buildResultStore,
      approvals: harness.approvals,
      autonomyGrants: harness.autonomyGrants,
      jobId: job.id
    });
    assert.equal(result.status, "completed");
    assert.equal(result.result!.candidateResults[0]!.outcome, "build_failed");
    assert.equal(harness.getObjects().size, 0, "nothing was actually mutated");
  });

  it("a tool missing from the job's own allowedTools is denied even though P4 would otherwise permit it", async () => {
    const harness = buildHarness();
    const candidates = [harness.makeCandidate("A", "H-A")];
    // autonomous (P4 would allow everything) but allowedTools omits
    // create_environment_object -- the job's OWN scope should still deny it.
    const job = createBackgroundJob({
      projectId: harness.getState().project.id,
      projectVersion: harness.getState().project.version,
      objective: "Restricted allowlist job.",
      candidateIds: candidates.map((c) => c.id),
      autonomyLevel: "autonomous",
      allowedTools: ["create_checkpoint", "add_experiment", "update_experiment"],
      budget: validBudget()
    });
    harness.jobStore.save(job);
    const result = await runBackgroundJob({
      registry: harness.registry,
      jobStore: harness.jobStore,
      eventStore: harness.eventStore,
      candidateStore: harness.candidateStore,
      designSpecificationStore: harness.designSpecificationStore,
      buildResultStore: harness.buildResultStore,
      approvals: harness.approvals,
      autonomyGrants: harness.autonomyGrants,
      jobId: job.id
    });
    assert.equal(result.result!.candidateResults[0]!.outcome, "build_failed");
    assert.equal(harness.getObjects().size, 0);
  });
});

describe("runBackgroundJob: concurrency policy", () => {
  it("refuses to start a second job for a project that already has one running", async () => {
    const harness = buildHarness();
    const candidateA = harness.makeCandidate("A", "H-A");
    const candidateB = harness.makeCandidate("B", "H-B");
    const jobOneInput = { projectId: harness.getState().project.id, projectVersion: harness.getState().project.version, objective: "One", candidateIds: [candidateA.id], autonomyLevel: "autonomous" as const, allowedTools: FULL_ALLOWLIST, budget: validBudget() };
    const jobOne = createBackgroundJob(jobOneInput);
    harness.jobStore.save(jobOne);
    harness.jobStore.transition(jobOne.id, "running");

    const jobTwo = createBackgroundJob({ ...jobOneInput, objective: "Two", candidateIds: [candidateB.id] });
    harness.jobStore.save(jobTwo);

    await assert.rejects(
      () =>
        runBackgroundJob({
          registry: harness.registry,
          jobStore: harness.jobStore,
          eventStore: harness.eventStore,
          candidateStore: harness.candidateStore,
          designSpecificationStore: harness.designSpecificationStore,
          buildResultStore: harness.buildResultStore,
          approvals: harness.approvals,
          autonomyGrants: harness.autonomyGrants,
          jobId: jobTwo.id
        }),
      (error: unknown) => error instanceof ToolError && /project_job_conflict/.test(error.message)
    );
  });

  it("a TRUE concurrent race (both runBackgroundJob calls fired via Promise.all, no manual pre-staging) still lets exactly one job run and rejects the other -- proven empirically, not just reasoned about", async () => {
    const harness = buildHarness();
    const candidateA = harness.makeCandidate("A", "H-A");
    const candidateB = harness.makeCandidate("B", "H-B");
    const jobOneInput = { projectId: harness.getState().project.id, projectVersion: harness.getState().project.version, objective: "One", candidateIds: [candidateA.id], autonomyLevel: "autonomous" as const, allowedTools: FULL_ALLOWLIST, budget: validBudget() };
    const jobOne = createBackgroundJob(jobOneInput);
    const jobTwo = createBackgroundJob({ ...jobOneInput, objective: "Two", candidateIds: [candidateB.id] });
    harness.jobStore.save(jobOne);
    harness.jobStore.save(jobTwo);

    const runOne = () =>
      runBackgroundJob({
        registry: harness.registry,
        jobStore: harness.jobStore,
        eventStore: harness.eventStore,
        candidateStore: harness.candidateStore,
        designSpecificationStore: harness.designSpecificationStore,
        buildResultStore: harness.buildResultStore,
        approvals: harness.approvals,
        autonomyGrants: harness.autonomyGrants,
        jobId: jobOne.id
      });
    const runTwo = () =>
      runBackgroundJob({
        registry: harness.registry,
        jobStore: harness.jobStore,
        eventStore: harness.eventStore,
        candidateStore: harness.candidateStore,
        designSpecificationStore: harness.designSpecificationStore,
        buildResultStore: harness.buildResultStore,
        approvals: harness.approvals,
        autonomyGrants: harness.autonomyGrants,
        jobId: jobTwo.id
      });

    const results = await Promise.allSettled([runOne(), runTwo()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one of the two concurrently-fired jobs must actually run");
    assert.equal(rejected.length, 1, "the other must be rejected with project_job_conflict, never silently dropped or allowed to also mutate");
    const rejectionReason = rejected[0]!.status === "rejected" ? rejected[0]!.reason : null;
    assert.ok(rejectionReason instanceof ToolError && /project_job_conflict/.test(rejectionReason.message));
  });

  it("refuses to run a job that is not currently queued", async () => {
    const harness = buildHarness();
    const candidateA = harness.makeCandidate("A", "H-A");
    const job = createBackgroundJob({ projectId: harness.getState().project.id, projectVersion: harness.getState().project.version, objective: "X", candidateIds: [candidateA.id], autonomyLevel: "autonomous", allowedTools: FULL_ALLOWLIST, budget: validBudget() });
    harness.jobStore.save(job);
    // Already running (e.g. a second, stale call to runBackgroundJob for a
    // job some other caller already started) -- must be rejected, not
    // silently re-run from the top.
    harness.jobStore.transition(job.id, "running");
    await assert.rejects(
      () =>
        runBackgroundJob({
          registry: harness.registry,
          jobStore: harness.jobStore,
          eventStore: harness.eventStore,
          candidateStore: harness.candidateStore,
          designSpecificationStore: harness.designSpecificationStore,
          buildResultStore: harness.buildResultStore,
          approvals: harness.approvals,
          autonomyGrants: harness.autonomyGrants,
          jobId: job.id
        }),
      (error: unknown) => error instanceof ToolError && /job_not_queued/.test(error.message)
    );
  });
});

describe("runBackgroundJob: cooperative cancellation", () => {
  it("stops at the next iteration boundary once another actor moves the job to 'cancelling', without touching the remaining candidates", async () => {
    const harness = buildHarness();
    const candidates = [harness.makeCandidate("A", "H-A"), harness.makeCandidate("B", "H-B"), harness.makeCandidate("C", "H-C")];
    const job = createBackgroundJob({
      projectId: harness.getState().project.id,
      projectVersion: harness.getState().project.version,
      objective: "Cancel mid-run.",
      candidateIds: candidates.map((c) => c.id),
      autonomyLevel: "autonomous",
      allowedTools: FULL_ALLOWLIST,
      budget: validBudget()
    });
    harness.jobStore.save(job);

    let candidateCount = 0;
    const result = await runBackgroundJob({
      registry: harness.registry,
      jobStore: harness.jobStore,
      eventStore: harness.eventStore,
      candidateStore: harness.candidateStore,
      designSpecificationStore: harness.designSpecificationStore,
      buildResultStore: harness.buildResultStore,
      approvals: harness.approvals,
      autonomyGrants: harness.autonomyGrants,
      jobId: job.id,
      verifyCandidate: async () => {
        candidateCount += 1;
        if (candidateCount === 1) {
          // Simulate an external actor (the cancel_background_job tool)
          // requesting cancellation WHILE candidate 1 is still finishing up.
          harness.jobStore.transition(job.id, "cancelling");
        }
        return [];
      }
    });

    assert.equal(result.status, "cancelled");
    assert.equal(result.result!.stopReason, "cancelled");
    assert.equal(result.result!.candidateResults[0]!.outcome, "evaluated", "candidate 1 was already in flight and finishes normally");
    assert.equal(result.result!.candidateResults[1]!.outcome, "not_attempted");
    assert.equal(result.result!.candidateResults[2]!.outcome, "not_attempted");
    assert.equal(candidateCount, 1, "candidate 2 must never start once cancellation was observed");
  });
});

describe("runBackgroundJob: rollback integration", () => {
  it("rollbackAfterEachCandidate restores the environment to baseline after every candidate, so no candidate inherits a prior one's mutation", async () => {
    const harness = buildHarness();
    const candidates = [harness.makeCandidate("A", "H-A"), harness.makeCandidate("B", "H-B")];
    const job = createBackgroundJob({
      projectId: harness.getState().project.id,
      projectVersion: harness.getState().project.version,
      objective: "Rollback test.",
      candidateIds: candidates.map((c) => c.id),
      autonomyLevel: "autonomous",
      allowedTools: FULL_ALLOWLIST,
      budget: validBudget()
    });
    harness.jobStore.save(job);

    const sizesAfterEachCandidate: number[] = [];
    const result = await runBackgroundJob({
      registry: harness.registry,
      jobStore: harness.jobStore,
      eventStore: harness.eventStore,
      candidateStore: harness.candidateStore,
      designSpecificationStore: harness.designSpecificationStore,
      buildResultStore: harness.buildResultStore,
      approvals: harness.approvals,
      autonomyGrants: harness.autonomyGrants,
      jobId: job.id,
      rollbackAfterEachCandidate: true,
      verifyCandidate: async () => {
        sizesAfterEachCandidate.push(harness.getObjects().size);
        return [];
      }
    });

    assert.deepEqual(sizesAfterEachCandidate, [1, 1], "each candidate's own object exists DURING its verification step, before rollback");
    assert.equal(harness.getObjects().size, 0, "the LAST candidate was also rolled back -- no mutation survives the run");
    assert.ok(result.result!.candidateResults.every((entry) => entry.rolledBack === true));
  });
});

describe("runBackgroundJob: verification integration (P16)", () => {
  it("attaches real VerificationResult ids produced by a caller-supplied verifyCandidate hook, never a fabricated verdict", async () => {
    const harness = buildHarness();
    const candidate = harness.makeCandidate("A", "H-A");
    const job = createBackgroundJob({
      projectId: harness.getState().project.id,
      projectVersion: harness.getState().project.version,
      objective: "Verify test.",
      candidateIds: [candidate.id],
      autonomyLevel: "autonomous",
      allowedTools: FULL_ALLOWLIST,
      budget: validBudget()
    });
    harness.jobStore.save(job);

    const check = createCheck({ kind: "bounds_check", description: "Mass must be under 5kg.", objectId: "envobj_1", property: "mass", min: null, max: 5, unit: "kg" });
    const result = await runBackgroundJob({
      registry: harness.registry,
      jobStore: harness.jobStore,
      eventStore: harness.eventStore,
      candidateStore: harness.candidateStore,
      designSpecificationStore: harness.designSpecificationStore,
      buildResultStore: harness.buildResultStore,
      approvals: harness.approvals,
      autonomyGrants: harness.autonomyGrants,
      jobId: job.id,
      verifyCandidate: async () => {
        const evidence = createEvidence({ objectId: "envobj_1", objectExists: true, property: "mass", propertyExists: true, observedValue: 3, unit: "kg", stateVersion: harness.getState().project.version, source: "system" });
        const verification: VerificationResult = evaluateCheck(check, evidence, { projectId: harness.getState().project.id, projectVersion: harness.getState().project.version });
        harness.verificationResultStore.save(verification);
        return [verification];
      }
    });

    const candidateResult = result.result!.candidateResults[0]!;
    assert.equal(candidateResult.verificationResultIds.length, 1);
    const stored = harness.verificationResultStore.getById(candidateResult.verificationResultIds[0]!);
    assert.ok(stored);
    assert.equal(stored!.status, "pass");

    // AUDIT FIX: the real Experiment record itself (not just this job's own
    // JobCandidateResult bookkeeping) must carry the same verificationResultIds
    // -- compareCandidates (P22) reads verification data exclusively off
    // Experiment.verificationResultIds, so a caller comparing candidates
    // after a background job ran must see the same results this job just
    // produced, not an empty list.
    const experiment = harness.getState().project.experiments.find((e) => e.candidateId === candidate.id);
    assert.ok(experiment, "an Experiment must have been recorded for this candidate");
    assert.deepEqual(experiment!.verificationResultIds, candidateResult.verificationResultIds);
  });

  it("a verifyCandidate hook producing ZERO results leaves the Experiment's verificationResultIds untouched (no pointless update_experiment call)", async () => {
    const harness = buildHarness();
    const candidate = harness.makeCandidate("A", "H-A");
    const job = createBackgroundJob({
      projectId: harness.getState().project.id,
      projectVersion: harness.getState().project.version,
      objective: "Empty verification test.",
      candidateIds: [candidate.id],
      autonomyLevel: "autonomous",
      allowedTools: FULL_ALLOWLIST,
      budget: validBudget()
    });
    harness.jobStore.save(job);

    await runBackgroundJob({
      registry: harness.registry,
      jobStore: harness.jobStore,
      eventStore: harness.eventStore,
      candidateStore: harness.candidateStore,
      designSpecificationStore: harness.designSpecificationStore,
      buildResultStore: harness.buildResultStore,
      approvals: harness.approvals,
      autonomyGrants: harness.autonomyGrants,
      jobId: job.id,
      verifyCandidate: async () => []
    });

    const experiment = harness.getState().project.experiments.find((e) => e.candidateId === candidate.id);
    assert.ok(experiment);
    assert.deepEqual(experiment!.verificationResultIds, []);
  });
});

describe("runBackgroundJob: AUDIT FIX -- a candidate whose build fails WITHOUT throwing still gets a full audit trail", () => {
  it("records a 'candidate_completed' JobEvent even when executeExperimentForCandidate returns a failed build normally (never throws)", async () => {
    // failOnCreateCallNumber: 1 reproduces experiment-executor.test.ts's own
    // "records a failed Experiment when the build fails, without throwing"
    // precedent -- the exact non-exceptional failure path the original
    // runner silently produced NO event for.
    const harness = buildHarness({ failOnCreateCallNumber: 1 });
    const candidate = harness.makeCandidate("A", "H-A");
    const job = createBackgroundJob({
      projectId: harness.getState().project.id,
      projectVersion: harness.getState().project.version,
      objective: "Audit trail test.",
      candidateIds: [candidate.id],
      autonomyLevel: "autonomous",
      allowedTools: FULL_ALLOWLIST,
      budget: validBudget()
    });
    harness.jobStore.save(job);

    const result = await runBackgroundJob({
      registry: harness.registry,
      jobStore: harness.jobStore,
      eventStore: harness.eventStore,
      candidateStore: harness.candidateStore,
      designSpecificationStore: harness.designSpecificationStore,
      buildResultStore: harness.buildResultStore,
      approvals: harness.approvals,
      autonomyGrants: harness.autonomyGrants,
      jobId: job.id
    });

    assert.equal(result.result!.candidateResults[0]!.outcome, "build_failed");
    const events = harness.eventStore.listForJob(job.id).map((event) => event.kind);
    assert.deepEqual(events, ["started", "candidate_started", "candidate_completed", "completed"], "a build_failed candidate (via a non-thrown failed BuildResult) must still produce exactly one candidate_completed event");
  });
});

describe("runBackgroundJob: system-level anomaly handling", () => {
  it("fails the whole job (never silently skips) if a candidateId no longer resolves -- state corrupted after submission", async () => {
    const harness = buildHarness();
    const job = createBackgroundJob({
      projectId: harness.getState().project.id,
      projectVersion: harness.getState().project.version,
      objective: "Corrupted job.",
      candidateIds: ["candidate_does_not_exist"],
      autonomyLevel: "autonomous",
      allowedTools: FULL_ALLOWLIST,
      budget: validBudget()
    });
    harness.jobStore.save(job);
    const result = await runBackgroundJob({
      registry: harness.registry,
      jobStore: harness.jobStore,
      eventStore: harness.eventStore,
      candidateStore: harness.candidateStore,
      designSpecificationStore: harness.designSpecificationStore,
      buildResultStore: harness.buildResultStore,
      approvals: harness.approvals,
      autonomyGrants: harness.autonomyGrants,
      jobId: job.id
    });
    assert.equal(result.status, "failed");
    assert.match(result.failureReason ?? "", /unresolvable_candidate/);
  });

  it("AUDIT FIX (PROJECT ISOLATION): fails the whole job if a candidateId resolves to a candidate belonging to a DIFFERENT project than the job -- defended at run time, not merely at submission time", async () => {
    const harness = buildHarness();
    const foreignDesign = createDesignSpecification(designInput({ projectId: "proj_other", projectVersion: 1, description: "Foreign" }));
    harness.designSpecificationStore.save(foreignDesign);
    const foreignCandidate = createCandidate(candidateInput(foreignDesign, { hypothesis: "Foreign candidate" }));
    harness.candidateStore.save(foreignCandidate);

    const job = createBackgroundJob({
      projectId: harness.getState().project.id, // "proj_1"
      projectVersion: harness.getState().project.version,
      objective: "Cross-project leakage attempt.",
      candidateIds: [foreignCandidate.id],
      autonomyLevel: "autonomous",
      allowedTools: FULL_ALLOWLIST,
      budget: validBudget()
    });
    harness.jobStore.save(job);

    const result = await runBackgroundJob({
      registry: harness.registry,
      jobStore: harness.jobStore,
      eventStore: harness.eventStore,
      candidateStore: harness.candidateStore,
      designSpecificationStore: harness.designSpecificationStore,
      buildResultStore: harness.buildResultStore,
      approvals: harness.approvals,
      autonomyGrants: harness.autonomyGrants,
      jobId: job.id
    });

    assert.equal(result.status, "failed");
    assert.match(result.failureReason ?? "", /cross_project_candidate/);
    assert.equal(harness.getObjects().size, 0, "no build must ever be attempted against a cross-project candidate");
  });

  it("AUDIT FIX (PROJECT ISOLATION): fails the whole job if a candidate's OWN design belongs to a different project than the job (even though the candidate itself matches)", async () => {
    const harness = buildHarness();
    const foreignDesign = createDesignSpecification(designInput({ projectId: "proj_other", projectVersion: 1, description: "Foreign design" }));
    harness.designSpecificationStore.save(foreignDesign);
    // The candidate itself claims the CORRECT project, but points at a
    // design belonging to a different one -- a data-integrity anomaly
    // that must never be silently trusted.
    const mismatchedCandidate = createCandidate(candidateInput(foreignDesign, { projectId: "proj_1", projectVersion: 1, hypothesis: "Mismatched design" }));
    harness.candidateStore.save(mismatchedCandidate);

    const job = createBackgroundJob({
      projectId: harness.getState().project.id,
      projectVersion: harness.getState().project.version,
      objective: "Cross-project design leakage attempt.",
      candidateIds: [mismatchedCandidate.id],
      autonomyLevel: "autonomous",
      allowedTools: FULL_ALLOWLIST,
      budget: validBudget()
    });
    harness.jobStore.save(job);

    const result = await runBackgroundJob({
      registry: harness.registry,
      jobStore: harness.jobStore,
      eventStore: harness.eventStore,
      candidateStore: harness.candidateStore,
      designSpecificationStore: harness.designSpecificationStore,
      buildResultStore: harness.buildResultStore,
      approvals: harness.approvals,
      autonomyGrants: harness.autonomyGrants,
      jobId: job.id
    });

    assert.equal(result.status, "failed");
    assert.match(result.failureReason ?? "", /cross_project_design/);
    assert.equal(harness.getObjects().size, 0);
  });
});

describe("runBackgroundJob: serialization survives a full run", () => {
  it("the terminal BackgroundJob and its JobEvents round-trip through serialize/deserialize", async () => {
    const harness = buildHarness();
    const candidate = harness.makeCandidate("A", "H-A");
    const job = createBackgroundJob({
      projectId: harness.getState().project.id,
      projectVersion: harness.getState().project.version,
      objective: "Serialization test.",
      candidateIds: [candidate.id],
      autonomyLevel: "autonomous",
      allowedTools: FULL_ALLOWLIST,
      budget: validBudget()
    });
    harness.jobStore.save(job);
    const result = await runBackgroundJob({
      registry: harness.registry,
      jobStore: harness.jobStore,
      eventStore: harness.eventStore,
      candidateStore: harness.candidateStore,
      designSpecificationStore: harness.designSpecificationStore,
      buildResultStore: harness.buildResultStore,
      approvals: harness.approvals,
      autonomyGrants: harness.autonomyGrants,
      jobId: job.id
    });
    const restored = deserializeBackgroundJob(serializeBackgroundJob(result));
    assert.deepEqual(restored, result);

    for (const event of harness.eventStore.listForJob(job.id)) {
      assert.deepEqual(deserializeJobEvent(serializeJobEvent(event)), event);
    }
  });
});
