import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createCandidate,
  createDesignSpecification,
  createWorldModelState,
  ToolError,
  UNAVAILABLE_ENVIRONMENT_GEOMETRY,
  type CandidateInput,
  type DesignSpecification,
  type DesignSpecificationInput,
  type EnvironmentObject,
  type EnvironmentOperationResult,
  type EnvironmentSession,
  type WorldModelState
} from "@naqsh/schemas";
import { executeExperimentForCandidate } from "../src/experiment-executor.js";
import { createCreateEnvironmentObjectTool } from "../src/create-environment-object-tool.js";
import { createCreateCheckpointTool } from "../src/create-checkpoint-tool.js";
import { createRestoreCheckpointTool } from "../src/restore-checkpoint-tool.js";
import { createAddExperimentTool } from "../src/add-experiment-tool.js";
import { createUpdateExperimentTool } from "../src/update-experiment-tool.js";
import { createArtifactStore } from "../src/artifact-store.js";
import { createCheckpointStore } from "../src/checkpoint-store.js";
import { createChangeHistory } from "../src/change-history.js";
import { createBuildResultStore } from "../src/build-result-store.js";
import { createToolRegistry } from "../src/tool-registry.js";
import { executeTool } from "../src/execute-tool.js";
import { createApprovalStore } from "../src/approval-store.js";
import { createAutonomyGrantStore } from "../src/autonomy-grant-store.js";
import { createExecuteToolAuthorizer } from "../src/authorization.js";
import type { EnvironmentAdapter } from "../src/environment-adapter.js";

/** Combines build-executor.test.ts's createObject fake with
 * restore-checkpoint-tool.test.ts's checkpoint/restore fake -- a candidate's
 * experiment needs BOTH: it must be able to actually build (create real
 * environment objects) AND be checkpointed/restored around, which no single
 * existing test fixture in this repo already does together. */
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

function buildHarness(adapterOptions: { failOnCreateCallNumber?: number } = {}) {
  const objects = new Map<string, EnvironmentObject>();
  const { adapter, session } = buildFakeAdapter(objects, adapterOptions);
  let state: WorldModelState = createWorldModelState({ project: { id: "proj_1", name: "Bracket Study" }, session: {} });
  let connectedSession: EnvironmentSession | null = session;
  const history = createChangeHistory();
  const checkpointStore = createCheckpointStore();
  const artifactStore = createArtifactStore();
  const buildResultStore = createBuildResultStore();
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

  return {
    registry,
    history,
    buildResultStore,
    getObjects: () => objects,
    getState,
    setState,
    disconnect: () => {
      connectedSession = null;
    }
  };
}

describe("executeExperimentForCandidate: happy path", () => {
  it("captures a before-checkpoint, records a running-then-complete Experiment, and builds the design", async () => {
    const harness = buildHarness();
    const design = createDesignSpecification(designInput());
    const candidate = createCandidate(candidateInput(design));

    const { experiment, buildResult, checkpointBefore } = await executeExperimentForCandidate(harness.registry, candidate, design, harness.buildResultStore);

    assert.equal(experiment.candidateId, candidate.id);
    assert.equal(experiment.checkpointBeforeId, checkpointBefore.id);
    assert.equal(experiment.buildResultId, buildResult.id);
    assert.equal(experiment.status, "complete");
    assert.equal(buildResult.status, "completed");
    assert.equal(harness.getObjects().size, 1);
    assert.deepEqual(harness.getState().project.experiments.find((entry) => entry.id === experiment.id), experiment);
  });

  it("records a failed Experiment when the build fails, without throwing", async () => {
    const harness = buildHarness({ failOnCreateCallNumber: 1 });
    const design = createDesignSpecification(designInput());
    const candidate = createCandidate(candidateInput(design));

    const { experiment, buildResult } = await executeExperimentForCandidate(harness.registry, candidate, design, harness.buildResultStore);

    assert.equal(experiment.status, "failed");
    assert.equal(buildResult.status, "failed");
    assert.equal(experiment.buildResultId, buildResult.id);
  });
});

describe("executeExperimentForCandidate: guards", () => {
  it("rejects a candidate whose designSpecificationId does not match the supplied design", async () => {
    const harness = buildHarness();
    const design = createDesignSpecification(designInput());
    const otherDesign = createDesignSpecification(designInput());
    const candidate = createCandidate(candidateInput(design, { designSpecificationId: otherDesign.id }));

    await assert.rejects(
      () => executeExperimentForCandidate(harness.registry, candidate, design, harness.buildResultStore),
      (error: unknown) => error instanceof ToolError && error.kind === "invalid_input" && /candidate_design_mismatch/.test(error.message)
    );
  });

  it("throws and records NO experiment when the before-checkpoint cannot be captured", async () => {
    const harness = buildHarness();
    const design = createDesignSpecification(designInput());
    const candidate = createCandidate(candidateInput(design));
    const authorize = () => ({ allowed: false, reason: "denied for test" });

    await assert.rejects(() => executeExperimentForCandidate(harness.registry, candidate, design, harness.buildResultStore, { authorize }));
    assert.equal(harness.getState().project.experiments.length, 0);
  });
});

