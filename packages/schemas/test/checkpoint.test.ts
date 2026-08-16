import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertCheckpoint,
  assertCheckpointArtifactRef,
  assertCheckpointEnvironmentSnapshot,
  createCheckpoint,
  createCheckpointArtifactRef,
  createCheckpointEnvironmentSnapshot,
  deserializeCheckpoint,
  serializeCheckpoint,
  WorldModelValidationError,
  type Checkpoint,
  type CheckpointInput
} from "../src/index.js";

const HASH_64 = "a".repeat(64);

function buildCheckpointInput(overrides: Partial<CheckpointInput> = {}): CheckpointInput {
  return {
    projectId: "proj_1",
    reason: "before removing the bracket",
    projectVersion: 1,
    worldModelSnapshot: { artifactId: "artifact_1", contentHash: HASH_64, byteSize: 128 },
    ...overrides
  };
}

describe("CheckpointArtifactRef: creation and validation", () => {
  it("creates a valid ref with defaults", () => {
    const ref = createCheckpointArtifactRef({ artifactId: "artifact_1", contentHash: HASH_64, byteSize: 100 });
    assert.equal(ref.artifactId, "artifact_1");
    assert.equal(ref.schemaVersion, "1");
  });

  it("rejects a malformed contentHash (not 64 lowercase hex chars)", () => {
    assert.throws(
      () => assertCheckpointArtifactRef({ artifactId: "a", contentHash: "not-a-hash", byteSize: 1, schemaVersion: "1" }),
      /contentHash must be a 64-character lowercase hex SHA-256 digest/
    );
  });

  it("rejects a negative byteSize", () => {
    assert.throws(
      () => assertCheckpointArtifactRef({ artifactId: "a", contentHash: HASH_64, byteSize: -1, schemaVersion: "1" }),
      /byteSize must be a non-negative integer/
    );
  });

  it("rejects an empty artifactId", () => {
    assert.throws(() => createCheckpointArtifactRef({ artifactId: "", contentHash: HASH_64, byteSize: 1 }), WorldModelValidationError);
  });

  it("the returned ref is frozen -- immutable once created", () => {
    const ref = createCheckpointArtifactRef({ artifactId: "artifact_1", contentHash: HASH_64, byteSize: 1 });
    assert.throws(() => {
      (ref as { artifactId: string }).artifactId = "tampered";
    }, TypeError);
  });
});

describe("CheckpointEnvironmentSnapshot: creation and validation", () => {
  it("creates a valid snapshot", () => {
    const snapshot = createCheckpointEnvironmentSnapshot({
      environmentKind: "freecad",
      environmentCheckpointId: "chk_1",
      documentName: "part.FCStd",
      objectIds: ["Box", "Cut"],
      contentHash: HASH_64
    });
    assert.equal(snapshot.environmentKind, "freecad");
    assert.deepEqual(snapshot.objectIds, ["Box", "Cut"]);
  });

  it("defaults documentName to null and objectIds to []", () => {
    const snapshot = createCheckpointEnvironmentSnapshot({ environmentKind: "freecad", environmentCheckpointId: "chk_1", contentHash: HASH_64 });
    assert.equal(snapshot.documentName, null);
    assert.deepEqual(snapshot.objectIds, []);
  });

  it("rejects a malformed contentHash", () => {
    assert.throws(
      () => assertCheckpointEnvironmentSnapshot({ environmentKind: "freecad", environmentCheckpointId: "chk_1", documentName: null, objectIds: [], contentHash: "bad" }),
      /contentHash must be a 64-character lowercase hex SHA-256 digest/
    );
  });

  it("rejects a non-string entry in objectIds", () => {
    assert.throws(
      () => assertCheckpointEnvironmentSnapshot({ environmentKind: "freecad", environmentCheckpointId: "chk_1", documentName: null, objectIds: [1], contentHash: HASH_64 }),
      /objectIds must be an array of strings/
    );
  });
});

describe("Checkpoint: creation and validation", () => {
  it("creates a valid checkpoint with defaults", () => {
    const checkpoint = createCheckpoint(buildCheckpointInput());
    assert.match(checkpoint.id, /^chkpt_/);
    assert.equal(checkpoint.status, "complete");
    assert.equal(checkpoint.source, "agent");
    assert.equal(checkpoint.sessionId, null);
    assert.equal(checkpoint.lastChangeId, null);
    assert.equal(checkpoint.environmentSnapshot, null);
    assert.equal(typeof checkpoint.createdAt, "string");
  });

  it("creates a checkpoint WITH an environment snapshot", () => {
    const checkpoint = createCheckpoint(
      buildCheckpointInput({
        environmentSnapshot: { environmentKind: "freecad", environmentCheckpointId: "chk_1", documentName: "part.FCStd", objectIds: ["Box"], contentHash: HASH_64 }
      })
    );
    assert.notEqual(checkpoint.environmentSnapshot, null);
    assert.equal(checkpoint.environmentSnapshot!.environmentKind, "freecad");
  });

  it("rejects a missing projectId", () => {
    assert.throws(() => createCheckpoint(buildCheckpointInput({ projectId: "" })), WorldModelValidationError);
  });

  it("rejects a non-positive projectVersion", () => {
    assert.throws(() => createCheckpoint(buildCheckpointInput({ projectVersion: 0 })), /projectVersion must be a positive integer/);
  });

  it("rejects an invalid status", () => {
    assert.throws(() => assertCheckpoint({ ...createCheckpoint(buildCheckpointInput()), status: "pending" }), /invalid checkpoint\.status/);
  });

  it("is deep-frozen -- top-level and nested fields cannot be mutated", () => {
    const checkpoint = createCheckpoint(buildCheckpointInput());
    assert.throws(() => {
      (checkpoint as { reason: string }).reason = "tampered";
    }, TypeError);
  });

  it("metadata must be JSON-serializable", () => {
    assert.throws(
      () => createCheckpoint(buildCheckpointInput({ metadata: { fn: () => {} } as never })),
      WorldModelValidationError
    );
  });
});

describe("Checkpoint: serialize/deserialize round-trip", () => {
  it("round-trips through JSON with full fidelity", () => {
    const checkpoint = createCheckpoint(
      buildCheckpointInput({
        environmentSnapshot: { environmentKind: "freecad", environmentCheckpointId: "chk_1", documentName: "part.FCStd", objectIds: ["Box"], contentHash: HASH_64 }
      })
    );
    const restored = deserializeCheckpoint(serializeCheckpoint(checkpoint));
    assert.deepEqual(restored, checkpoint);
  });

  it("rejects a corrupted/malformed serialized payload", () => {
    assert.throws(() => deserializeCheckpoint(JSON.stringify({ not: "a checkpoint" })), WorldModelValidationError);
  });

  it("rejects an empty string", () => {
    assert.throws(() => deserializeCheckpoint(""), /is required/);
  });

  it("serializeCheckpoint rejects an object that merely LOOKS like a Checkpoint but fails validation", () => {
    const fake = { id: "chkpt_1" } as unknown as Checkpoint;
    assert.throws(() => serializeCheckpoint(fake), WorldModelValidationError);
  });
});
