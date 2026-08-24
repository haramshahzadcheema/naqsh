import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AuthorizationError } from "@naqsh/schemas";
import { createAutonomyGrantStore, deserializeAutonomyGrantStore } from "../src/autonomy-grant-store.js";

describe("AutonomyGrantStore: creation and listing", () => {
  it("creates an active grant", () => {
    const store = createAutonomyGrantStore();
    const grant = store.create({ toolNames: ["inspect_project"] });
    assert.equal(grant.status, "active");
    assert.equal(store.getById(grant.id), grant);
  });

  it("listActive excludes revoked grants", () => {
    const store = createAutonomyGrantStore();
    const grant = store.create({ toolNames: ["a"] });
    store.revoke(grant.id, "human");
    assert.equal(store.listActive().length, 0);
    assert.equal(store.list().length, 1);
  });

  it("listActive excludes expired grants", () => {
    const store = createAutonomyGrantStore();
    store.create({ toolNames: ["a"], expiresAt: new Date(Date.now() - 1000).toISOString() });
    assert.equal(store.listActive().length, 0);
  });

  it("listActive includes grants with a future expiry", () => {
    const store = createAutonomyGrantStore();
    store.create({ toolNames: ["a"], expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    assert.equal(store.listActive().length, 1);
  });
});

describe("AutonomyGrantStore: revocation", () => {
  it("revokes an active grant and records who revoked it", () => {
    const store = createAutonomyGrantStore();
    const grant = store.create({ toolNames: ["a"] });
    const revoked = store.revoke(grant.id, "human", "no longer needed");
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.reason, "no longer needed");
    assert.notEqual(revoked.revokedAt, null);
    assert.equal(revoked.revokedBy, "human");
  });

  it("throws for an unknown grant id", () => {
    const store = createAutonomyGrantStore();
    assert.throws(
      () => store.revoke("grant_does_not_exist", "human"),
      (error: unknown) => error instanceof AuthorizationError && error.kind === "not_found"
    );
  });
});

describe("AutonomyGrantStore: recordUse (bounded consumption)", () => {
  it("increments useCount", () => {
    const store = createAutonomyGrantStore();
    const grant = store.create({ toolNames: ["a"] });
    const used = store.recordUse(grant.id);
    assert.equal(used.useCount, 1);
    const usedAgain = store.recordUse(grant.id);
    assert.equal(usedAgain.useCount, 2);
  });

  it("rejects use once maxUses is reached", () => {
    const store = createAutonomyGrantStore();
    const grant = store.create({ toolNames: ["a"], maxUses: 2 });
    store.recordUse(grant.id);
    store.recordUse(grant.id);
    assert.throws(
      () => store.recordUse(grant.id),
      (error: unknown) => error instanceof AuthorizationError && error.kind === "invalid_state_transition"
    );
  });

  it("rejects use on a revoked grant", () => {
    const store = createAutonomyGrantStore();
    const grant = store.create({ toolNames: ["a"] });
    store.revoke(grant.id, "human");
    assert.throws(() => store.recordUse(grant.id), AuthorizationError);
  });

  it("rejects use on an expired grant", () => {
    const store = createAutonomyGrantStore();
    const grant = store.create({ toolNames: ["a"], expiresAt: new Date(Date.now() - 1000).toISOString() });
    assert.throws(() => store.recordUse(grant.id), AuthorizationError);
  });
});

describe("AutonomyGrantStore: serialize/deserializeAutonomyGrantStore", () => {
  it("round-trips through serialize/deserialize with full fidelity, including useCount and revocation", () => {
    const store = createAutonomyGrantStore();
    const active = store.create({ toolNames: ["a"] });
    store.recordUse(active.id);
    store.recordUse(active.id);
    const revoked = store.create({ toolNames: ["b"] });
    store.revoke(revoked.id, "human", "no longer needed");

    const restored = deserializeAutonomyGrantStore(store.serialize());
    assert.equal(restored.getById(active.id)?.useCount, 2);
    assert.equal(restored.getById(revoked.id)?.status, "revoked");
    assert.equal(restored.list().length, 2);
  });

  it("rejects a non-array serialized payload", () => {
    assert.throws(() => deserializeAutonomyGrantStore(JSON.stringify({ not: "an array" })), /must be an array/);
  });

  it("rejects an empty string", () => {
    assert.throws(() => deserializeAutonomyGrantStore(""), /is required/);
  });
});
