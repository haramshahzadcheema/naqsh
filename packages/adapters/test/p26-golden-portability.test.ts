import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createCandidate,
  createCheck,
  createDesignSpecification,
  createEvidence,
  createMemoryRecord,
  createPlan,
  createProposal,
  createWorldModelState,
  type BuildStatus,
  type EnvironmentObject,
  type EnvironmentSession,
  type ExpectedBuildOutputInput,
  type VerificationResult,
  type WorldModelState
} from "@naqsh/schemas";
import {
  evaluateCheck,
  evaluateObjectiveSatisfaction,
  executeExperimentForCandidate,
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
  createBuildResultStore,
  createApprovalStore,
  createAutonomyGrantStore,
  createExecuteToolAuthorizer,
  createMemoryStore,
  createVerificationResultStore,
  updateWorldModel,
  type EnvironmentAdapter
} from "@naqsh/core";
import { createMockCadEnvironment } from "../src/mock-cad-environment.js";
import { createMockSimulationEnvironment } from "../src/mock-simulation-environment.js";

/**
 * PHASE 26's GOLDEN PORTABILITY TEST: one workflow implementation
 * (`runGoldenWorkflow`, below), called TWICE with different environment
 * configuration -- once against a CAD-like environment, once against a
 * simulation-like one -- proving the statement the P26 brief opens with:
 * "The Naqsh agent operates on an abstract engineering environment through
 * a stable EnvironmentAdapter boundary." The workflow itself contains NOT
 * ONE conditional on environment kind; every environment-specific fact
 * (which adapter, whether the build creates or modifies, which property to
 * verify, what threshold) arrives as EXTERNAL configuration, exactly like
 * the P26 brief's own "environment should be injected/configured
 * externally" requirement for the agent loop, generalized here to the full
 * engineering workflow:
 *
 *   create project -> define objective -> create requirement -> generate
 *   plan -> create proposal -> obtain approval -> execute through
 *   EnvironmentAdapter -> verify result -> evaluate objective satisfaction
 *   -> record experiment -> store meaningful memory
 *
 * Every step calls REAL, unmodified P1/P4/P9/P10/P15/P16/P17/P22/P24
 * machinery -- nothing here is a stand-in or a simplified re-implementation.
 * `executeExperimentForCandidate` (P22) is the one function that actually
 * touches the environment, and it is called completely unmodified for
 * both runs.
 */

interface GoldenWorkflowConfig {
  environmentKind: string;
  createAdapter: () => EnvironmentAdapter;
  objectiveSummary: string;
  requirementDescription: string;
  /** Given the environment's OWN seeded topology (discovered via
   * listObjects right after connecting -- empty for a create-flavored
   * environment, pre-populated for a fixed-topology one), returns the
   * single ExpectedBuildOutput this workflow will realize. Mirrors
   * `build-operations.ts`'s own `targetObjectId` branch -- `null` means
   * "create a new object" (CAD), a real id means "modify this existing
   * one" (simulation). */
  buildOutput: (seededObjects: EnvironmentObject[]) => ExpectedBuildOutputInput;
  /** Which property on the built/modified object to verify, and the bound
   * that constitutes "objective satisfied." */
  verify: { property: string; max: number; unit: string };
}

interface GoldenWorkflowResult {
  environmentKind: string;
  buildStatus: BuildStatus;
  verificationStatus: VerificationResult["status"];
  objectiveSatisfied: boolean;
  experimentStatus: string;
  memoryRecordId: string;
  finalState: WorldModelState;
}

function comparableObservedValue(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "object" && value !== null && "value" in value && typeof (value as { value: unknown }).value === "number") {
    return (value as { value: number }).value;
  }
  throw new Error(`expected a numeric (or {value, unit}-shaped) property value, got ${JSON.stringify(value)}`);
}

