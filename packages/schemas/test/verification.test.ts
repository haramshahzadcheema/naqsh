import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertCheck,
  assertEvidence,
  createCheck,
  createEvidence,
  createVerificationResult,
  deserializeCheck,
  deserializeVerificationResult,
  serializeCheck,
  serializeVerificationResult,
  WorldModelValidationError,
  type CheckInput,
  type EvidenceInput,
  type VerificationResultInput
} from "../src/index.js";

function numericCheckInput(overrides: Partial<CheckInput> = {}): CheckInput {
  return {
    kind: "numeric_comparison",
    description: "diameter must be <= 20mm",
    objectId: "envobj_1",
    property: "diameter",
    operator: "lte",
    expectedValue: 20,
    ...overrides
  } as CheckInput;
}

describe("Check: numeric_comparison", () => {
  it("creates a valid check with defaults", () => {
    const check = createCheck(numericCheckInput());
    assert.equal(check.kind, "numeric_comparison");
    assert.equal(check.expectedUnit, null);
    assert.equal(check.tolerance, null);
    assert.ok(check.id.startsWith("check_"));
  });

  it("rejects a non-finite expectedValue", () => {
    assert.throws(() => createCheck(numericCheckInput({ expectedValue: Number.NaN } as Partial<CheckInput>)), WorldModelValidationError);
  });

  it("rejects an invalid operator", () => {
    assert.throws(
      () => assertCheck({ id: "check_1", kind: "numeric_comparison", description: "x", objectId: "o", property: "p", operator: "bogus", expectedValue: 1, expectedUnit: null, tolerance: null, createdAt: new Date().toISOString(), metadata: {} }),
      /invalid check.operator/
    );
  });

  it("rejects a negative tolerance", () => {
    assert.throws(() => createCheck(numericCheckInput({ tolerance: -1 } as Partial<CheckInput>)), /tolerance must be a non-negative/);
  });

  it("is frozen -- immutable once created", () => {
    const check = createCheck(numericCheckInput());
    assert.throws(() => {
      (check as { description: string }).description = "tampered";
    }, TypeError);
  });
});

describe("Check: bounds_check", () => {
  function boundsInput(overrides: Partial<CheckInput> = {}): CheckInput {
    return { kind: "bounds_check", description: "thickness in range", objectId: "envobj_1", property: "thickness", min: 2, max: 5, ...overrides } as CheckInput;
  }

  it("creates a valid check, defaulting inclusivity to true", () => {
    const check = createCheck(boundsInput());
    assert.equal(check.kind, "bounds_check");
    if (check.kind === "bounds_check") {
      assert.equal(check.minInclusive, true);
      assert.equal(check.maxInclusive, true);
    }
  });

  it("rejects a check with neither min nor max set", () => {
    assert.throws(() => createCheck(boundsInput({ min: null, max: null } as Partial<CheckInput>)), /at least one of min\/max/);
  });

  it("rejects min > max", () => {
    assert.throws(() => createCheck(boundsInput({ min: 10, max: 1 } as Partial<CheckInput>)), /min must not be greater than/);
  });

  it("accepts a check with only a min (no max)", () => {
    const check = createCheck(boundsInput({ min: 2, max: null } as Partial<CheckInput>));
    if (check.kind === "bounds_check") assert.equal(check.max, null);
  });
});

describe("Check: object_exists / object_type / property_required", () => {
  it("object_exists requires only objectId", () => {
    const check = createCheck({ kind: "object_exists", description: "bracket must exist", objectId: "envobj_1" });
    assert.equal(check.kind, "object_exists");
  });

  it("object_type validates expectedGenericType against the allowlist", () => {
    assert.throws(
      () => createCheck({ kind: "object_type", description: "x", objectId: "envobj_1", expectedGenericType: "not_a_real_type" } as unknown as CheckInput),
      /invalid check.expectedGenericType/
    );
    const check = createCheck({ kind: "object_type", description: "x", objectId: "envobj_1", expectedGenericType: "solid" });
    assert.equal(check.kind, "object_type");
  });

  it("property_required defaults requireNonNull to true", () => {
    const check = createCheck({ kind: "property_required", description: "x", objectId: "envobj_1", property: "material" });
    if (check.kind === "property_required") assert.equal(check.requireNonNull, true);
  });
});

describe("Check: shared invariants", () => {
  it("rejects an unrecognized kind", () => {
    assert.throws(
      () => assertCheck({ id: "check_1", kind: "arbitrary_javascript", description: "x", createdAt: new Date().toISOString(), metadata: {} }),
      /invalid check.kind/
    );
  });

  it("rejects an empty description", () => {
    assert.throws(() => createCheck(numericCheckInput({ description: "" })), /description is required/);
  });

  it("round-trips through JSON with full fidelity", () => {
    const check = createCheck(numericCheckInput({ tolerance: 0.01, expectedUnit: "mm" } as Partial<CheckInput>));
    const restored = deserializeCheck(serializeCheck(check));
    assert.deepEqual(restored, check);
  });

  it("serializeCheck rejects an object that merely LOOKS like a Check but fails validation", () => {
    assert.throws(() => serializeCheck({ kind: "numeric_comparison" } as never), WorldModelValidationError);
  });
});

