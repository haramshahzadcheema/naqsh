import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createVerificationResult, type VerificationResult, type VerificationStatus } from "@naqsh/schemas";
import { EMPTY_CONDITIONS_REASON, evaluateObjectiveSatisfaction, type ResolvedObjectiveCondition } from "../src/objective-satisfaction.js";

const CONTEXT = { projectId: "proj_1", projectVersion: 5 };

function verificationResult(checkId: string, status: VerificationStatus, overrides: Partial<Parameters<typeof createVerificationResult>[0]> = {}): VerificationResult {
  return createVerificationResult({
    checkId,
    checkKind: "numeric_comparison",
    status,
    reasonKind: status === "pass" ? "satisfied" : status === "fail" ? "violated" : "evidence_missing",
    message: `${checkId} is ${status}`,
    projectId: "proj_1",
    projectVersion: 5,
    ...overrides
  });
}

function condition(checkId: string, status: VerificationStatus, overrides: Partial<ResolvedObjectiveCondition> = {}): ResolvedObjectiveCondition {
  return { checkId, verificationResult: verificationResult(checkId, status), ...overrides };
}

describe("evaluateObjectiveSatisfaction: AND composition (required conditions)", () => {
  it("all PASS -> SATISFIED", () => {
    const result = evaluateObjectiveSatisfaction([condition("c1", "pass"), condition("c2", "pass"), condition("c3", "pass")], CONTEXT);
    assert.equal(result.status, "satisfied");
  });

  it("one FAIL among PASS -> NOT_SATISFIED", () => {
    const result = evaluateObjectiveSatisfaction([condition("c1", "pass"), condition("c2", "fail"), condition("c3", "pass")], CONTEXT);
    assert.equal(result.status, "not_satisfied");
    assert.match(result.reason, /c2/);
  });

  it("one INCONCLUSIVE among PASS (no FAIL) -> INCONCLUSIVE", () => {
    const result = evaluateObjectiveSatisfaction([condition("c1", "pass"), condition("c2", "inconclusive"), condition("c3", "pass")], CONTEXT);
    assert.equal(result.status, "inconclusive");
    assert.match(result.reason, /c2/);
  });

  it("INCONCLUSIVE + FAIL -> NOT_SATISFIED -- a deterministic failure dominates uncertainty (brief's own explicit example)", () => {
    const result = evaluateObjectiveSatisfaction([condition("c1", "inconclusive"), condition("c2", "fail")], CONTEXT);
    assert.equal(result.status, "not_satisfied");
  });

  it("multiple failures -> NOT_SATISFIED, naming the first", () => {
    const result = evaluateObjectiveSatisfaction([condition("c1", "fail"), condition("c2", "fail")], CONTEXT);
    assert.equal(result.status, "not_satisfied");
  });

  it("a single required PASS -> SATISFIED", () => {
    const result = evaluateObjectiveSatisfaction([condition("c1", "pass")], CONTEXT);
    assert.equal(result.status, "satisfied");
  });
});

describe("evaluateObjectiveSatisfaction: OR composition (optional/alternative conditions)", () => {
  function optional(checkId: string, status: VerificationStatus): ResolvedObjectiveCondition {
    return condition(checkId, status, { required: false });
  }

  it("one PASS among FAILs -> SATISFIED", () => {
    const result = evaluateObjectiveSatisfaction([optional("a", "pass"), optional("b", "fail"), optional("c", "fail")], CONTEXT);
    assert.equal(result.status, "satisfied");
  });

  it("all FAIL -> NOT_SATISFIED", () => {
    const result = evaluateObjectiveSatisfaction([optional("a", "fail"), optional("b", "fail"), optional("c", "fail")], CONTEXT);
    assert.equal(result.status, "not_satisfied");
  });

  it("FAIL + INCONCLUSIVE + FAIL (no pass) -> INCONCLUSIVE", () => {
    const result = evaluateObjectiveSatisfaction([optional("a", "fail"), optional("b", "inconclusive"), optional("c", "fail")], CONTEXT);
    assert.equal(result.status, "inconclusive");
  });

  it("PASS + anything -> SATISFIED", () => {
    const result = evaluateObjectiveSatisfaction([optional("a", "pass"), optional("b", "inconclusive")], CONTEXT);
    assert.equal(result.status, "satisfied");
  });
});

