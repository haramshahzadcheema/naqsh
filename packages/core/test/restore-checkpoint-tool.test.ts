import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createWorldModelState,
  type Change,
  type Checkpoint,
  type EnvironmentDocumentInspection,
  type EnvironmentObject,
  type EnvironmentOperationResult,
  type EnvironmentSession,
  type WorldModelState
} from "@naqsh/schemas";
import { createCreateCheckpointTool } from "../src/create-checkpoint-tool.js";
import { createRestoreCheckpointTool } from "../src/restore-checkpoint-tool.js";
import { createArtifactStore } from "../src/artifact-store.js";
import { createCheckpointStore } from "../src/checkpoint-store.js";
import { createChangeHistory } from "../src/change-history.js";
import { recordTransition } from "../src/record-transition.js";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry } from "../src/tool-registry.js";
import { createApprovalStore } from "../src/approval-store.js";
import { createAutonomyGrantStore } from "../src/autonomy-grant-store.js";
import { createExecuteToolAuthorizer } from "../src/authorization.js";
import type { EnvironmentAdapter } from "../src/environment-adapter.js";

/** Same shape/discipline as create-checkpoint-tool.test.ts's own fake --
 * real checkpoint/restore/inspectDocument semantics, plus fault injection
 * for restore-specific failure paths. */
function buildFakeAdapter(
  objects: Map<string, EnvironmentObject>,
  options: { environmentKind?: string; documentName?: string } = {}
) {
  const now = () => new Date().toISOString();
  const session: EnvironmentSession = {
    id: "sess_1",
    environmentKind: options.environmentKind ?? "fake",
    status: "connected",
    documentName: options.documentName ?? "fake.doc",
    openedAt: now(),
    metadata: {}
  };
  const checkpoints = new Map<string, Map<string, EnvironmentObject>>();
  const faults = { failCheckpoint: false, failInspect: false, failRestore: false, corruptRestore: false };
  const capabilities = new Set(["modify", "checkpoint"]);

  function ok(operation: EnvironmentOperationResult["operation"], data: unknown): EnvironmentOperationResult {
    return { id: `envop_${Math.random()}`, operation, sessionId: session.id, objectId: null, status: "success", data, error: null, startedAt: now(), completedAt: now(), metadata: {} };
  }
  function err(operation: EnvironmentOperationResult["operation"], kind: "unsupported_capability" | "environment_failure" | "object_not_found", message: string): EnvironmentOperationResult {
    return { id: `envop_${Math.random()}`, operation, sessionId: session.id, objectId: null, status: "error", data: null, error: { kind, message }, startedAt: now(), completedAt: now(), metadata: {} };
  }

  const adapter: EnvironmentAdapter = {
    describe: () => ({ kind: session.environmentKind, name: "Fake Environment", version: "0.0.1", capabilities: [...capabilities] as never, metadata: {} }),
    health: async () => ok("health", { status: "healthy", message: "", checkedAt: now() }),
    connect: async () => ok("connect", session),
    disconnect: async () => ok("disconnect", null),
    listObjects: async () => ok("list_objects", [...objects.values()]),
    inspectObject: async (_session, objectId) => {
      const object = objects.get(objectId);
      return object ? ok("inspect_object", object) : err("inspect_object", "object_not_found", `No object "${objectId}"`);
    },
    inspectDocument: async () => {
      if (faults.failInspect) return err("inspect_document", "environment_failure", "simulated inspection failure");
      const inspection: EnvironmentDocumentInspection = {
        environmentKind: session.environmentKind,
        documentId: null,
        documentName: session.documentName,
        filePath: null,
        objectCount: objects.size,
        objectIds: [...objects.keys()].sort(),
        rootObjectIds: [...objects.keys()].sort(),
        inspectedAt: now(),
        environmentVersion: "0.0.1",
        warnings: [],
        unsupportedFeatures: [],
        inspectionErrors: [],
        metadata: {}
      };
      return ok("inspect_document", inspection);
    },
    createObject: async () => err("create_object", "unsupported_capability", "not supported by this fake"),
    modifyObject: async (_session, objectId, changes) => {
      const object = objects.get(objectId);
      if (!object) return err("modify_object", "object_not_found", `No object "${objectId}"`);
      const updated = { ...object, properties: object.properties.map((p) => (p.key in changes ? { ...p, value: changes[p.key] } : p)) };
      objects.set(objectId, updated);
      return ok("modify_object", updated);
    },
    deleteObject: async () => err("delete_object", "unsupported_capability", "not supported by this fake"),
    save: async () => ok("save", null),
    checkpoint: async () => {
      if (faults.failCheckpoint) return err("checkpoint", "environment_failure", "simulated checkpoint failure");
      const checkpointId = `chkpt_fake_${checkpoints.size + 1}`;
      checkpoints.set(checkpointId, new Map([...objects].map(([id, value]) => [id, { ...value }])));
      return ok("checkpoint", { checkpointId });
    },
    restore: async (_session, checkpointId) => {
      if (faults.failRestore) return err("restore", "environment_failure", "simulated restore failure");
      const snapshot = checkpoints.get(checkpointId);
      if (!snapshot) return err("restore", "object_not_found", `No checkpoint "${checkpointId}"`);
      if (faults.corruptRestore) {
        // Reports success WITHOUT actually applying the snapshot.
        return ok("restore", null);
      }
      objects.clear();
      for (const [id, value] of snapshot) objects.set(id, value);
      return ok("restore", null);
    }
  };

  return { adapter, session, faults, objects };
}

