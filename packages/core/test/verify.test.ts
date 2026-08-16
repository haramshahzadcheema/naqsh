import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCheck, createEvidence, type Check, type CheckInput, type Evidence } from "@naqsh/schemas";
import { compareNumeric, evaluateCheck, type EvaluateCheckContext } from "../src/verify.js";

const CONTEXT: EvaluateCheckContext = { projectId: "proj_1", projectVersion: 3 };

function check(input: CheckInput): Check {
  return createCheck(input);
}

function evidence(overrides: Partial<Parameters<typeof createEvidence>[0]> = {}): Evidence {
  return createEvidence({ stateVersion: 3, environmentKind: "mock_cad", ...overrides });
}

describe("evaluateCheck: no evidence -> always INCONCLUSIVE, never PASS", () => {
  it("null evidence produces inconclusive/evidence_missing for every check kind", () => {
    const kinds: Check[] = [
      check({ kind: "object_exists", description: "x", objectId: "o1" }),
      check({ kind: "object_type", description: "x", objectId: "o1", expectedGenericType: "solid" }),
      check({ kind: "property_required", description: "x", objectId: "o1", property: "p" }),
      check({ kind: "numeric_comparison", description: "x", objectId: "o1", property: "p", operator: "eq", expectedValue: 1 }),
      check({ kind: "bounds_check", description: "x", objectId: "o1", property: "p", min: 0, max: 10 })
    ];
    for (const c of kinds) {
      const result = evaluateCheck(c, null, CONTEXT);
      assert.equal(result.status, "inconclusive", `expected inconclusive for ${c.kind}`);
      assert.equal(result.reasonKind, "evidence_missing");
      assert.equal(result.actual, null);
    }
  });
});

describe("evaluateCheck: freshness -- stale evidence never silently produces PASS", () => {
  it("evidence.stateVersion mismatching the current project version -> inconclusive/evidence_stale, even though the raw value would satisfy the check", () => {
    const c = check({ kind: "numeric_comparison", description: "diameter <= 20", objectId: "o1", property: "diameter", operator: "lte", expectedValue: 20 });
    const staleEvidence = evidence({ objectId: "o1", objectExists: true, property: "diameter", propertyExists: true, observedValue: 10, stateVersion: 1 });
    const result = evaluateCheck(c, staleEvidence, { ...CONTEXT, projectVersion: 3 });
    assert.equal(result.status, "inconclusive");
    assert.equal(result.reasonKind, "evidence_stale");
  });

  it("evidence.stateVersion === null (unknown) is treated as compatible -- not every evidence source tracks a version", () => {
    const c = check({ kind: "object_exists", description: "x", objectId: "o1" });
    const result = evaluateCheck(c, evidence({ objectId: "o1", objectExists: true, stateVersion: null }), CONTEXT);
    assert.equal(result.status, "pass");
  });

  it("evidence.stateVersion === current version passes the freshness gate", () => {
    const c = check({ kind: "object_exists", description: "x", objectId: "o1" });
    const result = evaluateCheck(c, evidence({ objectId: "o1", objectExists: true, stateVersion: 3 }), CONTEXT);
    assert.equal(result.status, "pass");
  });
});

