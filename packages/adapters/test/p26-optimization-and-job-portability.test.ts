import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createBackgroundJob,
  createCandidate,
  createCandidateMetricValue,
  createDesignSpecification,
  createOptimizationProblem,
  createWorldModelState,
  type Candidate,
  type EnvironmentSession,
  type WorldModelState
} from "@naqsh/schemas";
import {
  computeOptimizationResult,
  createCandidateMetricValueStore,
  createOptimizationResultStore,
  createCandidateStore,
  createDesignSpecificationStore,
  createBuildResultStore,
  createBackgroundJobStore,
  createJobEventStore,
  createApprovalStore,
  createAutonomyGrantStore,
  createToolRegistry,
  createCreateEnvironmentObjectTool,
  createModifyEnvironmentObjectTool,
  createCreateCheckpointTool,
  createRestoreCheckpointTool,
  createAddExperimentTool,
  createUpdateExperimentTool,
  createArtifactStore,
  createCheckpointStore,
  createChangeHistory,
  runBackgroundJob
} from "@naqsh/core";
import { createMockSimulationEnvironment } from "../src/mock-simulation-environment.js";

/**
 * PHASE 26: proves P23 (optimization) and P25 (background jobs) are
 * genuinely environment-independent, not merely "structurally decoupled
 * in theory."
 *
 * P23's `computeOptimizationResult` (core) never imports `EnvironmentAdapter`
 * at all (repo-boundaries-enforced) -- it operates purely on
 * `CandidateMetricValue` records, which carry no environment reference
 * whatsoever. This test makes that structural fact CONCRETE: the exact
 * same optimizer call, run once over CAD-flavored metrics (mass/strength)
 * and once over simulation-flavored metrics (energy/thermal), produces
 * correct Pareto/feasibility results either way.
 *
 * P25's `runBackgroundJob` (core) is proven against `mock_simulation`
 * here specifically BECAUSE every other P25 test in this repository only
 * ever exercised it against CAD-flavored (create-capable) environments --
 * this closes that gap with a real, executed background job whose
 * candidates modify an EXISTING simulation object (`targetObjectId`,
 * P26), never create one.
 */

describe("P26: P23 optimization is genuinely environment-independent", () => {
  it("the SAME computeOptimizationResult call correctly ranks CAD-flavored candidates (minimize mass, subject to strength) and simulation-flavored candidates (minimize energy, subject to thermal margin)", () => {
    // ---- CAD-flavored optimization problem ----
    const cadMetrics = createCandidateMetricValueStore();
    cadMetrics.save(createCandidateMetricValue({ candidateId: "cand_cad_a", metricKey: "mass", status: "measured", provenanceKind: "verification_result", verificationResultId: "vr_1", value: 6 }));
    cadMetrics.save(createCandidateMetricValue({ candidateId: "cand_cad_a", metricKey: "strength", status: "measured", provenanceKind: "verification_result", verificationResultId: "vr_2", value: 100 }));
    cadMetrics.save(createCandidateMetricValue({ candidateId: "cand_cad_b", metricKey: "mass", status: "measured", provenanceKind: "verification_result", verificationResultId: "vr_3", value: 9 }));
    cadMetrics.save(createCandidateMetricValue({ candidateId: "cand_cad_b", metricKey: "strength", status: "measured", provenanceKind: "verification_result", verificationResultId: "vr_4", value: 150 }));

    const cadProblem = createOptimizationProblem({
      projectId: "proj_cad",
      projectVersion: 1,
      candidateIds: ["cand_cad_a", "cand_cad_b"],
      objectives: [{ metricKey: "mass", description: "Minimize mass.", direction: "minimize" }],
      constraints: [{ metricKey: "strength", description: "Strength must be at least 130 N.", operator: "gte", threshold: 130 }]
    });
    const cadResult = computeOptimizationResult(cadProblem, cadMetrics);
    assert.deepEqual(cadResult.infeasibleCandidateIds, ["cand_cad_a"], "candidate A fails the strength constraint");
    assert.deepEqual(cadResult.paretoOptimalCandidateIds, ["cand_cad_b"], "candidate B is the only feasible candidate");

    // ---- Simulation-flavored optimization problem -- SAME function ----
    const simMetrics = createCandidateMetricValueStore();
    simMetrics.save(createCandidateMetricValue({ candidateId: "cand_sim_a", metricKey: "energyJ", status: "measured", provenanceKind: "verification_result", verificationResultId: "vr_5", value: 40 }));
    simMetrics.save(createCandidateMetricValue({ candidateId: "cand_sim_a", metricKey: "thermalMarginC", status: "measured", provenanceKind: "verification_result", verificationResultId: "vr_6", value: 3 }));
    simMetrics.save(createCandidateMetricValue({ candidateId: "cand_sim_b", metricKey: "energyJ", status: "measured", provenanceKind: "verification_result", verificationResultId: "vr_7", value: 55 }));
    simMetrics.save(createCandidateMetricValue({ candidateId: "cand_sim_b", metricKey: "thermalMarginC", status: "measured", provenanceKind: "verification_result", verificationResultId: "vr_8", value: 12 }));

    const simProblem = createOptimizationProblem({
      projectId: "proj_sim",
      projectVersion: 1,
      candidateIds: ["cand_sim_a", "cand_sim_b"],
      objectives: [{ metricKey: "energyJ", description: "Minimize energy consumption.", direction: "minimize" }],
      constraints: [{ metricKey: "thermalMarginC", description: "Thermal margin must be at least 10 C.", operator: "gte", threshold: 10 }]
    });
    const simResult = computeOptimizationResult(simProblem, simMetrics);
    assert.deepEqual(simResult.infeasibleCandidateIds, ["cand_sim_a"], "candidate A fails the thermal margin constraint");
    assert.deepEqual(simResult.paretoOptimalCandidateIds, ["cand_sim_b"], "candidate B is the only feasible candidate");

    // Both results are independently persistable and never cross-reference
    // each other's project/candidates.
    const resultStore = createOptimizationResultStore();
    resultStore.save(cadResult);
    resultStore.save(simResult);
    assert.equal(resultStore.getById(cadResult.id)!.paretoOptimalCandidateIds[0], "cand_cad_b");
    assert.equal(resultStore.getById(simResult.id)!.paretoOptimalCandidateIds[0], "cand_sim_b");
  });
});

