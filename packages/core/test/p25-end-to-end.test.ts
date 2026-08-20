import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createCandidate,
  createCandidateMetricValue,
  createCheck,
  createDesignSpecification,
  createEvidence,
  createOptimizationProblem,
  createWorldModelState,
  UNAVAILABLE_ENVIRONMENT_GEOMETRY,
  type BackgroundJob,
  type Candidate,
  type CandidateInput,
  type DesignSpecification,
  type DesignSpecificationInput,
  type EnvironmentObject,
  type EnvironmentOperationResult,
  type EnvironmentSession,
  type MemoryRecord,
  type OptimizationResult,
  type WorldModelState
} from "@naqsh/schemas";
import { runBackgroundJob, type VerifyCandidateContext } from "../src/background-job-runner.js";
import { createBackgroundJobStore } from "../src/background-job-store.js";
import { createJobEventStore } from "../src/job-event-store.js";
import { createCandidateStore } from "../src/candidate-store.js";
import { createDesignSpecificationStore } from "../src/design-specification-store.js";
import { createBuildResultStore } from "../src/build-result-store.js";
import { createVerificationResultStore } from "../src/verification-result-store.js";
import { createCandidateMetricValueStore } from "../src/optimization-metric-store.js";
import { createOptimizationProblemStore } from "../src/optimization-problem-store.js";
import { createOptimizationResultStore } from "../src/optimization-result-store.js";
import { computeOptimizationResult } from "../src/optimization-engine.js";
import { evaluateObjectiveSatisfaction } from "../src/objective-satisfaction.js";
import { createMemoryStore } from "../src/memory-store.js";
import { createMemoryAddTool } from "../src/memory-add-tool.js";
import { createSubmitBackgroundJobTool } from "../src/submit-background-job-tool.js";
import { createApprovalStore } from "../src/approval-store.js";
import { createAutonomyGrantStore } from "../src/autonomy-grant-store.js";
import { evaluateCheck } from "../src/verify.js";
import { executeTool } from "../src/execute-tool.js";
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

/**
 * PHASE 25 END-TO-END: the brief's own realistic scenario.
 *
 *   Project P1, objective "minimize mass, subject to strength >= 130 N"
 *     -> Candidates A, B, C, D (real Candidates/DesignSpecifications, P22)
 *     -> One BackgroundJob (P25), bounded budget, autonomyLevel "autonomous",
 *        an explicit tool allowlist -- submitted through the real
 *        submit_background_job tool, run through the real runBackgroundJob
 *     -> Each candidate: checkpoint -> build -> verify (real Checks/
 *        VerificationResults, P16) -> rollback to baseline (P15) --
 *        candidate A fails the strength check, B/C/D pass it
 *     -> Optimization (P23): among the feasible candidates, minimize mass
 *        -> C is uniquely Pareto-optimal
 *     -> Objective satisfaction (P17): evaluated for the selected
 *        candidate C, using its OWN real VerificationResult
 *     -> A MemoryRecord (P24) records the finding, grounded only in real,
 *        cross-checkable ids produced by every step above
 *
 * Every fact this test asserts is produced by REAL, unmodified phase
 * machinery -- never fabricated JSON standing in for what those systems
 * would have computed.
 */

function buildFakeAdapter(objects: Map<string, EnvironmentObject>) {
  const now = () => new Date().toISOString();
  const session: EnvironmentSession = { id: "sess_1", environmentKind: "fake", status: "connected", documentName: "fake.doc", openedAt: now(), metadata: {} };
  const checkpoints = new Map<string, Map<string, EnvironmentObject>>();
  let nextId = 1;

  function ok(operation: EnvironmentOperationResult["operation"], data: unknown): EnvironmentOperationResult {
    return { id: `envop_${Math.random()}`, operation, sessionId: session.id, objectId: null, status: "success", data, error: null, startedAt: now(), completedAt: now(), metadata: {} };
  }
  function err(operation: EnvironmentOperationResult["operation"], kind: "unsupported_capability" | "object_not_found", message: string): EnvironmentOperationResult {
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
    projectId: "proj_bracket",
    projectVersion: 1,
    planId: "plan_bracket",
    planStepId: "step_bracket",
    objectiveSummary: "Minimize mass while maintaining strength >= 130 N.",
    description: "A mounting bracket.",
    components: [{ id: "comp_plate", name: "Bracket", type: "plate", geometryIntent: "Load-bearing plate" }],
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
    hypothesis: "A candidate bracket design.",
    rationale: "Explores a mass/strength tradeoff point.",
    ...overrides
  };
}