describe("executeExperimentForCandidate: respects real P4 authorization for EVERY World-Model-touching step, not just the build", () => {
  it("AUDIT FIX REGRESSION: add_experiment itself now requires real authorization -- with no approval/grant at all, the whole call throws BEFORE any build is attempted (it used to silently skip authorization for this write)", async () => {
    const harness = buildHarness();
    const design = createDesignSpecification(designInput());
    const candidate = createCandidate(candidateInput(design));
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    // No grants/approvals for ANYTHING -- create_checkpoint (suggest tier)
    // still succeeds under "approved_modify" autonomy, but add_experiment
    // (mutate tier) has no covering approval/grant at all.
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "approved_modify", approvals, autonomyGrants });

    await assert.rejects(
      () => executeExperimentForCandidate(harness.registry, candidate, design, harness.buildResultStore, { authorize }),
      (error: unknown) => error instanceof ToolError && /add_experiment_failed/.test(error.message)
    );
    assert.equal(harness.getState().project.experiments.length, 0, "no experiment is recorded when add_experiment itself is denied");
    assert.equal(harness.getObjects().size, 0, "the build never even starts when add_experiment is denied");
  });

  it("an unauthorized build still records a failed (not thrown) Experiment, once add_experiment/update_experiment are themselves granted", async () => {
    const harness = buildHarness();
    const design = createDesignSpecification(designInput());
    const candidate = createCandidate(candidateInput(design));
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    // Grant everything the experiment lifecycle itself needs (checkpoint,
    // add/update experiment) but deliberately withhold create_environment_object
    // -- isolating the build's own authorization gate exactly like before.
    // AutonomyGrant is only consulted at autonomyLevel "autonomous" (Approval
    // is what "approved_modify" checks instead -- see authorization.ts's own
    // evaluateToolAuthorization branch), matching build-executor.test.ts's
    // identical "succeeds when every operation is approved" precedent.
    autonomyGrants.create({ toolNames: ["create_checkpoint", "add_experiment", "update_experiment"], targetType: null, targetId: null, reason: "test", grantedBy: "human" });
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "autonomous", approvals, autonomyGrants });

    const { experiment, buildResult } = await executeExperimentForCandidate(harness.registry, candidate, design, harness.buildResultStore, { authorize });

    assert.equal(experiment.status, "failed");
    assert.equal(buildResult.status, "failed");
    assert.equal(harness.getObjects().size, 0);
  });

  it("succeeds end-to-end when every step of the experiment lifecycle is granted", async () => {
    const harness = buildHarness();
    const design = createDesignSpecification(designInput());
    const candidate = createCandidate(candidateInput(design));
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    autonomyGrants.create({
      toolNames: ["create_checkpoint", "add_experiment", "update_experiment", "create_environment_object"],
      targetType: null,
      targetId: null,
      reason: "test",
      grantedBy: "human"
    });
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "autonomous", approvals, autonomyGrants });

    const { experiment, buildResult } = await executeExperimentForCandidate(harness.registry, candidate, design, harness.buildResultStore, { authorize });

    assert.equal(experiment.status, "complete");
    assert.equal(buildResult.status, "completed");
    assert.equal(harness.getObjects().size, 1);
  });
});

