import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertApproval,
  assertAuthorizationDecision,
  assertAutonomyGrant,
  createApproval,
  createAuthorizationDecision,
  createAutonomyGrant,
  deserializeApproval,
  deserializeAuthorizationDecision,
  deserializeAutonomyGrant,
  serializeApproval,
  serializeAuthorizationDecision,
  serializeAutonomyGrant,
  WorldModelValidationError,
  AUTONOMY_LEVELS
} from "../src/index.js";

describe("AUTONOMY_LEVELS: order is load-bearing (index = rank)", () => {
  it("is exactly the four levels in ascending order of privilege", () => {
    assert.deepEqual(AUTONOMY_LEVELS, ["observe", "suggest", "approved_modify", "autonomous"]);
  });
});

describe("Approval: creation and defaults", () => {
  it("defaults status to pending when not specified, like every other createX factory", () => {
    const approval = createApproval({ toolName: "modify_parameter" });
    assert.equal(approval.status, "pending");
  });

  it("still honors an explicit status -- ApprovalStore's own transitions rely on this", () => {
    const approval = createApproval({ toolName: "modify_parameter", status: "approved" });
    assert.equal(approval.status, "approved");
  });

  it("defaults targetType/targetId to null (covers any target)", () => {
    const approval = createApproval({ toolName: "modify_parameter" });
    assert.equal(approval.targetType, null);
    assert.equal(approval.targetId, null);
    assert.equal(approval.decidedBy, null);
    assert.equal(approval.respondedAt, null);
    assert.equal(approval.consumedAt, null);
  });

  it("preserves an explicit target scope", () => {
    const approval = createApproval({
      toolName: "modify_parameter",
      targetType: "engineering_object",
      targetId: "obj_5"
    });
    assert.equal(approval.targetType, "engineering_object");
    assert.equal(approval.targetId, "obj_5");
  });

  it("rejects an empty toolName", () => {
    assert.throws(() => createApproval({ toolName: "" }), /approval.toolName is required/);
  });

  it("rejects a function hidden in metadata", () => {
    assert.throws(
      () => createApproval({ toolName: "x", metadata: { cb: () => {} } }),
      /approval.metadata must be a JSON-serializable object/
    );
  });

  it("freezes the returned approval", () => {
    const approval = createApproval({ toolName: "x" });
    assert.throws(() => {
      (approval as { status: string }).status = "approved";
    }, TypeError);
  });

  it("round-trips through JSON with full fidelity", () => {
    const approval = createApproval({
      toolName: "modify_parameter",
      targetType: "engineering_object",
      targetId: "obj_5",
      requestedBy: "agent",
      reason: "Reduce wall thickness to hit the mass target."
    });
    assert.deepEqual(deserializeApproval(serializeApproval(approval)), approval);
  });
});

describe("AutonomyGrant: creation and defaults", () => {
  it("defaults status to active when not specified, like every other createX factory", () => {
    const grant = createAutonomyGrant({ toolNames: ["inspect_project"] });
    assert.equal(grant.status, "active");
  });

  it("still honors an explicit status -- AutonomyGrantStore's own transitions rely on this", () => {
    const grant = createAutonomyGrant({ toolNames: ["inspect_project"], status: "revoked" });
    assert.equal(grant.status, "revoked");
  });

  it("defaults useCount to 0 and maxUses to null", () => {
    const grant = createAutonomyGrant({ toolNames: ["inspect_project"] });
    assert.equal(grant.useCount, 0);
    assert.equal(grant.maxUses, null);
  });

  it("rejects an empty toolNames array (autonomy must be scoped, never a wildcard)", () => {
    assert.throws(
      () => createAutonomyGrant({ toolNames: [] }),
      /toolNames must be a non-empty array/
    );
  });

  it("rejects a non-positive maxUses", () => {
    assert.throws(
      () => createAutonomyGrant({ toolNames: ["x"], maxUses: 0 }),
      /maxUses must be a positive integer or null/
    );
  });

  it("freezes the returned grant", () => {
    const grant = createAutonomyGrant({ toolNames: ["x"] });
    assert.throws(() => {
      (grant as { useCount: number }).useCount = 99;
    }, TypeError);
  });

  it("REGRESSION: toolNames is deep-frozen, not just the top-level grant -- pushing onto it must not silently expand what the grant authorizes", () => {
    // Confirmed exploitable during the P0-P8 audit: AutonomyGrantStore hands
    // out this exact object reference from create()/getById()/list() with no
    // defensive copy, and evaluateAutonomyGrant reads grant.toolNames.includes(...)
    // directly -- so an unfrozen array let a caller silently escalate an
    // already-active grant's scope with no new Change, no revoke/recreate.
    const grant = createAutonomyGrant({ toolNames: ["safe_tool"] });
    assert.throws(() => {
      (grant.toolNames as string[]).push("dangerous_tool");
    }, TypeError);
    assert.deepEqual(grant.toolNames, ["safe_tool"]);
  });

  it("round-trips through JSON with full fidelity", () => {
    const grant = createAutonomyGrant({
      toolNames: ["inspect_project", "run_verification"],
      targetType: "project",
      grantedBy: "human",
      reason: "Overnight verification sweep",
      maxUses: 20,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString()
    });
    assert.deepEqual(deserializeAutonomyGrant(serializeAutonomyGrant(grant)), grant);
  });

  it("defaults revokedBy to null and preserves it once set (mirrors Approval.decidedBy)", () => {
    const grant = createAutonomyGrant({ toolNames: ["x"] });
    assert.equal(grant.revokedBy, null);

    const revoked = createAutonomyGrant({ ...grant, status: "revoked", revokedBy: "human" });
    assert.equal(revoked.revokedBy, "human");
  });

  it("rejects an invalid revokedBy value", () => {
    assert.throws(
      () => createAutonomyGrant({ toolNames: ["x"], revokedBy: "not_a_real_source" as never }),
      /autonomyGrant.revokedBy must be a valid source or null/
    );
  });
});

