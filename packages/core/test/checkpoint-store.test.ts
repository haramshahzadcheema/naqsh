import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCheckpoint, type Checkpoint } from "@naqsh/schemas";
import { createCheckpointStore, deserializeCheckpointStore } from "../src/checkpoint-store.js";

function buildCheckpoint(overrides: Partial<Parameters<typeof createCheckpoint>[0]> = {}): Checkpoint {
  return createCheckpoint({
    projectId: "proj_1",
    projectVersion: 1,
    worldModelSnapshot: { artifactId: "artifact_1", contentHash: "a".repeat(64), byteSize: 100 },
    ...overrides
  });
}

describe("CheckpointStore: save/getById/list/listForProject", () => {
  it("saves and retrieves a checkpoint by id", () => {
    const store = createCheckpointStore();
    const checkpoint = buildCheckpoint();
    store.save(checkpoint);
    assert.deepEqual(store.getById(checkpoint.id), checkpoint);
  });

  it("returns undefined for an unknown id", () => {
    const store = createCheckpointStore();
    assert.equal(store.getById("chkpt_missing"), undefined);
  });

  it("lists every saved checkpoint", () => {
    const store = createCheckpointStore();
    const a = buildCheckpoint({ projectId: "proj_a" });
    const b = buildCheckpoint({ projectId: "proj_b" });
    store.save(a);
    store.save(b);
    assert.deepEqual(store.list(), [a, b]);
  });

  it("listForProject filters to exactly one project -- this IS the project-isolation mechanism restore_checkpoint relies on", () => {
    const store = createCheckpointStore();
    const a1 = buildCheckpoint({ projectId: "proj_a" });
    const a2 = buildCheckpoint({ projectId: "proj_a" });
    const b1 = buildCheckpoint({ projectId: "proj_b" });
    store.save(a1);
    store.save(a2);
    store.save(b1);
    assert.deepEqual(store.listForProject("proj_a"), [a1, a2]);
    assert.deepEqual(store.listForProject("proj_b"), [b1]);
    assert.deepEqual(store.listForProject("proj_nonexistent"), []);
  });

  it("IMMUTABILITY: refuses to save a duplicate checkpoint id -- checkpoints can never be overwritten after creation", () => {
    const store = createCheckpointStore();
    const checkpoint = buildCheckpoint();
    store.save(checkpoint);
    assert.throws(() => store.save(checkpoint), /already exists/);
    // Saving a DIFFERENT checkpoint object that merely reuses the same id
    // must be rejected too -- immutability is about the ID, not object
    // identity.
    const tampered = { ...checkpoint, reason: "a different reason" } as Checkpoint;
    assert.throws(() => store.save(tampered), /already exists/);
    assert.equal(store.getById(checkpoint.id)!.reason, checkpoint.reason);
  });

  it("has no update/delete method on its public interface at all", () => {
    const store = createCheckpointStore();
    assert.equal("update" in store, false);
    assert.equal("delete" in store, false);
    assert.equal("remove" in store, false);
  });
});

describe("CheckpointStore: serialize/deserializeCheckpointStore", () => {
  it("round-trips through serialize/deserialize with full fidelity", () => {
    const store = createCheckpointStore();
    const a = buildCheckpoint({ projectId: "proj_a" });
    const b = buildCheckpoint({ projectId: "proj_b" });
    store.save(a);
    store.save(b);

    const restored = deserializeCheckpointStore(store.serialize());
    assert.deepEqual(restored.list(), [a, b]);
  });

  it("rejects a non-array serialized payload", () => {
    assert.throws(() => deserializeCheckpointStore(JSON.stringify({ not: "an array" })), /must be an array/);
  });

  it("rejects an empty string", () => {
    assert.throws(() => deserializeCheckpointStore(""), /is required/);
  });

  it("rejects a serialized store containing a duplicate id (corrupted/hand-edited log)", () => {
    const checkpoint = buildCheckpoint();
    const corrupted = JSON.stringify([checkpoint, checkpoint]);
    assert.throws(() => deserializeCheckpointStore(corrupted), /already exists/);
  });
});