function buildState(): WorldModelState {
  return createWorldModelState({ project: { id: "proj_1", name: "Test Project" }, session: { id: "sess_wm_1" } });
}

function buildHarness(options: { environmentKind?: string; documentName?: string; connectSession?: boolean } = {}) {
  const objects = new Map<string, EnvironmentObject>([
    ["envobj_1", { id: "envobj_1", type: "bracket", name: "Bracket", genericType: "unknown", parentId: null, visible: null, geometry: { available: false, reason: "no_shape", valid: null, boundingBox: null, volume: null, surfaceArea: null, centerOfMass: null, solidCount: null, faceCount: null, edgeCount: null, vertexCount: null, shapeType: null }, properties: [{ key: "material", value: "steel", readOnly: false }], relationships: [], metadata: {} }]
  ]);
  const { adapter, session, faults } = buildFakeAdapter(objects, options);
  let state = buildState();
  const history = createChangeHistory();
  const checkpointStore = createCheckpointStore();
  const artifactStore = createArtifactStore();
  let connectedSession: EnvironmentSession | null = options.connectSession === false ? null : session;

  const registry = createToolRegistry();
  const createTool = createCreateCheckpointTool(() => state, history, () => connectedSession, adapter, checkpointStore, artifactStore);
  const restoreTool = createRestoreCheckpointTool(
    () => state,
    (next) => {
      state = next;
    },
    history,
    () => connectedSession,
    adapter,
    checkpointStore,
    artifactStore
  );
  registry.register(createTool.tool, createTool.handler);
  registry.register(restoreTool.tool, restoreTool.handler);

  return {
    registry,
    adapter,
    faults,
    checkpointStore,
    artifactStore,
    history,
    getState: () => state,
    setState: (next: WorldModelState) => {
      state = next;
    },
    disconnectSession: () => {
      connectedSession = null;
    },
    getObjects: () => objects
  };
}

async function createCheckpoint(registry: ReturnType<typeof createToolRegistry>, reason = "checkpoint"): Promise<Checkpoint> {
  const { result } = await executeTool(registry, { toolName: "create_checkpoint", input: { reason } });
  assert.equal(result.status, "success");
  return (result.output as { checkpoint: Checkpoint }).checkpoint;
}

describe("createRestoreCheckpointTool: identity and classification", () => {
  it("is classified mutate/checkpoint -- rollback is a real mutation, gated by approval", () => {
    const { registry } = buildHarness();
    const tool = registry.getByName("restore_checkpoint")!;
    assert.equal(tool.mutation, "mutate");
    assert.equal(tool.target, "checkpoint");
  });
});