describe("evaluateCheck: target mismatch -- evidence about a different object is never silently accepted", () => {
  it("evidence.objectId !== check.objectId -> inconclusive/evidence_target_mismatch", () => {
    const c = check({ kind: "object_exists", description: "x", objectId: "o1" });
    const wrongObjectEvidence = evidence({ objectId: "o2", objectExists: true });
    const result = evaluateCheck(c, wrongObjectEvidence, CONTEXT);
    assert.equal(result.status, "inconclusive");
    assert.equal(result.reasonKind, "evidence_target_mismatch");
  });

  it("AUDIT FIX -- evidence.property !== check.property -> inconclusive/evidence_target_mismatch, even for the RIGHT object (evidence about an unrelated property must never be silently read as this check's property)", () => {
    const c = check({ kind: "numeric_comparison", description: "diameter <= 20", objectId: "o1", property: "diameter", operator: "lte", expectedValue: 20 });
    // Evidence correctly identifies o1, but reports a value for a
    // DIFFERENT property ("width") -- observedValue: 5 would satisfy the
    // check if it were silently treated as "diameter", which must not
    // happen.
    const wrongPropertyEvidence = evidence({ objectId: "o1", objectExists: true, property: "width", propertyExists: true, observedValue: 5 });
    const result = evaluateCheck(c, wrongPropertyEvidence, CONTEXT);
    assert.equal(result.status, "inconclusive");
    assert.equal(result.reasonKind, "evidence_target_mismatch");
  });

  it("evidence.property === null (unknown) is treated as compatible -- object_exists/object_type evidence legitimately carries no property", () => {
    const c = check({ kind: "object_exists", description: "x", objectId: "o1" });
    const result = evaluateCheck(c, evidence({ objectId: "o1", objectExists: true, property: null }), CONTEXT);
    assert.equal(result.status, "pass");
  });
});

describe("evaluateCheck: object_exists", () => {
  const c = check({ kind: "object_exists", description: "bracket exists", objectId: "envobj_1" });

  it("PASS: evidence confirms the object exists", () => {
    const result = evaluateCheck(c, evidence({ objectId: "envobj_1", objectExists: true }), CONTEXT);
    assert.equal(result.status, "pass");
    assert.equal(result.reasonKind, "satisfied");
    assert.equal((result.expected as { exists: boolean }).exists, true);
  });

  it("FAIL: evidence confirms the object does NOT exist -- a definitive, deterministic no", () => {
    const result = evaluateCheck(c, evidence({ objectId: "envobj_1", objectExists: false }), CONTEXT);
    assert.equal(result.status, "fail");
    assert.equal(result.reasonKind, "object_not_found");
  });

  it("INCONCLUSIVE: evidence doesn't report existence at all", () => {
    const result = evaluateCheck(c, evidence({ objectId: "envobj_1", objectExists: null }), CONTEXT);
    assert.equal(result.status, "inconclusive");
    assert.equal(result.reasonKind, "evidence_missing");
  });
});

describe("evaluateCheck: object_type", () => {
  const c = check({ kind: "object_type", description: "must be a solid", objectId: "envobj_1", expectedGenericType: "solid" });

  it("PASS: observed type matches", () => {
    const result = evaluateCheck(c, evidence({ objectId: "envobj_1", objectExists: true, observedGenericType: "solid" }), CONTEXT);
    assert.equal(result.status, "pass");
  });

  it("FAIL: observed type does not match", () => {
    const result = evaluateCheck(c, evidence({ objectId: "envobj_1", objectExists: true, observedGenericType: "sketch" }), CONTEXT);
    assert.equal(result.status, "fail");
    assert.equal(result.reasonKind, "violated");
    assert.equal(result.actual, "sketch");
  });

  it("FAIL: object does not exist", () => {
    const result = evaluateCheck(c, evidence({ objectId: "envobj_1", objectExists: false }), CONTEXT);
    assert.equal(result.status, "fail");
    assert.equal(result.reasonKind, "object_not_found");
  });

  it("INCONCLUSIVE: no observed type reported", () => {
    const result = evaluateCheck(c, evidence({ objectId: "envobj_1", objectExists: true, observedGenericType: null }), CONTEXT);
    assert.equal(result.status, "inconclusive");
  });
});