describe("P26: P25 background jobs execute against a non-CAD (simulation) environment using the same runBackgroundJob machinery", () => {
  it("a bounded job modifies an EXISTING sensor's parameters across two candidates, never calling create_environment_object", async () => {
    const objects = createMockSimulationEnvironment();
    const connectResult = await objects.connect();
    const session = connectResult.data as EnvironmentSession;
    const listed = await objects.listObjects(session);
    const sensor = (listed.data as { id: string; type: string }[]).find((object) => object.type === "sensor")!;

    let state: WorldModelState = createWorldModelState({ project: { id: "proj_sim_job", name: "Simulation Job" }, session: {} });
    const getState = () => state;
    const setState = (next: WorldModelState) => {
      state = next;
    };

    const history = createChangeHistory();
    const checkpointStore = createCheckpointStore();
    const artifactStore = createArtifactStore();
    const buildResultStore = createBuildResultStore();
    const candidateStore = createCandidateStore();
    const designSpecificationStore = createDesignSpecificationStore();
    const jobStore = createBackgroundJobStore();
    const eventStore = createJobEventStore();
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    autonomyGrants.create({
      toolNames: ["add_experiment", "update_experiment", "modify_environment_object"],
      targetType: null,
      targetId: null,
      reason: "test",
      grantedBy: "human"
    });

    const registry = createToolRegistry();
    const envTool = createCreateEnvironmentObjectTool(() => session, objects);
    registry.register(envTool.tool, envTool.handler);
    const modifyTool = createModifyEnvironmentObjectTool(() => session, objects);
    registry.register(modifyTool.tool, modifyTool.handler);
    const checkpointTool = createCreateCheckpointTool(getState, history, () => session, objects, checkpointStore, artifactStore);
    registry.register(checkpointTool.tool, checkpointTool.handler);
    const restoreTool = createRestoreCheckpointTool(getState, setState, history, () => session, objects, checkpointStore, artifactStore);
    registry.register(restoreTool.tool, restoreTool.handler);
    const addExperimentTool = createAddExperimentTool(getState, setState, history);
    registry.register(addExperimentTool.tool, addExperimentTool.handler);
    const updateExperimentTool = createUpdateExperimentTool(getState, setState, history);
    registry.register(updateExperimentTool.tool, updateExperimentTool.handler);

    const candidates: Candidate[] = [];
    for (const setpoint of [520, 580]) {
      const design = createDesignSpecification({
        projectId: state.project.id,
        projectVersion: state.project.version,
        planId: "plan_sim",
        planStepId: "step_sim",
        objectiveSummary: "Calibrate load sensor setpoint.",
        description: `Set setpointN to ${setpoint}.`,
        components: [{ id: "comp_sensor", name: "Load Sensor 1", type: "sensor", geometryIntent: "n/a" }],
        expectedOutputs: [
          { id: `out_${setpoint}`, componentId: "comp_sensor", environmentObjectType: "sensor", environmentGenericType: null, properties: { setpointN: setpoint }, targetObjectId: sensor.id }
        ]
      });
      designSpecificationStore.save(design);
      const candidate = createCandidate({
        projectId: state.project.id,
        projectVersion: state.project.version,
        planId: "plan_sim",
        planStepId: "step_sim",
        designSpecificationId: design.id,
        hypothesis: `Setpoint ${setpoint} N.`,
        rationale: "Simulation parameter sweep."
      });
      candidateStore.save(candidate);
      candidates.push(candidate);
    }

    const job = createBackgroundJob({
      projectId: state.project.id,
      projectVersion: state.project.version,
      objective: "Sweep load sensor setpoint across two calibration candidates.",
      candidateIds: candidates.map((c) => c.id),
      autonomyLevel: "autonomous",
      allowedTools: ["create_checkpoint", "add_experiment", "update_experiment", "modify_environment_object"],
      budget: { maxIterations: 10, maxDurationMs: 60000, maxToolCalls: 100, maxModelCalls: 10, maxCandidates: 10 }
    });
    jobStore.save(job);

    const result = await runBackgroundJob({
      registry,
      jobStore,
      eventStore,
      candidateStore,
      designSpecificationStore,
      buildResultStore,
      approvals,
      autonomyGrants,
      jobId: job.id
    });

    assert.equal(result.status, "completed");
    assert.equal(result.result!.stopReason, "completed");
    assert.equal(result.result!.candidateResults.length, 2);
    assert.ok(result.result!.candidateResults.every((entry) => entry.outcome === "evaluated"), "both simulation candidates must build (modify) successfully");

    // The environment's topology never grew -- no create_environment_object
    // call was ever made or even authorized for this job.
    const finalListed = await objects.listObjects(session);
    assert.equal((finalListed.data as unknown[]).length, 2, "still exactly the two originally seeded objects (sensor + actuator) -- nothing was created");
    await objects.disconnect(session);
  });
});
