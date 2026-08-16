import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createVerificationResult, type VerificationResult } from "@naqsh/schemas";
import { createVerificationResultStore, deserializeVerificationResultStore } from "../src/verification-result-store.js";

function buildResult(overrides: Partial<Parameters<typeof createVerificationResult>[0]> = {}): VerificationResult {
  return createVerificationResult({
    checkId: "check_1",
    checkKind: "object_exists",
    status: "pass",
    reasonKind: "satisfied",
    message: "object exists",
    projectId: "proj_1",
    projectVersion: 1,
    ...overrides
  });
}

describe("VerificationResultStore: save/getById/list/listForCheck/listForProject", () => {
  it("saves and retrieves a result by id", () => {
    const store = createVerificationResultStore();
    const result = buildResult();
    store.save(result);
    assert.deepEqual(store.getById(result.id), result);
  });

  it("returns undefined for an unknown id", () => {
    const store = createVerificationResultStore();
    assert.equal(store.getById("verif_missing"), undefined);
  });

  it("lists every saved result", () => {
    const store = createVerificationResultStore();
    const a = buildResult({ checkId: "check_a" });
    const b = buildResult({ checkId: "check_b" });
    store.save(a);
    store.save(b);
    assert.deepEqual(store.list(), [a, b]);
  });

  it("listForCheck filters to exactly one check -- lets a caller see every result a check has ever produced, in order", () => {
    const store = createVerificationResultStore();
    const a1 = buildResult({ checkId: "check_a", status: "fail", reasonKind: "violated", message: "first run" });
    const a2 = buildResult({ checkId: "check_a", status: "pass", reasonKind: "satisfied", message: "second run" });
    const b1 = buildResult({ checkId: "check_b" });
    store.save(a1);
    store.save(a2);
    store.save(b1);
    assert.deepEqual(store.listForCheck("check_a"), [a1, a2]);
    assert.deepEqual(store.listForCheck("check_b"), [b1]);
    assert.deepEqual(store.listForCheck("check_nonexistent"), []);
  });

  it("listForProject filters to exactly one project", () => {
    const store = createVerificationResultStore();
    const a = buildResult({ projectId: "proj_a" });
    const b = buildResult({ projectId: "proj_b" });
    store.save(a);
    store.save(b);
    assert.deepEqual(store.listForProject("proj_a"), [a]);
    assert.deepEqual(store.listForProject("proj_b"), [b]);
  });

  it("APPEND-ONLY: refuses to save a duplicate result id", () => {
    const store = createVerificationResultStore();
    const result = buildResult();
    store.save(result);
    assert.throws(() => store.save(result), /already exists/);
  });

  it("has no update/delete method on its public interface at all", () => {
    const store = createVerificationResultStore();
    assert.equal("update" in store, false);
    assert.equal("delete" in store, false);
    assert.equal("remove" in store, false);
  });
});

describe("VerificationResultStore: serialize/deserializeVerificationResultStore", () => {
  it("round-trips through serialize/deserialize with full fidelity", () => {
    const store = createVerificationResultStore();
    const a = buildResult({ checkId: "check_a" });
    const b = buildResult({ checkId: "check_b" });
    store.save(a);
    store.save(b);

    const restored = deserializeVerificationResultStore(store.serialize());
    assert.deepEqual(restored.list(), [a, b]);
  });

  it("rejects a non-array serialized payload", () => {
    assert.throws(() => deserializeVerificationResultStore(JSON.stringify({ not: "an array" })), /must be an array/);
  });

  it("rejects an empty string", () => {
    assert.throws(() => deserializeVerificationResultStore(""), /is required/);
  });
});