const MUTATE_TOOLS = ["add_experiment", "update_experiment", "create_environment_object", "restore_checkpoint"];
const ALLOWED_TOOLS = ["create_checkpoint", ...MUTATE_TOOLS];

describe("P25 end-to-end: minimize-mass-subject-to-strength, 4 candidates", () => {
  it("bounded background job builds+verifies A-D, isolates each candidate, selects the correct optimum, and produces a memory-reachable, cross-checkable finding", async () => {
    const objects = new Map<string, EnvironmentObject>();
    const { adapter, session } = buildFakeAdapter(objects);
    let state: WorldModelState = createWorldModelState({ project: { id: "proj_bracket", name: "Mounting Bracket" }, session: {} });
    let connectedSession: EnvironmentSession | null = session;
    const history = createChangeHistory();
    const checkpointStore = createCheckpointStore();
    const artifactStore = createArtifactStore();
    const buildResultStore = createBuildResultStore();
    const candidateStore = createCandidateStore();
    const designSpecificationStore = createDesignSpecificationStore();
    const verificationResultStore = createVerificationResultStore();
    const metricStore = createCandidateMetricValueStore();
    const problemStore = createOptimizationProblemStore();
    const resultStore = createOptimizationResultStore();
    const memoryStore = createMemoryStore();
    const jobStore = createBackgroundJobStore();
    const eventStore = createJobEventStore();
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    autonomyGrants.create({ toolNames: MUTATE_TOOLS, targetType: null, targetId: null, reason: "test", grantedBy: "human" });

    const getState = () => state;
    const setState = (next: WorldModelState) => {
      state = next;
    };
    const registry = createToolRegistry();
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
    const submitTool = createSubmitBackgroundJobTool(candidateStore, jobStore, eventStore, getState, "autonomous");
    registry.register(submitTool.tool, submitTool.handler);

    // ---- Candidates A-D: real Candidate/DesignSpecification records ----
    // A fails the strength constraint; B, C, D satisfy it. Among the
    // feasible set, minimizing mass alone makes C uniquely optimal
    // (mass 8 < B's 10 < D's 12).
    const measurements: Record<string, { mass: number; strength: number }> = {
      A: { mass: 6, strength: 110 },
      B: { mass: 10, strength: 150 },
      C: { mass: 8, strength: 140 },
      D: { mass: 12, strength: 160 }
    };
    const candidates: Record<string, Candidate> = {};
    for (const label of ["A", "B", "C", "D"]) {
      const design = createDesignSpecification(designInput({ description: `Candidate ${label}` }));
      designSpecificationStore.save(design);
      const candidate = createCandidate(candidateInput(design, { hypothesis: `Candidate ${label}: mass/strength tradeoff point.` }));
      candidateStore.save(candidate);
      candidates[label] = candidate;
    }

    // ---- Submit the bounded job through the REAL tool ----
    const { result: submitResult } = await executeTool(registry, {
      toolName: "submit_background_job",
      input: {
        objective: "Minimize mass subject to strength >= 130 N across candidates A-D.",
        candidateIds: ["A", "B", "C", "D"].map((label) => candidates[label]!.id),
        autonomyLevel: "autonomous",
        allowedTools: ALLOWED_TOOLS,
        budget: { maxIterations: 10, maxDurationMs: 60000, maxToolCalls: 200, maxModelCalls: 10, maxCandidates: 10 }
      }
    });
    assert.equal(submitResult.status, "success");
    const submittedJob = (submitResult.output as { job: BackgroundJob }).job;

    const strengthCheck = createCheck({ kind: "bounds_check", description: "Strength must be at least 130 N.", objectId: "envobj_bracket", property: "strength", min: 130, max: null, unit: "N" });
    let currentLabel = "A";
    const labelsInOrder = ["A", "B", "C", "D"];
    let labelCursor = 0;

    // ---- Run the bounded job: for each candidate, checkpoint -> build ->
    // verify (real Checks/VerificationResults) -> rollback to baseline. ----
    const job = await runBackgroundJob({
      registry,
      jobStore,
      eventStore,
      candidateStore,
      designSpecificationStore,
      buildResultStore,
      approvals,
      autonomyGrants,
      jobId: submittedJob.id,
      rollbackAfterEachCandidate: true,
      verifyCandidate: async (ctx: VerifyCandidateContext) => {
        currentLabel = labelsInOrder[labelCursor]!;
        labelCursor += 1;
        const measurement = measurements[currentLabel]!;
        const version = getState().project.version;

        const strengthEvidence = createEvidence({ objectId: "envobj_bracket", objectExists: true, property: "strength", propertyExists: true, observedValue: measurement.strength, unit: "N", stateVersion: version, source: "system" });
        const strengthResult = evaluateCheck(strengthCheck, strengthEvidence, { projectId: getState().project.id, projectVersion: version });

        const massCheck = createCheck({ kind: "numeric_comparison", description: `Record candidate ${currentLabel}'s mass.`, objectId: "envobj_bracket", property: "mass", operator: "eq", expectedValue: measurement.mass, tolerance: 0.01 });
        const massEvidence = createEvidence({ objectId: "envobj_bracket", objectExists: true, property: "mass", propertyExists: true, observedValue: measurement.mass, unit: "kg", stateVersion: version, source: "system" });
        const massResult = evaluateCheck(massCheck, massEvidence, { projectId: getState().project.id, projectVersion: version });

        verificationResultStore.save(strengthResult);
        verificationResultStore.save(massResult);

        metricStore.save(createCandidateMetricValue({ candidateId: ctx.candidate.id, metricKey: "strength", status: "measured", provenanceKind: "verification_result", verificationResultId: strengthResult.id, value: measurement.strength }));
        metricStore.save(createCandidateMetricValue({ candidateId: ctx.candidate.id, metricKey: "mass", status: "measured", provenanceKind: "verification_result", verificationResultId: massResult.id, value: measurement.mass }));

        return [strengthResult, massResult];
      }
    });

    // ---- Bounded execution, deterministic verification, correct job status ----
    assert.equal(job.status, "completed");
    assert.equal(job.result!.stopReason, "completed");
    assert.equal(job.result!.candidateResults.length, 4);
    assert.ok(job.result!.candidateResults.every((entry) => entry.outcome === "evaluated"), "every candidate's build succeeded (verification is a SEPARATE fact from build success)");
    assert.ok(job.consumption.candidatesEvaluated <= job.budget.maxCandidates);
    assert.ok(job.consumption.toolCallsUsed <= job.budget.maxToolCalls, "bounded: never exceeds the declared tool-call budget in this scenario");

    // ---- Full resource release / correct baseline preservation: every
    // candidate was rolled back, so the environment ends exactly as it
    // started -- no leaked mutation from any candidate, including the last. ----
    assert.equal(objects.size, 0, "rollbackAfterEachCandidate must leave the environment at its pre-job baseline");
    assert.ok(job.result!.candidateResults.every((entry) => entry.rolledBack === true));

    // ---- Experiment results reachable via the real World Model (P2) ----
    // Every candidate's Experiment was created and updated, then reverted
    // out of LIVE state by its own rollback -- but the append-only
    // ChangeHistory still records the full lifecycle of each one.
    const historyEntityIds = history.list().map((change) => change.target.entityId);
    for (const entry of job.result!.candidateResults) {
      assert.ok(historyEntityIds.includes(entry.experimentId), `experiment ${entry.experimentId} for candidate ${entry.candidateId} must remain permanently auditable`);
    }

    // ---- No unauthorized mutation: every build/checkpoint/restore call
    // went through the real, authorized executeTool boundary -- confirmed
    // by the job actually succeeding under "autonomous" with explicit
    // grants (an unauthorized call would have produced build_failed
    // outcomes instead, as proven by the runner's own authorization tests). ----

    // ---- Deterministic verification: each candidate's VerificationResults
    // are real, independently retrievable records -- never fabricated. ----
    const candidateResultByLabel = (label: string) => job.result!.candidateResults.find((entry) => entry.candidateId === candidates[label]!.id)!;
    const resultA = candidateResultByLabel("A");
    const strengthVerificationA = verificationResultStore.getById(resultA.verificationResultIds[0]!)!;
    assert.equal(strengthVerificationA.status, "fail", "candidate A fails the strength constraint");
    for (const label of ["B", "C", "D"]) {
      const entry = candidateResultByLabel(label);
      const strengthVerification = verificationResultStore.getById(entry.verificationResultIds[0]!)!;
      assert.equal(strengthVerification.status, "pass", `candidate ${label} must pass the strength constraint`);
    }

    // ---- Optimization (P23): among the FEASIBLE candidates (B, C, D),
    // minimizing mass alone makes C uniquely Pareto-optimal. A is excluded
    // by the hard constraint, matching the real, unmodified engine's own
    // feasibility computation -- never re-derived by this test. ----
    const problem = createOptimizationProblem({
      projectId: state.project.id,
      projectVersion: state.project.version,
      candidateIds: ["A", "B", "C", "D"].map((label) => candidates[label]!.id),
      objectives: [{ metricKey: "mass", description: "Minimize mass.", direction: "minimize" }],
      constraints: [{ metricKey: "strength", description: "Strength must be at least 130 N.", operator: "gte", threshold: 130 }]
    });
    problemStore.save(problem);
    const optimizationResult: OptimizationResult = computeOptimizationResult(problem, metricStore);
    resultStore.save(optimizationResult);

    assert.deepEqual(optimizationResult.infeasibleCandidateIds, [candidates.A!.id]);
    assert.deepEqual(optimizationResult.paretoOptimalCandidateIds, [candidates.C!.id], "C has the lowest mass among the feasible candidates B/C/D");

    // ---- Objective satisfaction (P17), evaluated for the SELECTED
    // candidate C, using its OWN real VerificationResult -- kept
    // STRUCTURALLY SEPARATE from "job completed": the job can complete
    // (every candidate attempted) independently of whether the underlying
    // engineering objective is satisfied. ----
    const resultC = candidateResultByLabel("C");
    const strengthVerificationC = verificationResultStore.getById(resultC.verificationResultIds[0]!)!;
    // Evaluated against the project version strengthVerificationC was
    // itself captured at (not the LATER, current state) -- by now candidate
    // D's own run and rollback have advanced state.project.version further,
    // and evaluateObjectiveSatisfaction correctly treats a verification
    // result as stale once the version it names no longer matches, exactly
    // like evaluateCheck's own staleness rule (P16).
    const satisfaction = evaluateObjectiveSatisfaction(
      [{ checkId: strengthCheck.id, requirementId: null, constraintId: null, required: true, verificationResult: strengthVerificationC }],
      { projectId: state.project.id, projectVersion: strengthVerificationC.projectVersion, objectiveSummary: problem.objectives[0]!.description }
    );
    assert.equal(satisfaction.status, "satisfied");
    assert.notEqual(job.result!.stopReason, "failed", "'job completed' and 'objective satisfied' are reported through two separate, never-conflated records");

    // ---- Memory (P24): a durable finding grounded ONLY in real,
    // cross-checkable ids produced by the steps above. ----
    const memoryRegistry = createToolRegistry();
    const { tool: addMemoryTool, handler: addMemoryHandler } = createMemoryAddTool(memoryStore, () => state, {
      candidateStore,
      optimizationResultStore: resultStore,
      verificationResultStore
    });
    memoryRegistry.register(addMemoryTool, addMemoryHandler);

    const { result: memoryResult } = await executeTool(memoryRegistry, {
      toolName: "memory_add",
      input: {
        kind: "decision",
        title: "Candidate C selected for the mounting bracket",
        content: "Across a bounded background job evaluating candidates A-D, A failed the strength requirement; among the feasible B/C/D, C had the lowest mass and is the Pareto-optimal choice.",
        provenanceKind: "optimization_result",
        references: {
          candidateIds: [candidates.A!.id, candidates.B!.id, candidates.C!.id, candidates.D!.id],
          verificationResultIds: [strengthVerificationA.id, strengthVerificationC.id],
          optimizationResultIds: [optimizationResult.id]
        }
      }
    });
    assert.equal(memoryResult.status, "success");
    const memory = (memoryResult.output as { memory: MemoryRecord }).memory;

    // The memory is reachable and its citations resolve back to the real
    // records this test independently already asserted facts about.
    const reFetchedMemory = memoryStore.getById(memory.id);
    assert.ok(reFetchedMemory);
    assert.deepEqual(reFetchedMemory!.references.optimizationResultIds, [optimizationResult.id]);
    assert.deepEqual(resultStore.getById(reFetchedMemory!.references.optimizationResultIds[0]!)!.paretoOptimalCandidateIds, [candidates.C!.id]);
  });
});