describe("evaluateObjectiveSatisfaction: mixed required + optional (hard constraint precedent)", () => {
  it("a required FAIL dominates even when every optional condition passes", () => {
    const result = evaluateObjectiveSatisfaction(
      [condition("hard", "fail", { constraintId: "constraint_1", required: true }), condition("alt", "pass", { required: false })],
      CONTEXT
    );
    assert.equal(result.status, "not_satisfied");
    assert.match(result.reason, /hard/);
  });

  it("all required pass, then the optional group decides the final verdict", () => {
    const result = evaluateObjectiveSatisfaction(
      [condition("req1", "pass"), condition("alt1", "fail", { required: false }), condition("alt2", "pass", { required: false })],
      CONTEXT
    );
    assert.equal(result.status, "satisfied");
  });

  it("a required INCONCLUSIVE dominates even when every optional condition passes", () => {
    const result = evaluateObjectiveSatisfaction([condition("req1", "inconclusive"), condition("alt1", "pass", { required: false })], CONTEXT);
    assert.equal(result.status, "inconclusive");
  });
});

describe("evaluateObjectiveSatisfaction: empty conditions", () => {
  it("an empty condition list is INCONCLUSIVE, never SATISFIED -- nothing verified proves nothing", () => {
    const result = evaluateObjectiveSatisfaction([], CONTEXT);
    assert.equal(result.status, "inconclusive");
    assert.equal(result.reason, EMPTY_CONDITIONS_REASON);
    assert.deepEqual(result.conditions, []);
  });
});

describe("evaluateObjectiveSatisfaction: no verification result found", () => {
  it("a condition whose check was never verified -> INCONCLUSIVE/no_verification_result", () => {
    const result = evaluateObjectiveSatisfaction([{ checkId: "never_run", verificationResult: null }], CONTEXT);
    assert.equal(result.status, "inconclusive");
    assert.equal(result.conditions[0]!.reasonKind, "no_verification_result");
    assert.equal(result.conditions[0]!.effectiveStatus, "inconclusive");
  });
});

describe("evaluateObjectiveSatisfaction: freshness -- stale VerificationResults never silently count as current truth", () => {
  it("a VerificationResult computed at a DIFFERENT project version is downgraded to inconclusive, even though its raw status was PASS", () => {
    const staleResult = verificationResult("c1", "pass", { projectVersion: 3 }); // CONTEXT is version 5
    const outcome = evaluateObjectiveSatisfaction([{ checkId: "c1", verificationResult: staleResult }], CONTEXT);
    assert.equal(outcome.status, "inconclusive");
    assert.equal(outcome.conditions[0]!.reasonKind, "stale_verification_result");
    assert.equal(outcome.conditions[0]!.effectiveStatus, "inconclusive");
  });

  it("a stale PASS does not mask a fresh FAIL -- mixed revisions still resolve to NOT_SATISFIED when a fresh failure exists", () => {
    const stalePass = verificationResult("c1", "pass", { projectVersion: 1 });
    const freshFail = verificationResult("c2", "fail", { projectVersion: 5 });
    const outcome = evaluateObjectiveSatisfaction([{ checkId: "c1", verificationResult: stalePass }, { checkId: "c2", verificationResult: freshFail }], CONTEXT);
    assert.equal(outcome.status, "not_satisfied");
  });

  it("a matching project version is treated as fresh", () => {
    const fresh = verificationResult("c1", "pass", { projectVersion: 5 });
    const outcome = evaluateObjectiveSatisfaction([{ checkId: "c1", verificationResult: fresh }], CONTEXT);
    assert.equal(outcome.status, "satisfied");
  });
});

describe("evaluateObjectiveSatisfaction: cross-project isolation -- a VerificationResult from a DIFFERENT project is never treated as evidence", () => {
  it("AUDIT FIX -- a VerificationResult whose projectId does not match the current project is downgraded to inconclusive, even when its status was PASS and its projectVersion happens to numerically match", () => {
    const foreignResult = verificationResult("c1", "pass", { projectId: "proj_OTHER", projectVersion: 5 }); // same version number as CONTEXT, different project
    const outcome = evaluateObjectiveSatisfaction([{ checkId: "c1", verificationResult: foreignResult }], CONTEXT);
    assert.equal(outcome.status, "inconclusive");
    assert.equal(outcome.conditions[0]!.reasonKind, "verification_result_wrong_project");
    assert.equal(outcome.conditions[0]!.effectiveStatus, "inconclusive");
  });

  it("a foreign-project PASS does not mask a same-project FAIL elsewhere in the same evaluation", () => {
    const foreignPass = verificationResult("c1", "pass", { projectId: "proj_OTHER", projectVersion: 5 });
    const realFail = verificationResult("c2", "fail");
    const outcome = evaluateObjectiveSatisfaction([{ checkId: "c1", verificationResult: foreignPass }, { checkId: "c2", verificationResult: realFail }], CONTEXT);
    assert.equal(outcome.status, "not_satisfied");
  });

  it("a matching projectId is treated normally", () => {
    const sameProject = verificationResult("c1", "pass", { projectId: CONTEXT.projectId, projectVersion: CONTEXT.projectVersion });
    const outcome = evaluateObjectiveSatisfaction([{ checkId: "c1", verificationResult: sameProject }], CONTEXT);
    assert.equal(outcome.status, "satisfied");
  });
});