describe("evaluateCheck: property_required", () => {
  const c = check({ kind: "property_required", description: "material must be set", objectId: "envobj_1", property: "material" });

  it("PASS: property present and non-null", () => {
    const result = evaluateCheck(c, evidence({ objectId: "envobj_1", objectExists: true, property: "material", propertyExists: true, observedValue: "steel" }), CONTEXT);
    assert.equal(result.status, "pass");
  });

  it("FAIL: property present but null (requireNonNull defaults to true)", () => {
    const result = evaluateCheck(c, evidence({ objectId: "envobj_1", objectExists: true, property: "material", propertyExists: true, observedValue: null }), CONTEXT);
    assert.equal(result.status, "fail");
    assert.equal(result.reasonKind, "violated");
  });

  it("PASS: property present but null, when requireNonNull is false", () => {
    const lenient = check({ kind: "property_required", description: "x", objectId: "envobj_1", property: "material", requireNonNull: false });
    const result = evaluateCheck(lenient, evidence({ objectId: "envobj_1", objectExists: true, property: "material", propertyExists: true, observedValue: null }), CONTEXT);
    assert.equal(result.status, "pass");
  });

  it("FAIL: property confirmed absent", () => {
    const result = evaluateCheck(c, evidence({ objectId: "envobj_1", objectExists: true, property: "material", propertyExists: false }), CONTEXT);
    assert.equal(result.status, "fail");
    assert.equal(result.reasonKind, "property_not_found");
  });

  it("FAIL: object itself does not exist", () => {
    const result = evaluateCheck(c, evidence({ objectId: "envobj_1", objectExists: false }), CONTEXT);
    assert.equal(result.status, "fail");
    assert.equal(result.reasonKind, "object_not_found");
  });

  it("INCONCLUSIVE: evidence doesn't report whether the property is present", () => {
    const result = evaluateCheck(c, evidence({ objectId: "envobj_1", objectExists: true, property: "material", propertyExists: null }), CONTEXT);
    assert.equal(result.status, "inconclusive");
    assert.equal(result.reasonKind, "evidence_missing");
  });
});

describe("evaluateCheck: numeric_comparison", () => {
  function numeric(overrides: Partial<CheckInput> = {}): Check {
    return check({ kind: "numeric_comparison", description: "x", objectId: "envobj_1", property: "diameter", operator: "lte", expectedValue: 20, ...overrides } as CheckInput);
  }

  it("PASS: exact boundary value with lte", () => {
    const result = evaluateCheck(numeric(), evidence({ objectId: "envobj_1", objectExists: true, property: "diameter", propertyExists: true, observedValue: 20 }), CONTEXT);
    assert.equal(result.status, "pass");
    assert.equal(result.actual, 20);
  });

  it("FAIL: value violates the bound", () => {
    const result = evaluateCheck(numeric(), evidence({ objectId: "envobj_1", objectExists: true, property: "diameter", propertyExists: true, observedValue: 24 }), CONTEXT);
    assert.equal(result.status, "fail");
    assert.equal(result.reasonKind, "violated");
    assert.equal(result.actual, 24);
  });

  it("every operator: eq/neq/lt/lte/gt/gte all evaluate correctly", () => {
    const cases: Array<["eq" | "neq" | "lt" | "lte" | "gt" | "gte", number, number, boolean]> = [
      ["eq", 10, 10, true],
      ["eq", 10, 11, false],
      ["neq", 10, 11, true],
      ["neq", 10, 10, false],
      ["lt", 9, 10, true],
      ["lt", 10, 10, false],
      ["lte", 10, 10, true],
      ["lte", 11, 10, false],
      ["gt", 11, 10, true],
      ["gt", 10, 10, false],
      ["gte", 10, 10, true],
      ["gte", 9, 10, false]
    ];
    for (const [operator, observed, expectedValue, shouldPass] of cases) {
      const c = numeric({ operator, expectedValue });
      const result = evaluateCheck(c, evidence({ objectId: "envobj_1", objectExists: true, property: "diameter", propertyExists: true, observedValue: observed }), CONTEXT);
      assert.equal(result.status, shouldPass ? "pass" : "fail", `operator ${operator}: observed=${observed} expected=${expectedValue}`);
    }
  });

  it("FLOATING POINT: 0.1 + 0.2 style noise does not cause a false FAIL when an explicit tolerance is set", () => {
    const c = numeric({ operator: "eq", expectedValue: 0.3, tolerance: 1e-9 });
    const observed = 0.1 + 0.2; // 0.30000000000000004
    const result = evaluateCheck(c, evidence({ objectId: "envobj_1", objectExists: true, property: "diameter", propertyExists: true, observedValue: observed }), CONTEXT);
    assert.equal(result.status, "pass");
  });

  it("FLOATING POINT: the exact same float noise DOES cause a FAIL with no tolerance (tolerance is explicit, never a hidden default)", () => {
    const c = numeric({ operator: "eq", expectedValue: 0.3, tolerance: null });
    const observed = 0.1 + 0.2;
    const result = evaluateCheck(c, evidence({ objectId: "envobj_1", objectExists: true, property: "diameter", propertyExists: true, observedValue: observed }), CONTEXT);
    assert.equal(result.status, "fail");
  });

  it("INCONCLUSIVE: observedValue is not a finite number", () => {
    const result = evaluateCheck(numeric(), evidence({ objectId: "envobj_1", objectExists: true, property: "diameter", propertyExists: true, observedValue: "twenty" }), CONTEXT);
    assert.equal(result.status, "inconclusive");
    assert.equal(result.reasonKind, "invalid_evidence_value");
  });

  it("INCONCLUSIVE: check requires a unit but evidence reports none -- never silently assumed compatible", () => {
    const c = numeric({ expectedUnit: "mm" });
    const result = evaluateCheck(c, evidence({ objectId: "envobj_1", objectExists: true, property: "diameter", propertyExists: true, observedValue: 15, unit: null }), CONTEXT);
    assert.equal(result.status, "inconclusive");
    assert.equal(result.reasonKind, "unit_mismatch");
  });

  it("INCONCLUSIVE: check requires mm, evidence reports cm -- NAQSH does not convert units", () => {
    const c = numeric({ expectedUnit: "mm" });
    const result = evaluateCheck(c, evidence({ objectId: "envobj_1", objectExists: true, property: "diameter", propertyExists: true, observedValue: 15, unit: "cm" }), CONTEXT);
    assert.equal(result.status, "inconclusive");
    assert.equal(result.reasonKind, "unit_mismatch");
  });

  it("PASS: matching units are accepted", () => {
    const c = numeric({ expectedUnit: "mm", expectedValue: 20 });
    const result = evaluateCheck(c, evidence({ objectId: "envobj_1", objectExists: true, property: "diameter", propertyExists: true, observedValue: 15, unit: "mm" }), CONTEXT);
    assert.equal(result.status, "pass");
  });

  it("FAIL: property confirmed absent on an existing object", () => {
    const result = evaluateCheck(numeric(), evidence({ objectId: "envobj_1", objectExists: true, property: "diameter", propertyExists: false }), CONTEXT);
    assert.equal(result.status, "fail");
    assert.equal(result.reasonKind, "property_not_found");
  });
});