describe("Evidence: creation and validation", () => {
  function evidenceInput(overrides: Partial<EvidenceInput> = {}): EvidenceInput {
    return { objectId: "envobj_1", objectExists: true, property: "diameter", propertyExists: true, observedValue: 15, stateVersion: 1, ...overrides };
  }

  it("creates valid evidence with defaults -- unset fields are null, never fabricated", () => {
    const evidence = createEvidence({});
    assert.equal(evidence.objectId, null);
    assert.equal(evidence.objectExists, null);
    assert.equal(evidence.unit, null);
    assert.equal(evidence.source, "system");
  });

  it("rejects a non-JSON-safe observedValue", () => {
    assert.throws(() => createEvidence(evidenceInput({ observedValue: () => 1 } as unknown as Partial<EvidenceInput>)), WorldModelValidationError);
  });

  it("rejects a non-positive stateVersion", () => {
    assert.throws(() => createEvidence(evidenceInput({ stateVersion: 0 })), /stateVersion must be a positive integer/);
  });

  it("rejects an invalid observedGenericType", () => {
    assert.throws(() => assertEvidence({ id: "e1", objectId: "o", objectExists: true, observedGenericType: "bogus", property: null, propertyExists: null, observedValue: null, unit: null, observationId: null, stateVersion: null, environmentKind: null, observedAt: new Date().toISOString(), source: "system", metadata: {} }), /observedGenericType/);
  });

  it("is frozen -- immutable once created", () => {
    const evidence = createEvidence(evidenceInput());
    assert.throws(() => {
      (evidence as { observedValue: unknown }).observedValue = 999;
    }, TypeError);
  });
});

describe("VerificationResult: creation and validation", () => {
  function resultInput(overrides: Partial<VerificationResultInput> = {}): VerificationResultInput {
    return {
      checkId: "check_1",
      checkKind: "numeric_comparison",
      status: "pass",
      reasonKind: "satisfied",
      message: "diameter 15mm <= 20mm",
      expected: { operator: "lte", value: 20 },
      actual: 15,
      projectId: "proj_1",
      projectVersion: 1,
      ...overrides
    };
  }

  it("creates a valid result with defaults", () => {
    const result = createVerificationResult(resultInput());
    assert.equal(result.status, "pass");
    assert.equal(result.evidence, null);
    assert.ok(result.id.startsWith("verif_"));
  });

  it("rejects an invalid status", () => {
    assert.throws(() => createVerificationResult(resultInput({ status: "maybe" } as unknown as Partial<VerificationResultInput>)), /invalid verificationResult.status/);
  });

  it("rejects an invalid reasonKind", () => {
    assert.throws(() => createVerificationResult(resultInput({ reasonKind: "because" } as unknown as Partial<VerificationResultInput>)), /invalid verificationResult.reasonKind/);
  });

  it("rejects a non-positive projectVersion", () => {
    assert.throws(() => createVerificationResult(resultInput({ projectVersion: 0 })), /projectVersion must be a positive integer/);
  });

  it("rejects a non-JSON-safe expected/actual value", () => {
    assert.throws(() => createVerificationResult(resultInput({ expected: () => 1 } as unknown as Partial<VerificationResultInput>)), WorldModelValidationError);
  });

  it("embeds and validates evidence when present", () => {
    const evidence = createEvidence({ objectId: "envobj_1", observedValue: 15 });
    const result = createVerificationResult(resultInput({ evidence }));
    assert.deepEqual(result.evidence, evidence);
  });

  it("is frozen -- immutable once created", () => {
    const result = createVerificationResult(resultInput());
    assert.throws(() => {
      (result as { status: string }).status = "fail";
    }, TypeError);
  });

  it("round-trips through JSON with full fidelity, evidence included", () => {
    const evidence = createEvidence({ objectId: "envobj_1", observedValue: 15, stateVersion: 1 });
    const result = createVerificationResult(resultInput({ evidence }));
    const restored = deserializeVerificationResult(serializeVerificationResult(result));
    assert.deepEqual(restored, result);
  });

  it("serializeVerificationResult rejects a malformed object", () => {
    assert.throws(() => serializeVerificationResult({ status: "pass" } as never), WorldModelValidationError);
  });

  it("deserializeVerificationResult rejects corrupted JSON", () => {
    assert.throws(() => deserializeVerificationResult("{not json"), SyntaxError);
  });

  it("deserializeVerificationResult rejects well-formed JSON that fails shape validation", () => {
    assert.throws(() => deserializeVerificationResult(JSON.stringify({ status: "pass" })), WorldModelValidationError);
  });
});
