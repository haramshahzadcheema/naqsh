import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createWorldModelState,
  deserializeWorldModelState,
  type Checkpoint,
  type EnvironmentDocumentInspection,
  type EnvironmentObject,
  type EnvironmentOperationResult,
  type EnvironmentSession,
  type WorldModelState
} from "@naqsh/schemas";
import { createCreateCheckpointTool } from "../src/create-checkpoint-tool.js";
import { createArtifactStore, computeContentHash, byteSizeOf } from "../src/artifact-store.js";
import { createCheckpointStore } from "../src/checkpoint-store.js";
import { createChangeHistory } from "../src/change-history.js";
import { recordTransition } from "../src/record-transition.js";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry } from "../src/tool-registry.js";
import type { EnvironmentAdapter } from "../src/environment-adapter.js";

/**
 * A minimal, hand-built fake `EnvironmentAdapter` -- matches every other
 * core test file's "no @naqsh/adapters dependency" precedent (see
 * modify-environment-object-tool.test.ts's identical `buildFakeAdapter`).
 * Implements REAL checkpoint/restore/inspectDocument semantics (not
 * hardcoded canned responses) so these tests exercise genuine round-trip
 * behavior, plus simple fault-injection flags for the failure paths Phase
 * 15 requires coverage for.
 */
function buildFakeAdapter(
  objects: Map<string, EnvironmentObject>,
  options: { supportsCheckpoint?: boolean } = {}
): { adapter: EnvironmentAdapter; session: EnvironmentSession; faults: { failCheckpoint: boolean; failListObjects: boolean } } {
  const now = () => new Date().toISOString();
  const session: EnvironmentSession = { id: "sess_1", environmentKind: "fake", status: "connected", documentName: "fake.doc", openedAt: now(), metadata: {} };
  const checkpoints = new Map<string, Map<string, EnvironmentObject>>();
  const faults = { failCheckpoint: false, failListObjects: false };
  const capabilities = new Set(options.supportsCheckpoint === false ? ["modify"] : ["modify", "checkpoint"]);

  function ok(operation: EnvironmentOperationResult["operation"], data: unknown): EnvironmentOperationResult {
    return { id: `envop_${Math.random()}`, operation, sessionId: session.id, objectId: null, status: "success", data, error: null, startedAt: now(), completedAt: now(), metadata: {} };
  }
  function err(operation: EnvironmentOperationResult["operation"], kind: "unsupported_capability" | "environment_failure" | "object_not_found", message: string): EnvironmentOperationResult {
    return { id: `envop_${Math.random()}`, operation, sessionId: session.id, objectId: null, status: "error", data: null, error: { kind, message }, startedAt: now(), completedAt: now(), metadata: {} };
  }

  const adapter: EnvironmentAdapter = {
    describe: () => ({ kind: "fake", name: "Fake Environment", version: "0.0.1", capabilities: [...capabilities] as never, metadata: {} }),
    health: async () => ok("health", { status: "healthy", message: "", checkedAt: now() }),
    connect: async () => ok("connect", session),
    disconnect: async () => ok("disconnect", null),
    listObjects: async () => {
      if (faults.failListObjects) return err("list_objects", "environment_failure", "simulated list_objects failure");
      return ok("list_objects", [...objects.values()]);
    },
    inspectObject: async (_session, objectId) => {
      const object = objects.get(objectId);
      return object ? ok("inspect_object", object) : err("inspect_object", "object_not_found", `No object "${objectId}"`);
    },
    inspectDocument: async () => {
      const inspection: EnvironmentDocumentInspection = {
        environmentKind: "fake",
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
      if (!capabilities.has("checkpoint")) return err("checkpoint", "unsupported_capability", `"fake" does not support "checkpoint"`);
      if (faults.failCheckpoint) return err("checkpoint", "environment_failure", "simulated checkpoint failure");
      const checkpointId = `chkpt_fake_${checkpoints.size + 1}`;
      checkpoints.set(checkpointId, new Map([...objects].map(([id, value]) => [id, { ...value }])));
      return ok("checkpoint", { checkpointId });
    },
    restore: async (_session, checkpointId) => {
      if (!capabilities.has("checkpoint")) return err("restore", "unsupported_capability", `"fake" does not support "checkpoint"`);
      const snapshot = checkpoints.get(checkpointId);
      if (!snapshot) return err("restore", "object_not_found", `No checkpoint "${checkpointId}"`);
      objects.clear();
      for (const [id, value] of snapshot) objects.set(id, value);
      return ok("restore", null);
    }
  };

  return { adapter, session, faults };
}

function buildState(): WorldModelState {
  return createWorldModelState({ project: { id: "proj_1", name: "Test Project" }, session: { id: "sess_wm_1" } });
}

function buildHarness(options: { supportsCheckpoint?: boolean; connectSession?: boolean } = { connectSession: true }) {
  const objects = new Map<string, EnvironmentObject>([
    ["envobj_1", { id: "envobj_1", type: "bracket", name: "Bracket", genericType: "unknown", parentId: null, visible: null, geometry: { available: false, reason: "no_shape", valid: null, boundingBox: null, volume: null, surfaceArea: null, centerOfMass: null, solidCount: null, faceCount: null, edgeCount: null, vertexCount: null, shapeType: null }, properties: [{ key: "material", value: "steel", readOnly: false }], relationships: [], metadata: {} }]
  ]);
  const { adapter, session, faults } = buildFakeAdapter(objects, { supportsCheckpoint: options.supportsCheckpoint });
  let state = buildState();
  const history = createChangeHistory();
  const checkpointStore = createCheckpointStore();
  const artifactStore = createArtifactStore();
  let connectedSession: EnvironmentSession | null = options.connectSession === false ? null : session;

  const registry = createToolRegistry();
  const { tool, handler } = createCreateCheckpointTool(
    () => state,
    history,
    () => connectedSession,
    adapter,
    checkpointStore,
    artifactStore
  );
  registry.register(tool, handler);

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

describe("createCreateCheckpointTool: identity and classification", () => {
  it("is classified suggest/checkpoint -- creating a checkpoint never mutates World Model or environment content", () => {
    const { registry } = buildHarness();
    const tool = registry.getByName("create_checkpoint")!;
    assert.equal(tool.mutation, "suggest");
    assert.equal(tool.target, "checkpoint");
  });
});

describe("createCreateCheckpointTool: successful checkpoint creation", () => {
  it("creates a World-Model-only checkpoint when no environment session is connected", async () => {
    const { registry, checkpointStore, artifactStore } = buildHarness({ connectSession: false });
    const { result } = await executeTool(registry, { toolName: "create_checkpoint", input: { reason: "before removing the bracket" } });
    assert.equal(result.status, "success");
    const output = result.output as { checkpoint: Checkpoint };
    assert.equal(output.checkpoint.environmentSnapshot, null);
    assert.equal(output.checkpoint.reason, "before removing the bracket");
    assert.equal(checkpointStore.getById(output.checkpoint.id)?.id, output.checkpoint.id);
    assert.equal(artifactStore.has(output.checkpoint.worldModelSnapshot.artifactId), true);
  });

  it("creates a checkpoint WITH an environment snapshot when a session is connected", async () => {
    const { registry, checkpointStore } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "create_checkpoint", input: { reason: "before edits" } });
    assert.equal(result.status, "success");
    const output = result.output as { checkpoint: Checkpoint };
    assert.notEqual(output.checkpoint.environmentSnapshot, null);
    assert.equal(output.checkpoint.environmentSnapshot!.environmentKind, "fake");
    assert.equal(output.checkpoint.environmentSnapshot!.documentName, "fake.doc");
    assert.ok(output.checkpoint.environmentSnapshot!.environmentCheckpointId.length > 0);
    assert.deepEqual(output.checkpoint.environmentSnapshot!.objectIds, ["envobj_1"]);
    assert.equal(checkpointStore.list().length, 1);
  });

  it("metadata correctness: projectVersion and lastChangeId reflect the CURRENT state at capture time", async () => {
    const { registry, getState, setState, history } = buildHarness({ connectSession: false });
    // Advance state with a real transition first, so lastChangeId/projectVersion are non-trivial.
    const { state: advanced, change } = recordTransition(history, getState(), { kind: "set_project_metadata", metadata: { note: "x" } });
    setState(advanced);

    const { result } = await executeTool(registry, { toolName: "create_checkpoint", input: { reason: "after first edit" } });
    const output = result.output as { checkpoint: Checkpoint };
    assert.equal(output.checkpoint.projectVersion, advanced.project.version);
    assert.equal(output.checkpoint.lastChangeId, change.id);
  });

  it("the World Model artifact is a genuine, valid serialized WorldModelState -- deserializable and hash-verified", async () => {
    const { registry, artifactStore, getState } = buildHarness({ connectSession: false });
    const { result } = await executeTool(registry, { toolName: "create_checkpoint", input: { reason: "x" } });
    const output = result.output as { checkpoint: Checkpoint };
    const content = artifactStore.get(output.checkpoint.worldModelSnapshot.artifactId)!;
    assert.equal(computeContentHash(content), output.checkpoint.worldModelSnapshot.contentHash);
    assert.equal(byteSizeOf(content), output.checkpoint.worldModelSnapshot.byteSize);
    const restored = deserializeWorldModelState(content);
    assert.deepEqual(restored.project, getState().project);
  });
});

