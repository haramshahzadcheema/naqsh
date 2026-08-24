import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AuthorizationError } from "@naqsh/schemas";
import { createApprovalStore, deserializeApprovalStore } from "../src/approval-store.js";

describe("ApprovalStore: creation", () => {
  it("creates a pending approval", () => {
    const store = createApprovalStore();
    const approval = store.create({ toolName: "modify_parameter" });
    assert.equal(approval.status, "pending");
    assert.equal(store.getById(approval.id), approval);
  });

  it("lists approvals for a specific tool only", () => {
    const store = createApprovalStore();
    store.create({ toolName: "a" });
    store.create({ toolName: "b" });
    store.create({ toolName: "a" });
    assert.equal(store.listForTool("a").length, 2);
    assert.equal(store.listForTool("b").length, 1);
    assert.equal(store.list().length, 3);
  });
});

describe("ApprovalStore: approve/reject/revoke lifecycle", () => {
  it("approves a pending approval", () => {
    const store = createApprovalStore();
    const approval = store.create({ toolName: "modify_parameter" });
    const approved = store.approve(approval.id, "human", "looks safe");
    assert.equal(approved.status, "approved");
    assert.equal(approved.decidedBy, "human");
    assert.equal(approved.reason, "looks safe");
    assert.notEqual(approved.respondedAt, null);
  });

  it("rejects a pending approval", () => {
    const store = createApprovalStore();
    const approval = store.create({ toolName: "modify_parameter" });
    const rejected = store.reject(approval.id, "human", "too risky");
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.reason, "too risky");
  });

  it("cannot approve twice", () => {
    const store = createApprovalStore();
    const approval = store.create({ toolName: "x" });
    store.approve(approval.id, "human");
    assert.throws(
      () => store.approve(approval.id, "human"),
      (error: unknown) => error instanceof AuthorizationError && error.kind === "invalid_state_transition"
    );
  });

  it("cannot reject an already-approved approval", () => {
    const store = createApprovalStore();
    const approval = store.create({ toolName: "x" });
    store.approve(approval.id, "human");
    assert.throws(() => store.reject(approval.id, "human"), AuthorizationError);
  });

  it("revokes an approved approval", () => {
    const store = createApprovalStore();
    const approval = store.create({ toolName: "x" });
    store.approve(approval.id, "human");
    const revoked = store.revoke(approval.id, "human", "changed my mind");
    assert.equal(revoked.status, "revoked");
  });

  it("cannot revoke a pending (never-approved) approval", () => {
    const store = createApprovalStore();
    const approval = store.create({ toolName: "x" });
    assert.throws(() => store.revoke(approval.id, "human"), AuthorizationError);
  });

  it("throws for an unknown approval id", () => {
    const store = createApprovalStore();
    assert.throws(
      () => store.approve("appr_does_not_exist", "human"),
      (error: unknown) => error instanceof AuthorizationError && error.kind === "not_found"
    );
  });
});

describe("ApprovalStore: consumption (single-use)", () => {
  it("marks an approved approval as consumed", () => {
    const store = createApprovalStore();
    const approval = store.create({ toolName: "x" });
    store.approve(approval.id, "human");
    const consumed = store.consume(approval.id);
    assert.notEqual(consumed.consumedAt, null);
  });

  it("cannot consume the same approval twice", () => {
    const store = createApprovalStore();
    const approval = store.create({ toolName: "x" });
    store.approve(approval.id, "human");
    store.consume(approval.id);
    assert.throws(() => store.consume(approval.id), AuthorizationError);
  });

  it("cannot consume a pending (not yet approved) approval", () => {
    const store = createApprovalStore();
    const approval = store.create({ toolName: "x" });
    assert.throws(() => store.consume(approval.id), AuthorizationError);
  });
});

describe("ApprovalStore: serialize/deserializeApprovalStore", () => {
  it("round-trips through serialize/deserialize with full fidelity, including a consumed approval's status", () => {
    const store = createApprovalStore();
    const pending = store.create({ toolName: "a" });
    const approved = store.create({ toolName: "b" });
    store.approve(approved.id, "human");
    store.consume(approved.id);

    const restored = deserializeApprovalStore(store.serialize());
    assert.deepEqual(restored.getById(pending.id), store.getById(pending.id));
    const restoredApproved = restored.getById(approved.id);
    assert.equal(restoredApproved?.status, "approved");
    assert.notEqual(restoredApproved?.consumedAt, null);
  });

  it("rejects a non-array serialized payload", () => {
    assert.throws(() => deserializeApprovalStore(JSON.stringify({ not: "an array" })), /must be an array/);
  });

  it("rejects an empty string", () => {
    assert.throws(() => deserializeApprovalStore(""), /is required/);
  });
});
