import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCheck, type Check } from "@naqsh/schemas";
import { createCheckStore, deserializeCheckStore } from "../src/check-store.js";

function buildCheck(overrides: Partial<Parameters<typeof createCheck>[0]> = {}): Check {
  return createCheck({
    kind: "object_exists",
    description: "bracket must exist",
    objectId: "envobj_1",
    ...overrides
  } as Parameters<typeof createCheck>[0]);
}

describe("CheckStore: save/getById/list", () => {
  it("saves and retrieves a check by id", () => {
    const store = createCheckStore();
    const check = buildCheck();
    store.save(check);
    assert.deepEqual(store.getById(check.id), check);
  });

  it("returns undefined for an unknown id", () => {
    const store = createCheckStore();
    assert.equal(store.getById("check_missing"), undefined);
  });

  it("lists every saved check", () => {
    const store = createCheckStore();
    const a = buildCheck({ objectId: "envobj_a" });
    const b = buildCheck({ objectId: "envobj_b" });
    store.save(a);
    store.save(b);
    assert.deepEqual(store.list(), [a, b]);
  });

  it("IMMUTABILITY: refuses to save a duplicate check id", () => {
    const store = createCheckStore();
    const check = buildCheck();
    store.save(check);
    assert.throws(() => store.save(check), /already exists/);
    const tampered = { ...check, description: "a different description" } as Check;
    assert.throws(() => store.save(tampered), /already exists/);
    assert.equal(store.getById(check.id)!.description, check.description);
  });

  it("has no update/delete method on its public interface at all", () => {
    const store = createCheckStore();
    assert.equal("update" in store, false);
    assert.equal("delete" in store, false);
    assert.equal("remove" in store, false);
  });
});

describe("CheckStore: serialize/deserializeCheckStore", () => {
  it("round-trips through serialize/deserialize with full fidelity", () => {
    const store = createCheckStore();
    const a = buildCheck({ objectId: "envobj_a" });
    const b = buildCheck({ objectId: "envobj_b" });
    store.save(a);
    store.save(b);

    const restored = deserializeCheckStore(store.serialize());
    assert.deepEqual(restored.list(), [a, b]);
  });

  it("rejects a non-array serialized payload", () => {
    assert.throws(() => deserializeCheckStore(JSON.stringify({ not: "an array" })), /must be an array/);
  });

  it("rejects an empty string", () => {
    assert.throws(() => deserializeCheckStore(""), /is required/);
  });

  it("rejects a serialized store containing a duplicate id (corrupted/hand-edited log)", () => {
    const check = buildCheck();
    const corrupted = JSON.stringify([check, check]);
    assert.throws(() => deserializeCheckStore(corrupted), /already exists/);
  });
});