describe("evaluateCheck: bounds_check", () => {
  function bounds(overrides: Partial<CheckInput> = {}): Check {
    return check({ kind: "bounds_check", description: "x", objectId: "envobj_1", property: "thickness", min: 2, max: 5, ...overrides } as CheckInput);
  }

  it("PASS: value strictly within [min, max]", () => {
    const result = evaluateCheck(bounds(), evidence({ objectId: "envobj_1", objectExists: true, property: "thickness", propertyExists: true, observedValue: 3.5 }), CONTEXT);
    assert.equal(result.status, "pass");
  });

  it("PASS: value exactly at an inclusive boundary", () => {
    const result = evaluateCheck(bounds(), evidence({ objectId: "envobj_1", objectExists: true, property: "thickness", propertyExists: true, observedValue: 5 }), CONTEXT);
    assert.equal(result.status, "pass");
  });

  it("FAIL: value exactly at an EXCLUSIVE boundary", () => {
    const c = bounds({ maxInclusive: false });
    const result = evaluateCheck(c, evidence({ objectId: "envobj_1", objectExists: true, property: "thickness", propertyExists: true, observedValue: 5 }), CONTEXT);
    assert.equal(result.status, "fail");
  });

  it("FAIL: value below min", () => {
    const result = evaluateCheck(bounds(), evidence({ objectId: "envobj_1", objectExists: true, property: "thickness", propertyExists: true, observedValue: 1 }), CONTEXT);
    assert.equal(result.status, "fail");
    assert.equal(result.reasonKind, "violated");
  });

  it("FAIL: value above max", () => {
    const result = evaluateCheck(bounds(), evidence({ objectId: "envobj_1", objectExists: true, property: "thickness", propertyExists: true, observedValue: 9 }), CONTEXT);
    assert.equal(result.status, "fail");
  });

  it("a bound with only min set has no upper limit", () => {
    const c = bounds({ min: 2, max: null });
    const result = evaluateCheck(c, evidence({ objectId: "envobj_1", objectExists: true, property: "thickness", propertyExists: true, observedValue: 1000 }), CONTEXT);
    assert.equal(result.status, "pass");
  });

  it("INCONCLUSIVE: non-numeric observed value", () => {
    const result = evaluateCheck(bounds(), evidence({ objectId: "envobj_1", objectExists: true, property: "thickness", propertyExists: true, observedValue: null }), CONTEXT);
    assert.equal(result.status, "inconclusive");
    assert.equal(result.reasonKind, "invalid_evidence_value");
  });

  it("INCONCLUSIVE: unit mismatch", () => {
    const c = bounds({ unit: "mm" });
    const result = evaluateCheck(c, evidence({ objectId: "envobj_1", objectExists: true, property: "thickness", propertyExists: true, observedValue: 3, unit: "in" }), CONTEXT);
    assert.equal(result.status, "inconclusive");
    assert.equal(result.reasonKind, "unit_mismatch");
  });
});