async function runGoldenWorkflow(config: GoldenWorkflowConfig): Promise<GoldenWorkflowResult> {
  // ---- Create project ----
  let state: WorldModelState = createWorldModelState({
    project: { id: "proj_golden", name: `Golden Workflow (${config.environmentKind})` },
    session: {}
  });

  // ---- Define objective / create requirement (P1) ----
  state = updateWorldModel(state, {
    kind: "add_requirement",
    requirement: { description: config.requirementDescription, category: "engineering", priority: "high" }
  });
  const requirement = state.project.requirements[0]!;

  // ---- Generate plan (P9) -- hand-constructed, matching this repo's own
  // established "the generator's OWN correctness is P9's concern, this
  // test's concern is downstream portability" precedent. ----
  const plan = createPlan({
    projectId: state.project.id,
    projectVersion: state.project.version,
    observationId: "obs_golden",
    objectiveSummary: config.objectiveSummary,
    steps: [{ title: "Realize the design", description: config.objectiveSummary, purpose: "engineering", relevantRequirementIds: [requirement.id] }]
  });
  const planStep = plan.steps[0]!;

  // ---- Create proposal (P10) ----
  const proposal = createProposal({
    projectId: state.project.id,
    projectVersion: state.project.version,
    planId: plan.id,
    planStepId: planStep.id,
    objectiveSummary: config.objectiveSummary,
    toolName: "create_environment_object",
    toolTarget: "environment",
    rationale: `Realize "${config.objectiveSummary}" against the ${config.environmentKind} environment.`,
    expectedEffect: `The environment satisfies: ${config.verify.property} <= ${config.verify.max} ${config.verify.unit}.`,
    relevantRequirementIds: [requirement.id]
  });

  // ---- Obtain approval (P4) ----
  const approvals = createApprovalStore();
  const autonomyGrants = createAutonomyGrantStore();
  const approval = approvals.create({
    toolName: proposal.toolName,
    targetType: "object",
    targetId: null,
    requestedBy: "agent",
    reason: proposal.rationale
  });
  approvals.approve(approval.id, "human", "Golden workflow approval.");
  // The specific build/checkpoint/experiment tool calls below are gated by
  // the SAME real P4 authorizer, at a level that consults these grants --
  // never a second, informal permission check.
  autonomyGrants.create({
    toolNames: ["create_checkpoint", "add_experiment", "update_experiment", "create_environment_object", "modify_environment_object"],
    targetType: null,
    targetId: null,
    reason: "Golden workflow: authorize the bounded execution below.",
    grantedBy: "human"
  });
  const authorize = createExecuteToolAuthorizer({ autonomyLevel: "autonomous", approvals, autonomyGrants });

  // ---- Wire the tool registry against THIS environment's adapter --
  // identical wiring code for every environment; only `config.createAdapter`
  // differs. ----
  const adapter = config.createAdapter();
  const connectResult = await adapter.connect();
  assert.equal(connectResult.status, "success", `failed to connect to ${config.environmentKind}`);
  const session = connectResult.data as EnvironmentSession;
  const getSession = () => session;

  const history = createChangeHistory();
  const checkpointStore = createCheckpointStore();
  const artifactStore = createArtifactStore();
  const buildResultStore = createBuildResultStore();
  const verificationResultStore = createVerificationResultStore();
  const registry = createToolRegistry();

  const envTool = createCreateEnvironmentObjectTool(getSession, adapter);
  registry.register(envTool.tool, envTool.handler);
  const modifyTool = createModifyEnvironmentObjectTool(getSession, adapter);
  registry.register(modifyTool.tool, modifyTool.handler);
  const checkpointTool = createCreateCheckpointTool(() => state, history, getSession, adapter, checkpointStore, artifactStore);
  registry.register(checkpointTool.tool, checkpointTool.handler);
  const restoreTool = createRestoreCheckpointTool(
    () => state,
    (next) => {
      state = next;
    },
    history,
    getSession,
    adapter,
    checkpointStore,
    artifactStore
  );
  registry.register(restoreTool.tool, restoreTool.handler);
  const addExperimentTool = createAddExperimentTool(
    () => state,
    (next) => {
      state = next;
    },
    history
  );
  registry.register(addExperimentTool.tool, addExperimentTool.handler);
  const updateExperimentTool = createUpdateExperimentTool(
    () => state,
    (next) => {
      state = next;
    },
    history
  );
  registry.register(updateExperimentTool.tool, updateExperimentTool.handler);

  // ---- Discover the environment's current topology (empty for a
  // create-flavored environment; seeded objects for a modify-flavored
  // one) -- config decides what to DO with it, this function just reports
  // it. ----
  const listed = await adapter.listObjects(session);
  const seededObjects = (listed.data as EnvironmentObject[] | undefined) ?? [];

  const expectedOutput = config.buildOutput(seededObjects);
  const design = createDesignSpecification({
    projectId: state.project.id,
    projectVersion: state.project.version,
    planId: plan.id,
    planStepId: planStep.id,
    objectiveSummary: config.objectiveSummary,
    description: config.objectiveSummary,
    components: [{ id: "comp_target", name: "Target", type: "generic", geometryIntent: config.objectiveSummary }],
    expectedOutputs: [{ ...expectedOutput, componentId: "comp_target" }]
  });
  const candidate = createCandidate({
    projectId: state.project.id,
    projectVersion: state.project.version,
    planId: plan.id,
    planStepId: planStep.id,
    designSpecificationId: design.id,
    hypothesis: config.objectiveSummary,
    rationale: proposal.rationale
  });

  // ---- Execute through EnvironmentAdapter (P22, completely unmodified --
  // the ONE function in this whole workflow that actually touches the
  // environment). ----
  const { experiment, buildResult } = await executeExperimentForCandidate(registry, candidate, design, buildResultStore, {
    source: "agent",
    authorize
  });

  // ---- Verify result (P16) -- against whichever object the build
  // actually produced (create path) or was told to target (modify path). ----
  const createdObject = buildResult.operations[0]?.output as { object?: EnvironmentObject } | undefined;
  const resolvedObjectId = expectedOutput.targetObjectId ?? createdObject?.object?.id;
  assert.ok(resolvedObjectId, "the build must resolve to a real object id, either created or targeted");

  const inspected = await adapter.inspectObject(session, resolvedObjectId);
  assert.equal(inspected.status, "success", `expected to inspect the built/modified object in ${config.environmentKind}`);
  const inspectedObject = inspected.data as EnvironmentObject;
  const property = inspectedObject.properties.find((p) => p.key === config.verify.property);
  assert.ok(property, `expected property "${config.verify.property}" on the built/modified object`);
  const observedValue = comparableObservedValue(property.value);

  const check = createCheck({
    kind: "bounds_check",
    description: `${config.verify.property} must be at most ${config.verify.max} ${config.verify.unit}.`,
    objectId: resolvedObjectId,
    property: config.verify.property,
    min: null,
    max: config.verify.max,
    unit: config.verify.unit
  });
  const evidence = createEvidence({
    objectId: resolvedObjectId,
    objectExists: true,
    property: config.verify.property,
    propertyExists: true,
    observedValue,
    unit: config.verify.unit,
    stateVersion: state.project.version,
    source: "system"
  });
  const verificationResult = evaluateCheck(check, evidence, { projectId: state.project.id, projectVersion: state.project.version });
  verificationResultStore.save(verificationResult);

  // ---- Evaluate objective satisfaction (P17) -- structurally separate
  // from "the build succeeded." ----
  const satisfaction = evaluateObjectiveSatisfaction([{ checkId: check.id, requirementId: requirement.id, constraintId: null, required: true, verificationResult }], {
    projectId: state.project.id,
    projectVersion: state.project.version,
    objectiveSummary: config.objectiveSummary
  });

  // ---- Record experiment (already done by executeExperimentForCandidate;
  // confirm it is genuinely reachable via live World Model state). ----
  const recordedExperiment = state.project.experiments.find((entry) => entry.id === experiment.id);
  assert.ok(recordedExperiment, "the experiment must be reachable via live WorldModelState after execution");

  // ---- Store meaningful memory (P24) -- provenance explicitly names
  // WHICH environment this finding came from (P26 brief section 22), never
  // defaulting to an assumed environment. ----
  const memoryStore = createMemoryStore();
  const memory = createMemoryRecord({
    projectId: state.project.id,
    projectVersion: state.project.version,
    kind: satisfaction.status === "satisfied" ? "success" : "failure",
    title: `${config.objectiveSummary} (${config.environmentKind})`,
    content: `Environment "${config.environmentKind}" (${adapter.describe().name}): build ${buildResult.status}, verification ${verificationResult.status}, objective satisfaction ${satisfaction.status}.`,
    provenanceKind: "verification_result",
    references: { verificationResultIds: [verificationResult.id], experimentIds: [experiment.id], requirementIds: [requirement.id] },
    metadata: { environmentKind: config.environmentKind, environmentName: adapter.describe().name }
  });
  memoryStore.save(memory);

  await adapter.disconnect(session);

  return {
    environmentKind: config.environmentKind,
    buildStatus: buildResult.status,
    verificationStatus: verificationResult.status,
    objectiveSatisfied: satisfaction.status === "satisfied",
    experimentStatus: recordedExperiment!.status,
    memoryRecordId: memory.id,
    finalState: state
  };
}