describe("createRestoreCheckpointTool: successful restore", () => {
  it("restores World Model content that was changed after the checkpoint", async () => {
    const { registry, getState, setState, history } = buildHarness({ connectSession: false });
    const checkpoint = await createCheckpoint(registry, "before metadata change");

    const { state: mutated } = recordTransition(history, getState(), { kind: "set_project_metadata", metadata: { edited: true } });
    setState(mutated);
    assert.deepEqual(getState().project.metadata, { edited: true });

    const { result } = await executeTool(registry, { toolName: "restore_checkpoint", input: { checkpointId: checkpoint.id } });
    assert.equal(result.status, "success");
    assert.deepEqual(getState().project.metadata, {});
  });

  it("restores the ENVIRONMENT too when the checkpoint includes one", async () => {
    const { registry, adapter, getObjects } = buildHarness();
    const session = (await adapter.connect()).data as EnvironmentSession;
    const checkpoint = await createCheckpoint(registry, "before length change");

    await adapter.modifyObject(session, "envobj_1", { material: "aluminum" });
    assert.equal(getObjects().get("envobj_1")!.properties[0]!.value, "aluminum");

    const { result } = await executeTool(registry, { toolName: "restore_checkpoint", input: { checkpointId: checkpoint.id } });
    assert.equal(result.status, "success");
    assert.equal(getObjects().get("envobj_1")!.properties[0]!.value, "steel");
  });

  it("moves the project version FORWARD, never backward -- 'git revert' semantics, not 'git reset'", async () => {
    const { registry, getState, setState, history } = buildHarness({ connectSession: false });
    const versionAtCheckpoint = getState().project.version;
    const checkpoint = await createCheckpoint(registry);

    const { state: mutated } = recordTransition(history, getState(), { kind: "set_project_metadata", metadata: { a: 1 } });
    setState(mutated);
    const versionAfterMutation = getState().project.version;
    assert.equal(versionAfterMutation, versionAtCheckpoint + 1);

    await executeTool(registry, { toolName: "restore_checkpoint", input: { checkpointId: checkpoint.id } });
    // The version after restore must be STRICTLY GREATER than the version
    // right before the restore -- never rewound to `versionAtCheckpoint`.
    assert.equal(getState().project.version, versionAfterMutation + 1);
  });

  it("preserves project id and createdAt -- a rollback can never change WHICH project this is or fabricate a new genesis time", async () => {
    const { registry, getState, setState, history } = buildHarness({ connectSession: false });
    const originalId = getState().project.id;
    const originalCreatedAt = getState().project.createdAt;
    const checkpoint = await createCheckpoint(registry);

    const { state: mutated } = recordTransition(history, getState(), { kind: "set_project_metadata", metadata: { a: 1 } });
    setState(mutated);

    await executeTool(registry, { toolName: "restore_checkpoint", input: { checkpointId: checkpoint.id } });
    assert.equal(getState().project.id, originalId);
    assert.equal(getState().project.createdAt, originalCreatedAt);
  });

  it("idempotent-ish: restoring to a checkpoint whose content already matches current state still succeeds and records a Change", async () => {
    const { registry, history } = buildHarness({ connectSession: false });
    const checkpoint = await createCheckpoint(registry);
    const before = history.list().length;
    const { result } = await executeTool(registry, { toolName: "restore_checkpoint", input: { checkpointId: checkpoint.id } });
    assert.equal(result.status, "success");
    assert.equal(history.list().length, before + 1);
  });
});

describe("createRestoreCheckpointTool: HISTORY -- rollback is a first-class recorded action, never erasing prior history", () => {
  it("records the rollback as a real Change with transitionKind restore_project, and does NOT erase the earlier Change", async () => {
    const { registry, getState, setState, history } = buildHarness({ connectSession: false });
    const checkpoint = await createCheckpoint(registry, "checkpoint C1");

    const { state: mutated, change: action17 } = recordTransition(
      history,
      getState(),
      { kind: "set_project_metadata", metadata: { note: "action 17" } },
      { cause: { kind: "user_request", description: "user asked for this" } }
    );
    setState(mutated);

    const { result } = await executeTool(registry, { toolName: "restore_checkpoint", input: { checkpointId: checkpoint.id, reason: "undo action 17" } });
    assert.equal(result.status, "success");
    const output = result.output as { change: Change };
    assert.equal(output.change.transitionKind, "restore_project");
    assert.equal(output.change.metadata.checkpointId, checkpoint.id);
    assert.equal(output.change.metadata.rollback, true);
    assert.match(output.change.cause.description, /undo action 17/);

    // Action 17 must still exist in history, unmodified, at its original
    // sequence position -- rollback changes CURRENT state, not the past.
    const stillThere = history.getById(action17.id);
    assert.ok(stillThere);
    assert.deepEqual(stillThere, action17);
    assert.equal(history.list().length, 2);
    assert.equal(history.list()[0]!.id, action17.id);
    assert.equal(history.list()[1]!.id, output.change.id);
  });
});