describe("evaluateCheck: determinism", () => {
  it("the SAME check + evidence + context evaluated multiple times produces logically identical results", () => {
    const c = check({ kind: "numeric_comparison", description: "x", objectId: "envobj_1", property: "diameter", operator: "lte", expectedValue: 20 });
    const e = evidence({ objectId: "envobj_1", objectExists: true, property: "diameter", propertyExists: true, observedValue: 15 });
    const first = evaluateCheck(c, e, CONTEXT);
    const second = evaluateCheck(c, e, CONTEXT);
    assert.equal(first.status, second.status);
    assert.equal(first.reasonKind, second.reasonKind);
    assert.equal(first.message, second.message);
    assert.deepEqual(first.expected, second.expected);
    assert.deepEqual(first.actual, second.actual);
    // ids and evaluatedAt are allowed to differ -- every evaluation
    // produces its own durable record -- but the OUTCOME never does.
  });
});

describe("evaluateCheck: purity -- never mutates its inputs", () => {
  it("the Check and Evidence objects are byte-for-byte unchanged after evaluation (they are frozen, so this also proves no accidental write was even attempted)", () => {
    const c = check({ kind: "numeric_comparison", description: "x", objectId: "envobj_1", property: "diameter", operator: "lte", expectedValue: 20 });
    const e = evidence({ objectId: "envobj_1", objectExists: true, property: "diameter", propertyExists: true, observedValue: 15 });
    const checkBefore = JSON.parse(JSON.stringify(c));
    const evidenceBefore = JSON.parse(JSON.stringify(e));
    evaluateCheck(c, e, CONTEXT);
    assert.deepEqual(JSON.parse(JSON.stringify(c)), checkBefore);
    assert.deepEqual(JSON.parse(JSON.stringify(e)), evidenceBefore);
  });
});

describe("compareNumeric: explicit, documented tolerance semantics", () => {
  it("eq/neq use a symmetric |actual - expected| <= tolerance window", () => {
    assert.equal(compareNumeric("eq", 10.0005, 10, 0.001), true);
    assert.equal(compareNumeric("eq", 10.002, 10, 0.001), false);
    assert.equal(compareNumeric("neq", 10.002, 10, 0.001), true);
  });

  it("lt/lte/gt/gte widen the boundary in the permissive direction by tolerance", () => {
    assert.equal(compareNumeric("lt", 10.0005, 10, 0.001), true);
    assert.equal(compareNumeric("gt", 9.9995, 10, 0.001), true);
  });

  it("a null tolerance behaves as exact comparison (tolerance 0)", () => {
    assert.equal(compareNumeric("eq", 10.0001, 10, null), false);
    assert.equal(compareNumeric("eq", 10, 10, null), true);
  });
});