describe("P26 golden portability workflow: the SAME implementation runs against two fundamentally different environments", () => {
  it("CAD: creates a new part, verifies mass, and confirms the objective is satisfied", async () => {
    const result = await runGoldenWorkflow({
      environmentKind: "mock_cad",
      createAdapter: createMockCadEnvironment,
      objectiveSummary: "Minimize mass while keeping the bracket under 400 g.",
      requirementDescription: "Bracket mass must be at most 400 g.",
      buildOutput: () => ({ id: "out_bracket", componentId: "comp_target", environmentObjectType: "part", environmentGenericType: "solid", properties: { massG: 320 } }),
      verify: { property: "massG", max: 400, unit: "g" }
    });

    assert.equal(result.buildStatus, "completed");
    assert.equal(result.verificationStatus, "pass");
    assert.equal(result.objectiveSatisfied, true);
    assert.equal(result.experimentStatus, "complete");
    assert.ok(result.memoryRecordId);
  });

  it("SIMULATION: modifies an EXISTING sensor's setpoint (never creates anything), verifies it, and confirms the objective is satisfied -- using the IDENTICAL workflow implementation", async () => {
    const result = await runGoldenWorkflow({
      environmentKind: "mock_simulation",
      createAdapter: createMockSimulationEnvironment,
      objectiveSummary: "Calibrate the load sensor setpoint to at most 600 N.",
      requirementDescription: "Load sensor setpoint must be at most 600 N.",
      buildOutput: (seeded) => {
        const sensor = seeded.find((object) => object.type === "sensor")!;
        return { id: "out_sensor", componentId: "comp_target", environmentObjectType: "sensor", environmentGenericType: null, properties: { setpointN: 550 }, targetObjectId: sensor.id };
      },
      verify: { property: "setpointN", max: 600, unit: "N" }
    });

    assert.equal(result.buildStatus, "completed");
    assert.equal(result.verificationStatus, "pass");
    assert.equal(result.objectiveSatisfied, true);
    assert.equal(result.experimentStatus, "complete");
    assert.ok(result.memoryRecordId);
  });

  it("proves genuine portability: both runs used the SAME runGoldenWorkflow function body, only configuration differed, and each correctly reports ITS OWN environment provenance", async () => {
    const cadResult = await runGoldenWorkflow({
      environmentKind: "mock_cad",
      createAdapter: createMockCadEnvironment,
      objectiveSummary: "Minimize mass.",
      requirementDescription: "Mass must be at most 500 g.",
      buildOutput: () => ({ id: "out_bracket", componentId: "comp_target", environmentObjectType: "part", environmentGenericType: "solid", properties: { massG: 450 } }),
      verify: { property: "massG", max: 500, unit: "g" }
    });
    const simResult = await runGoldenWorkflow({
      environmentKind: "mock_simulation",
      createAdapter: createMockSimulationEnvironment,
      objectiveSummary: "Calibrate setpoint.",
      requirementDescription: "Setpoint must be at most 700 N.",
      buildOutput: (seeded) => {
        const sensor = seeded.find((object) => object.type === "sensor")!;
        return { id: "out_sensor", componentId: "comp_target", environmentObjectType: "sensor", environmentGenericType: null, properties: { setpointN: 650 }, targetObjectId: sensor.id };
      },
      verify: { property: "setpointN", max: 700, unit: "N" }
    });

    assert.notEqual(cadResult.environmentKind, simResult.environmentKind);
    assert.equal(cadResult.objectiveSatisfied, true);
    assert.equal(simResult.objectiveSatisfied, true);
    // Each project's WorldModelState only ever recorded ITS OWN experiment.
    assert.equal(cadResult.finalState.project.experiments.length, 1);
    assert.equal(simResult.finalState.project.experiments.length, 1);
  });
});