describe("executeExperimentForCandidate: ISOLATION (P22's central requirement)", () => {
  it("Candidate A mutates the environment, fails verification, is restored to baseline -- Candidate B never inherits A's state", async () => {
    const harness = buildHarness();

    // Candidate A: builds successfully, leaving a real object behind.
    const designA = createDesignSpecification(designInput({ description: "Candidate A: a solid plate." }));
    const candidateA = createCandidate(candidateInput(designA, { hypothesis: "A solid plate is simplest." }));
    const { experiment: experimentA, checkpointBefore: checkpointBeforeA } = await executeExperimentForCandidate(harness.registry, candidateA, designA, harness.buildResultStore);
    assert.equal(experimentA.status, "complete");
    assert.equal(harness.getObjects().size, 1, "candidate A really did mutate the environment");
    const candidateAObjectId = [...harness.getObjects().keys()][0];

    // Explicit, caller-driven restore back to the pre-A baseline -- exactly
    // the separate step this file's own doc comment says it does NOT do
    // automatically.
    const { result: restoreResult } = await executeTool(harness.registry, {
      toolName: "restore_checkpoint",
      input: { checkpointId: checkpointBeforeA.id }
    });
    assert.equal(restoreResult.status, "success");
    assert.equal(harness.getObjects().size, 0, "restoring to the pre-A checkpoint must undo A's mutation entirely");

    // Candidate B: a DIFFERENT design, run from the restored baseline.
    const designB = createDesignSpecification(designInput({ description: "Candidate B: a ribbed plate." }));
    const candidateB = createCandidate(candidateInput(designB, { hypothesis: "A ribbed plate is lighter." }));
    const { experiment: experimentB } = await executeExperimentForCandidate(harness.registry, candidateB, designB, harness.buildResultStore);

    assert.equal(experimentB.status, "complete");
    assert.equal(harness.getObjects().size, 1, "candidate B's own build produced exactly one object");
    const candidateBObjectId = [...harness.getObjects().keys()][0];
    assert.notEqual(candidateBObjectId, candidateAObjectId, "candidate B's environment must NOT contain candidate A's object -- no cross-candidate leakage");

    // Candidate A's Experiment is no longer part of the CURRENT live
    // Project.experiments -- restoring a checkpoint taken BEFORE it existed
    // correctly reverts the whole World Model, not just the environment
    // (unmodified P15 "git revert" semantics: the World Model and the
    // environment are restored together, atomically, by the same
    // Checkpoint). This is NOT the same as being silently deleted: the
    // append-only ChangeHistory (never rewritten, only ever appended to,
    // even by restore_checkpoint itself) still records that candidate A's
    // experiment was created, ran, failed, and was later reverted -- the
    // full audit trail survives even though it fell out of live state.
    assert.ok(
      !harness.getState().project.experiments.some((entry) => entry.id === experimentA.id),
      "restoring to a pre-experimentA checkpoint correctly reverts the World Model too, not only the environment"
    );
    assert.ok(harness.getState().project.experiments.some((entry) => entry.id === experimentB.id));

    const historyEntityIds = harness.history.list().map((change) => change.target.entityId);
    assert.ok(historyEntityIds.includes(experimentA.id), "candidate A's experiment remains permanently auditable in ChangeHistory, even after being reverted out of live state");
    assert.ok(historyEntityIds.includes(experimentB.id));
  });

  it("Candidate A succeeds, restore, Candidate B ALSO succeeds -- isolation holds on the success/success path too, not only success/failure", async () => {
    const harness = buildHarness();
    const designA = createDesignSpecification(designInput({ description: "A" }));
    const candidateA = createCandidate(candidateInput(designA));
    const { checkpointBefore } = await executeExperimentForCandidate(harness.registry, candidateA, designA, harness.buildResultStore);
    const objectIdAfterA = [...harness.getObjects().keys()][0];

    await executeTool(harness.registry, { toolName: "restore_checkpoint", input: { checkpointId: checkpointBefore.id } });
    assert.equal(harness.getObjects().size, 0);

    const designB = createDesignSpecification(designInput({ description: "B" }));
    const candidateB = createCandidate(candidateInput(designB));
    const { experiment: experimentB } = await executeExperimentForCandidate(harness.registry, candidateB, designB, harness.buildResultStore);
    assert.equal(experimentB.status, "complete");
    assert.equal(harness.getObjects().size, 1);
    assert.notEqual([...harness.getObjects().keys()][0], objectIdAfterA);
  });

  it("a restore FAILURE (unknown checkpoint id) is reported as an error, never a silent no-op that leaves the caller thinking isolation succeeded", async () => {
    const harness = buildHarness();
    const { result } = await executeTool(harness.registry, { toolName: "restore_checkpoint", input: { checkpointId: "chkpt_does_not_exist" } });
    assert.equal(result.status, "error");
  });

  it("three sequential candidates (A fails, B succeeds, C succeeds) each start from a clean restored baseline in turn", async () => {
    const harness = buildHarness({ failOnCreateCallNumber: 1 });
    const designA = createDesignSpecification(designInput({ description: "A: forced failure" }));
    const candidateA = createCandidate(candidateInput(designA));
    const { experiment: experimentA, checkpointBefore: checkpointBeforeA } = await executeExperimentForCandidate(harness.registry, candidateA, designA, harness.buildResultStore);
    assert.equal(experimentA.status, "failed");
    await executeTool(harness.registry, { toolName: "restore_checkpoint", input: { checkpointId: checkpointBeforeA.id } });
    assert.equal(harness.getObjects().size, 0);

    const designB = createDesignSpecification(designInput({ description: "B" }));
    const candidateB = createCandidate(candidateInput(designB));
    const { experiment: experimentB, checkpointBefore: checkpointBeforeB } = await executeExperimentForCandidate(harness.registry, candidateB, designB, harness.buildResultStore);
    assert.equal(experimentB.status, "complete");
    assert.equal(harness.getObjects().size, 1);
    await executeTool(harness.registry, { toolName: "restore_checkpoint", input: { checkpointId: checkpointBeforeB.id } });
    assert.equal(harness.getObjects().size, 0);

    const designC = createDesignSpecification(designInput({ description: "C" }));
    const candidateC = createCandidate(candidateInput(designC));
    const { experiment: experimentC } = await executeExperimentForCandidate(harness.registry, candidateC, designC, harness.buildResultStore);
    assert.equal(experimentC.status, "complete");
    assert.equal(harness.getObjects().size, 1, "candidate C's environment holds exactly its own single object, not an accumulation from A/B");
  });
});