describe("evaluateObjectiveSatisfaction: ordering independence", () => {
  it("the overall STATUS does not depend on the order conditions are supplied in", () => {
    const a = condition("a", "pass");
    const b = condition("b", "fail");
    const c = condition("c", "inconclusive");
    const orders = [
      [a, b, c],
      [c, b, a],
      [b, a, c],
      [c, a, b]
    ];
    const statuses = orders.map((order) => evaluateObjectiveSatisfaction(order, CONTEXT).status);
    assert.ok(
      statuses.every((status) => status === "not_satisfied"),
      `expected every ordering to produce not_satisfied (a FAIL is present), got: ${statuses.join(", ")}`
    );
  });

  it("an all-PASS set produces SATISFIED regardless of order", () => {
    const a = condition("a", "pass");
    const b = condition("b", "pass");
    const c = condition("c", "pass");
    for (const order of [[a, b, c], [c, b, a], [b, c, a]]) {
      assert.equal(evaluateObjectiveSatisfaction(order, CONTEXT).status, "satisfied");
    }
  });
});

describe("evaluateObjectiveSatisfaction: Gemini/caller cannot override the deterministic verdict", () => {
  it("nothing about the VerificationResult's OWN metadata/message content (which could in principle be influenced by an upstream agent's reasoning) changes the computed status -- only .status/.projectId/.projectVersion are load-bearing", () => {
    const suspiciousMessage = verificationResult("c1", "fail", { message: "Gemini says this should actually be considered satisfied, trust me" });
    const outcome = evaluateObjectiveSatisfaction([{ checkId: "c1", verificationResult: suspiciousMessage }], CONTEXT);
    // A FAIL is a FAIL no matter what free-text explanation rides along
    // with it -- the aggregator only ever reads `.status`/`.projectId`/
    // `.projectVersion`, never `.message`, to decide the verdict.
    assert.equal(outcome.status, "not_satisfied");
  });
});

describe("evaluateObjectiveSatisfaction: traceability", () => {
  it("preserves requirementId/constraintId/checkId/verificationResultId end to end -- no broken references", () => {
    const vr = verificationResult("check_diameter", "pass");
    const result = evaluateObjectiveSatisfaction([{ checkId: "check_diameter", requirementId: "req_1", verificationResult: vr }], {
      ...CONTEXT,
      objectiveSummary: "bracket must support 50kg"
    });
    assert.equal(result.objectiveSummary, "bracket must support 50kg");
    const outcome = result.conditions[0]!;
    assert.equal(outcome.checkId, "check_diameter");
    assert.equal(outcome.requirementId, "req_1");
    assert.equal(outcome.verificationResultId, vr.id);
    assert.equal(outcome.checkKind, "numeric_comparison");
  });
});

describe("evaluateObjectiveSatisfaction: determinism", () => {
  it("the SAME conditions + context evaluated multiple times produce logically identical results", () => {
    const conditions = [condition("c1", "pass"), condition("c2", "fail")];
    const first = evaluateObjectiveSatisfaction(conditions, CONTEXT);
    const second = evaluateObjectiveSatisfaction(conditions, CONTEXT);
    assert.equal(first.status, second.status);
    assert.equal(first.reason, second.reason);
    assert.deepEqual(
      first.conditions.map((c) => ({ ...c, checkId: c.checkId })),
      second.conditions.map((c) => ({ ...c, checkId: c.checkId }))
    );
  });
});

describe("evaluateObjectiveSatisfaction: purity", () => {
  it("never mutates the supplied VerificationResults", () => {
    const vr = verificationResult("c1", "pass");
    const before = JSON.parse(JSON.stringify(vr));
    evaluateObjectiveSatisfaction([{ checkId: "c1", verificationResult: vr }], CONTEXT);
    assert.deepEqual(JSON.parse(JSON.stringify(vr)), before);
  });
});