describe("createCreateCheckpointTool: invalid input", () => {
  it("rejects a missing/empty reason", async () => {
    const { registry } = buildHarness({ connectSession: false });
    const { result } = await executeTool(registry, { toolName: "create_checkpoint", input: {} });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });
});

describe("createCreateCheckpointTool: atomicity -- environment snapshot failure fails the WHOLE checkpoint, nothing persisted", () => {
  it("if the environment cannot produce a snapshot, no Checkpoint metadata and no artifact are ever saved", async () => {
    const { registry, faults, checkpointStore, artifactStore } = buildHarness();
    faults.failCheckpoint = true;
    const { result } = await executeTool(registry, { toolName: "create_checkpoint", input: { reason: "x" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "execution_failure");
    assert.equal(checkpointStore.list().length, 0);
    // No orphaned artifact either -- the WorldModelState serialization
    // happens AFTER the environment snapshot succeeds, not before.
    assert.equal(artifactStore.has("artifact_1"), false);
  });

  it("if post-checkpoint fingerprinting (listObjects) fails, the WHOLE checkpoint still fails -- no silently-degraded checkpoint without a mismatch baseline", async () => {
    const { registry, faults, checkpointStore } = buildHarness();
    faults.failListObjects = true;
    const { result } = await executeTool(registry, { toolName: "create_checkpoint", input: { reason: "x" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "execution_failure");
    assert.equal(checkpointStore.list().length, 0);
  });

  it("does not fake an environment snapshot when the adapter genuinely lacks the checkpoint capability", async () => {
    const { registry, checkpointStore } = buildHarness({ supportsCheckpoint: false });
    const { result } = await executeTool(registry, { toolName: "create_checkpoint", input: { reason: "x" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "execution_failure");
    assert.equal(checkpointStore.list().length, 0);
  });
});