describe("createRestoreCheckpointTool: failure handling", () => {
  it("checkpoint_not_found: fails with invalid_input and mutates nothing", async () => {
    const { registry, getState } = buildHarness({ connectSession: false });
    const before = getState();
    const { result } = await executeTool(registry, { toolName: "restore_checkpoint", input: { checkpointId: "chkpt_ghost" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
    assert.match(result.error!.message, /checkpoint_not_found/);
    assert.deepEqual(getState(), before);
  });

  it("cross_project_forbidden: a checkpoint from a DIFFERENT project cannot be restored here", async () => {
    const { registry, checkpointStore, getState } = buildHarness({ connectSession: false });
    const checkpoint = await createCheckpoint(registry);
    // Simulate a checkpoint genuinely belonging to a different project by
    // saving a second one with the same shape but a different projectId.
    const foreign = { ...checkpoint, id: "chkpt_foreign", projectId: "proj_other" } as Checkpoint;
    checkpointStore.save(foreign);

    const before = getState();
    const { result } = await executeTool(registry, { toolName: "restore_checkpoint", input: { checkpointId: "chkpt_foreign" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
    assert.match(result.error!.message, /cross_project_forbidden/);
    assert.deepEqual(getState(), before);
  });

  it("incompatible_environment: checkpoint has an environment snapshot but no session is currently connected", async () => {
    const { registry, disconnectSession, getState } = buildHarness();
    const checkpoint = await createCheckpoint(registry);
    disconnectSession();

    const before = getState();
    const { result } = await executeTool(registry, { toolName: "restore_checkpoint", input: { checkpointId: checkpoint.id } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
    assert.match(result.error!.message, /incompatible_environment/);
    assert.deepEqual(getState(), before);
  });

  it("incompatible_environment: connected session's environmentKind/documentName does not match the checkpoint's", async () => {
    const { registry, checkpointStore, getState } = buildHarness();
    const checkpoint = await createCheckpoint(registry);
    const mismatched = { ...checkpoint, id: "chkpt_mismatch", environmentSnapshot: { ...checkpoint.environmentSnapshot!, documentName: "a-different-document.FCStd" } } as Checkpoint;
    checkpointStore.save(mismatched);

    const before = getState();
    const { result } = await executeTool(registry, { toolName: "restore_checkpoint", input: { checkpointId: "chkpt_mismatch" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
    assert.match(result.error!.message, /incompatible_environment/);
    assert.deepEqual(getState(), before);
  });

  it("AUDIT FIX -- incompatible_snapshot_version: a checkpoint written by an incompatible schema version is rejected BEFORE the artifact is even read, never silently restored", async () => {
    // Regression for a real gap found during the Phase 15 audit: the
    // `worldModelSnapshot.schemaVersion` field existed and was written by
    // create_checkpoint, but nothing at restore time ever compared it
    // against anything -- a checkpoint claiming an incompatible/future
    // schema version would have been silently trusted and deserialized
    // as though it were the current shape.
    const { registry, checkpointStore, getState } = buildHarness({ connectSession: false });
    const checkpoint = await createCheckpoint(registry);
    const futureVersioned = {
      ...checkpoint,
      id: "chkpt_future_version",
      worldModelSnapshot: { ...checkpoint.worldModelSnapshot, schemaVersion: "999-not-a-real-version" }
    } as Checkpoint;
    checkpointStore.save(futureVersioned);

    const before = getState();
    const { result } = await executeTool(registry, { toolName: "restore_checkpoint", input: { checkpointId: "chkpt_future_version" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
    assert.match(result.error!.message, /incompatible_snapshot_version/);
    assert.deepEqual(getState(), before);
  });

  it("missing_artifact: checkpoint metadata references an artifact that was never actually stored", async () => {
    const { registry, checkpointStore, getState } = buildHarness({ connectSession: false });
    const checkpoint = await createCheckpoint(registry);
    const danglingRef = { ...checkpoint, id: "chkpt_dangling", worldModelSnapshot: { ...checkpoint.worldModelSnapshot, artifactId: "artifact_never_written" } } as Checkpoint;
    checkpointStore.save(danglingRef);

    const before = getState();
    const { result } = await executeTool(registry, { toolName: "restore_checkpoint", input: { checkpointId: "chkpt_dangling" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "execution_failure");
    assert.match(result.error!.message, /missing_artifact/);
    assert.deepEqual(getState(), before);
  });

  it("corrupted_snapshot: the stored artifact bytes no longer match the checkpoint's recorded hash", async () => {
    const { registry, checkpointStore, artifactStore, getState } = buildHarness({ connectSession: false });
    const checkpoint = await createCheckpoint(registry);
    const tamperedArtifactId = "artifact_tampered";
    artifactStore.put(tamperedArtifactId, JSON.stringify({ tampered: true }));
    const corrupted = { ...checkpoint, id: "chkpt_corrupted", worldModelSnapshot: { ...checkpoint.worldModelSnapshot, artifactId: tamperedArtifactId } } as Checkpoint;
    checkpointStore.save(corrupted);

    const before = getState();
    const { result } = await executeTool(registry, { toolName: "restore_checkpoint", input: { checkpointId: "chkpt_corrupted" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "execution_failure");
    assert.match(result.error!.message, /corrupted_snapshot/);
    assert.deepEqual(getState(), before);
  });

  it("environment_restore_failed: the environment's own restore() call fails -- World Model must NOT be touched either", async () => {
    const { registry, faults, getState } = buildHarness();
    const checkpoint = await createCheckpoint(registry);
    faults.failRestore = true;

    const before = getState();
    const { result } = await executeTool(registry, { toolName: "restore_checkpoint", input: { checkpointId: checkpoint.id } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "execution_failure");
    assert.match(result.error!.message, /environment_restore_failed/);
    assert.deepEqual(getState(), before);
  });

  it("does not report success after a failed environment restore -- never a false positive", async () => {
    const { registry, faults, history } = buildHarness();
    const checkpoint = await createCheckpoint(registry);
    faults.failRestore = true;
    const historyLengthBefore = history.list().length;

    const { result } = await executeTool(registry, { toolName: "restore_checkpoint", input: { checkpointId: checkpoint.id } });
    assert.equal(result.status, "error");
    // No Change was recorded for a failed restore -- the audit trail
    // reflects what ACTUALLY happened (nothing), not an attempted rollback.
    assert.equal(history.list().length, historyLengthBefore);
  });
});

describe("createRestoreCheckpointTool: post-restore mismatch detection (non-fatal)", () => {
  it("detects a mismatched restore (environment claims success but content does not match) and reports it as a warning on an otherwise successful result", async () => {
    const { registry, adapter, faults, getState } = buildHarness();
    const session = (await adapter.connect()).data as EnvironmentSession;
    const checkpoint = await createCheckpoint(registry);
    // Mutate the environment for real AFTER the checkpoint, so a
    // corrupted (no-op) restore actually leaves it different from what
    // was captured -- restoring to identical content would trivially
    // "match" regardless of whether restore() genuinely ran.
    await adapter.modifyObject(session, "envobj_1", { material: "titanium" });
    faults.corruptRestore = true;

    const { result } = await executeTool(registry, { toolName: "restore_checkpoint", input: { checkpointId: checkpoint.id } });
    // The World Model side still succeeds and is recorded -- only the
    // environment-side verification came back inconclusive.
    assert.equal(result.status, "success");
    const output = result.output as { mismatchDetected: boolean; warnings: string[] };
    assert.equal(output.mismatchDetected, true);
    assert.ok(output.warnings.some((warning) => warning.includes("post_restore_mismatch")));
    // The World Model restore still genuinely happened.
    assert.deepEqual(getState().project.metadata, {});
  });

  it("a clean restore reports mismatchDetected: false with no warnings", async () => {
    const { registry } = buildHarness();
    const checkpoint = await createCheckpoint(registry);
    const { result } = await executeTool(registry, { toolName: "restore_checkpoint", input: { checkpointId: checkpoint.id } });
    assert.equal(result.status, "success");
    const output = result.output as { mismatchDetected: boolean; warnings: string[] };
    assert.equal(output.mismatchDetected, false);
    assert.deepEqual(output.warnings, []);
  });
});

describe("createRestoreCheckpointTool: Phase 15 -- real P4 authorization, rollback is a mutation like any other", () => {
  it("unauthorized rollback (no approval, no autonomy grant) is rejected with policy_rejected and mutates nothing", async () => {
    const { registry, getState } = buildHarness({ connectSession: false });
    const checkpoint = await createCheckpoint(registry);

    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "approved_modify", approvals, autonomyGrants });

    const before = getState();
    const { result } = await executeTool(registry, {
      toolName: "restore_checkpoint",
      input: { checkpointId: checkpoint.id },
      target: { entityType: "checkpoint", entityId: checkpoint.id },
      authorize
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "policy_rejected");
    assert.deepEqual(getState(), before);
  });

  it("unapproved (pending) rollback is rejected", async () => {
    const { registry, getState } = buildHarness({ connectSession: false });
    const checkpoint = await createCheckpoint(registry);

    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    approvals.create({ toolName: "restore_checkpoint", targetType: "checkpoint", targetId: checkpoint.id, reason: "test" });
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "approved_modify", approvals, autonomyGrants });

    const before = getState();
    const { result } = await executeTool(registry, {
      toolName: "restore_checkpoint",
      input: { checkpointId: checkpoint.id },
      target: { entityType: "checkpoint", entityId: checkpoint.id },
      authorize
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "policy_rejected");
    assert.deepEqual(getState(), before);
  });

  it("approved rollback executes for real", async () => {
    const { registry, getState, setState, history } = buildHarness({ connectSession: false });
    const checkpoint = await createCheckpoint(registry);
    const { state: mutated } = recordTransition(history, getState(), { kind: "set_project_metadata", metadata: { edited: true } });
    setState(mutated);

    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    const approval = approvals.create({ toolName: "restore_checkpoint", targetType: "checkpoint", targetId: checkpoint.id, reason: "test" });
    approvals.approve(approval.id, "human", "approved for test");
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "approved_modify", approvals, autonomyGrants });

    const { result } = await executeTool(registry, {
      toolName: "restore_checkpoint",
      input: { checkpointId: checkpoint.id },
      target: { entityType: "checkpoint", entityId: checkpoint.id },
      authorize
    });
    assert.equal(result.status, "success");
    assert.deepEqual(getState().project.metadata, {});
  });

  it("wrong scope: an approval for a DIFFERENT checkpoint does not authorize restoring this one", async () => {
    const { registry, getState } = buildHarness({ connectSession: false });
    const checkpoint = await createCheckpoint(registry);

    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    const approval = approvals.create({ toolName: "restore_checkpoint", targetType: "checkpoint", targetId: "some_other_checkpoint", reason: "test" });
    approvals.approve(approval.id, "human", "approved for test");
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "approved_modify", approvals, autonomyGrants });

    const before = getState();
    const { result } = await executeTool(registry, {
      toolName: "restore_checkpoint",
      input: { checkpointId: checkpoint.id },
      target: { entityType: "checkpoint", entityId: checkpoint.id },
      authorize
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "policy_rejected");
    assert.deepEqual(getState(), before);
  });

  it("denied rollback: an explicitly REJECTED approval denies the call", async () => {
    const { registry, getState } = buildHarness({ connectSession: false });
    const checkpoint = await createCheckpoint(registry);

    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    const approval = approvals.create({ toolName: "restore_checkpoint", targetType: "checkpoint", targetId: checkpoint.id, reason: "test" });
    approvals.reject(approval.id, "human", "not approved");
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "approved_modify", approvals, autonomyGrants });

    const before = getState();
    const { result } = await executeTool(registry, {
      toolName: "restore_checkpoint",
      input: { checkpointId: checkpoint.id },
      target: { entityType: "checkpoint", entityId: checkpoint.id },
      authorize
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "policy_rejected");
    assert.deepEqual(getState(), before);
  });
});
