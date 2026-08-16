import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createObjectiveSatisfactionResult, type ObjectiveSatisfactionResult } from "@naqsh/schemas";
import { createObjectiveSatisfactionStore, deserializeObjectiveSatisfactionStore } from "../src/objective-satisfaction-store.js";

function buildResult(overrides: Partial<Parameters<typeof createObjectiveSatisfactionResult>[0]> = {}): ObjectiveSatisfactionResult {
  return createObjectiveSatisfactionResult({
    projectId: "proj_1",
    projectVersion: 1,
    status: "satisfied",
    reason: "all required conditions are satisfied",
    conditions: [],
    ...overrides
  });
}

describe("ObjectiveSatisfactionStore: save/getById/list/listForProject", () => {
  it("saves and retrieves a result by id", () => {
    const store = createObjectiveSatisfactionStore();
    const result = buildResult();
    store.save(result);
    assert.deepEqual(store.getById(result.id), result);
  });

  it("returns undefined for an unknown id", () => {
    const store = createObjectiveSatisfactionStore();
    assert.equal(store.getById("objsat_missing"), undefined);
  });

  it("lists every saved result", () => {
    const store = createObjectiveSatisfactionStore();
    const a = buildResult({ projectId: "proj_a" });
    const b = buildResult({ projectId: "proj_b" });
    store.save(a);
    store.save(b);
    assert.deepEqual(store.list(), [a, b]);
  });

  it("listForProject filters to exactly one project", () => {
    const store = createObjectiveSatisfactionStore();
    const a = buildResult({ projectId: "proj_a" });
    const b = buildResult({ projectId: "proj_b" });
    store.save(a);
    store.save(b);
    assert.deepEqual(store.listForProject("proj_a"), [a]);
    assert.deepEqual(store.listForProject("proj_b"), [b]);
  });

  it("APPEND-ONLY: refuses to save a duplicate result id", () => {
    const store = createObjectiveSatisfactionStore();
    const result = buildResult();
    store.save(result);
    assert.throws(() => store.save(result), /already exists/);
  });

  it("has no update/delete method on its public interface at all", () => {
    const store = createObjectiveSatisfactionStore();
    assert.equal("update" in store, false);
    assert.equal("delete" in store, false);
    assert.equal("remove" in store, false);
  });
});

describe("ObjectiveSatisfactionStore: serialize/deserializeObjectiveSatisfactionStore", () => {
  it("round-trips through serialize/deserialize with full fidelity", () => {
    const store = createObjectiveSatisfactionStore();
    const a = buildResult({ projectId: "proj_a" });
    const b = buildResult({ projectId: "proj_b" });
    store.save(a);
    store.save(b);

    const restored = deserializeObjectiveSatisfactionStore(store.serialize());
    assert.deepEqual(restored.list(), [a, b]);
  });

  it("rejects a non-array serialized payload", () => {
    assert.throws(() => deserializeObjectiveSatisfactionStore(JSON.stringify({ not: "an array" })), /must be an array/);
  });

  it("rejects an empty string", () => {
    assert.throws(() => deserializeObjectiveSatisfactionStore(""), /is required/);
  });
});