describe("Direct assertApproval / assertAutonomyGrant validation", () => {
  it("assertApproval accepts a well-formed approval and rejects a malformed one", () => {
    const approval = createApproval({ toolName: "x" });
    assert.doesNotThrow(() => assertApproval(approval));
    assert.throws(() => assertApproval({ ...approval, status: "bogus" }), /invalid approval status/);
  });

  it("assertAutonomyGrant accepts a well-formed grant and rejects a malformed one", () => {
    const grant = createAutonomyGrant({ toolNames: ["x"] });
    assert.doesNotThrow(() => assertAutonomyGrant(grant));
    assert.throws(() => assertAutonomyGrant({ ...grant, toolNames: [] }), /toolNames must be a non-empty array/);
  });
});

describe("AuthorizationDecision: creation and validation", () => {
  it("forces denialReason to null when allowed is true, even if one was passed", () => {
    const decision = createAuthorizationDecision({
      toolName: "inspect_project",
      target: null,
      autonomyLevel: "observe",
      source: "agent",
      requestId: "treq_1",
      allowed: true,
      denialReason: "insufficient_autonomy_level"
    });
    assert.equal(decision.denialReason, null);
  });

  it("requires a denialReason when allowed is false", () => {
    assert.throws(
      () =>
        assertAuthorizationDecision({
          ...createAuthorizationDecision({
            toolName: "x",
            target: null,
            autonomyLevel: "observe",
            source: "agent",
            requestId: "treq_1",
            allowed: true
          }),
          allowed: false,
          denialReason: null
        }),
      /invalid authorization denial reason/
    );
  });

  it("accepts an unrecognized autonomyLevel string without throwing (it's exactly what unknown_autonomy_level records)", () => {
    assert.doesNotThrow(() =>
      createAuthorizationDecision({
        toolName: "x",
        target: null,
        autonomyLevel: "godmode",
        source: "agent",
        requestId: "treq_1",
        allowed: false,
        denialReason: "unknown_autonomy_level",
        message: '"godmode" is not a recognized autonomy level'
      })
    );
  });

  it("validates a non-null target against ChangeTarget's shape", () => {
    assert.throws(
      () =>
        createAuthorizationDecision({
          toolName: "x",
          target: { entityType: "", entityId: null } as never,
          autonomyLevel: "observe",
          source: "agent",
          requestId: "treq_1",
          allowed: true
        }),
      /change target.entityType is required/
    );
  });

  it("throws WorldModelValidationError specifically", () => {
    assert.throws(
      () =>
        createAuthorizationDecision({
          toolName: "",
          target: null,
          autonomyLevel: "observe",
          source: "agent",
          requestId: "treq_1",
          allowed: true
        }),
      WorldModelValidationError
    );
  });

  it("round-trips through JSON with full fidelity", () => {
    const decision = createAuthorizationDecision({
      toolName: "modify_parameter",
      target: { entityType: "engineering_object", entityId: "obj_5" },
      autonomyLevel: "approved_modify",
      source: "agent",
      requestId: "treq_1",
      allowed: false,
      denialReason: "approval_not_found",
      message: 'No approval exists for tool "modify_parameter"'
    });
    assert.deepEqual(deserializeAuthorizationDecision(serializeAuthorizationDecision(decision)), decision);
  });
});
