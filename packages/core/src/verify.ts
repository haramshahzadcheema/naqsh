import {
  createVerificationResult,
  type BoundsCheck,
  type Check,
  type Evidence,
  type NumericComparisonCheck,
  type NumericComparisonOperator,
  type ObjectExistsCheck,
  type ObjectTypeCheck,
  type PropertyRequiredCheck,
  type VerificationReasonKind,
  type VerificationResult,
  type VerificationStatus
} from "@naqsh/schemas";

/**
 * Phase 16: DETERMINISTIC VERIFICATION.
 *
 * `evaluateCheck` is THE verifier -- a PURE function of (check, evidence,
 * context). Same inputs always produce the same status/reasonKind/expected/
 * actual (the only thing that varies run-to-run is `evaluatedAt`/`id`,
 * neither of which ever influences the OUTCOME). It does not:
 *   - call Gemini or any model provider,
 *   - make a network call,
 *   - call an EnvironmentAdapter (observing happens BEFORE this runs, in
 *     run-verification-tool.ts, which builds Evidence and hands it here),
 *   - mutate the World Model, the environment, or a checkpoint,
 *   - read any module-level or global mutable state.
 *
 * It must NOT infer correctness from `tool.success === true` -- this file
 * never even sees a ToolResult; it only ever sees a `Check` (a rule) and
 * `Evidence` (an observation), which is the whole point: a tool reporting
 * "I ran" is a completely different claim from "the condition now holds,"
 * and only the latter is this function's job to determine.
 */

export interface EvaluateCheckContext {
  projectId: string;
  /** The CURRENT project version being verified against -- compared
   * against `evidence.stateVersion` to detect staleness (Phase 16's "stale
   * evidence must never silently produce PASS" requirement). */
  projectVersion: number;
  environmentKind?: string | null;
  documentName?: string | null;
}

interface Outcome {
  status: VerificationStatus;
  reasonKind: VerificationReasonKind;
  message: string;
  expected: unknown;
  actual: unknown;
}

function inconclusive(reasonKind: VerificationReasonKind, message: string, expected: unknown, actual: unknown = null): Outcome {
  return { status: "inconclusive", reasonKind, message, expected, actual };
}

function pass(message: string, expected: unknown, actual: unknown): Outcome {
  return { status: "pass", reasonKind: "satisfied", message, expected, actual };
}

function fail(reasonKind: "violated" | "object_not_found" | "property_not_found", message: string, expected: unknown, actual: unknown): Outcome {
  return { status: "fail", reasonKind, message, expected, actual };
}

function describeExpected(check: Check): unknown {
  switch (check.kind) {
    case "object_exists":
      return { objectId: check.objectId, exists: true };
    case "object_type":
      return { objectId: check.objectId, genericType: check.expectedGenericType };
    case "property_required":
      return { objectId: check.objectId, property: check.property, present: true, nonNull: check.requireNonNull };
    case "numeric_comparison":
      return { objectId: check.objectId, property: check.property, operator: check.operator, value: check.expectedValue, unit: check.expectedUnit, tolerance: check.tolerance };
    case "bounds_check":
      return {
        objectId: check.objectId,
        property: check.property,
        min: check.min,
        max: check.max,
        minInclusive: check.minInclusive,
        maxInclusive: check.maxInclusive,
        unit: check.unit
      };
  }
}

/**
 * Explicit, deterministic tolerance semantics (Phase 16's own "no hidden
 * epsilon" requirement -- `tolerance` is a real field on the Check, always
 * visible in `expected`, never a silently baked-in constant like `1e-9`).
 * `tolerance` defaults to `0` (exact comparison) when the Check doesn't
 * set one.
 *
 *   eq:  |actual - expected| <= tolerance
 *   neq: |actual - expected| >  tolerance
 *   lt:  actual <  expected + tolerance
 *   lte: actual <= expected + tolerance
 *   gt:  actual >  expected - tolerance
 *   gte: actual >= expected - tolerance
 *
 * For `lt`/`lte`/`gt`/`gte`, tolerance widens the boundary in the
 * PERMISSIVE direction (the same direction the classic `0.1 + 0.2 !==
 * 0.3` float-noise problem bites) -- a value that is "supposed to" satisfy
 * the comparison but misses by less than `tolerance` due to floating-point
 * representation still passes.
 */
export function compareNumeric(operator: NumericComparisonOperator, actual: number, expected: number, tolerance: number | null): boolean {
  const tol = tolerance ?? 0;
  switch (operator) {
    case "eq":
      return Math.abs(actual - expected) <= tol;
    case "neq":
      return Math.abs(actual - expected) > tol;
    case "lt":
      return actual < expected + tol;
    case "lte":
      return actual <= expected + tol;
    case "gt":
      return actual > expected - tol;
    case "gte":
      return actual >= expected - tol;
  }
}

function evaluateObjectExists(check: ObjectExistsCheck, evidence: Evidence): Outcome {
  if (evidence.objectExists === null) {
    return inconclusive("evidence_missing", `Evidence for check "${check.id}" does not report whether object "${check.objectId}" exists`, describeExpected(check));
  }
  return evidence.objectExists
    ? pass(`Object "${check.objectId}" exists`, describeExpected(check), true)
    : fail("object_not_found", `Object "${check.objectId}" does not exist`, describeExpected(check), false);
}

function evaluateObjectType(check: ObjectTypeCheck, evidence: Evidence): Outcome {
  if (evidence.objectExists === false) {
    return fail("object_not_found", `Object "${check.objectId}" does not exist`, describeExpected(check), null);
  }
  if (evidence.observedGenericType === null) {
    return inconclusive("evidence_missing", `Evidence for check "${check.id}" does not report an observed type for object "${check.objectId}"`, describeExpected(check));
  }
  return evidence.observedGenericType === check.expectedGenericType
    ? pass(`Object "${check.objectId}" has type "${check.expectedGenericType}"`, describeExpected(check), evidence.observedGenericType)
    : fail(
        "violated",
        `Object "${check.objectId}" has type "${evidence.observedGenericType}", expected "${check.expectedGenericType}"`,
        describeExpected(check),
        evidence.observedGenericType
      );
}

function evaluatePropertyRequired(check: PropertyRequiredCheck, evidence: Evidence): Outcome {
  if (evidence.objectExists === false) {
    return fail("object_not_found", `Object "${check.objectId}" does not exist`, describeExpected(check), null);
  }
  if (evidence.propertyExists === null) {
    return inconclusive(
      "evidence_missing",
      `Evidence for check "${check.id}" does not report whether property "${check.property}" is present on object "${check.objectId}"`,
      describeExpected(check)
    );
  }
  if (!evidence.propertyExists) {
    return fail("property_not_found", `Property "${check.property}" is not present on object "${check.objectId}"`, describeExpected(check), false);
  }
  if (check.requireNonNull && (evidence.observedValue === null || evidence.observedValue === undefined)) {
    return fail("violated", `Property "${check.property}" on object "${check.objectId}" is present but null`, describeExpected(check), evidence.observedValue ?? null);
  }
  return pass(`Property "${check.property}" on object "${check.objectId}" is present${check.requireNonNull ? " and non-null" : ""}`, describeExpected(check), true);
}

function checkUnitCompatible(expectedUnit: string | null, evidenceUnit: string | null): boolean {
  return expectedUnit === null || evidenceUnit === expectedUnit;
}

function evaluateNumericComparison(check: NumericComparisonCheck, evidence: Evidence): Outcome {
  if (evidence.objectExists === false) {
    return fail("object_not_found", `Object "${check.objectId}" does not exist`, describeExpected(check), null);
  }
  if (evidence.propertyExists === false) {
    return fail("property_not_found", `Property "${check.property}" is not present on object "${check.objectId}"`, describeExpected(check), null);
  }
  const raw = evidence.observedValue;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return inconclusive(
      "invalid_evidence_value",
      `Evidence for check "${check.id}" does not carry a finite numeric value for property "${check.property}" (got ${JSON.stringify(raw)})`,
      describeExpected(check),
      raw ?? null
    );
  }
  if (!checkUnitCompatible(check.expectedUnit, evidence.unit)) {
    return inconclusive(
      "unit_mismatch",
      `Check "${check.id}" expects unit "${check.expectedUnit}" but evidence reports ${evidence.unit === null ? "no unit" : `unit "${evidence.unit}"`} -- NAQSH does not convert between units`,
      describeExpected(check),
      raw
    );
  }
  const satisfied = compareNumeric(check.operator, raw, check.expectedValue, check.tolerance);
  const description = `${check.property} ${check.operator} ${check.expectedValue}${check.expectedUnit ? check.expectedUnit : ""}`;
  return satisfied
    ? pass(`Condition satisfied: ${description} (observed ${raw})`, describeExpected(check), raw)
    : fail("violated", `Condition violated: ${description} (observed ${raw})`, describeExpected(check), raw);
}

function evaluateBoundsCheck(check: BoundsCheck, evidence: Evidence): Outcome {
  if (evidence.objectExists === false) {
    return fail("object_not_found", `Object "${check.objectId}" does not exist`, describeExpected(check), null);
  }
  if (evidence.propertyExists === false) {
    return fail("property_not_found", `Property "${check.property}" is not present on object "${check.objectId}"`, describeExpected(check), null);
  }
  const raw = evidence.observedValue;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return inconclusive(
      "invalid_evidence_value",
      `Evidence for check "${check.id}" does not carry a finite numeric value for property "${check.property}" (got ${JSON.stringify(raw)})`,
      describeExpected(check),
      raw ?? null
    );
  }
  if (!checkUnitCompatible(check.unit, evidence.unit)) {
    return inconclusive(
      "unit_mismatch",
      `Check "${check.id}" expects unit "${check.unit}" but evidence reports ${evidence.unit === null ? "no unit" : `unit "${evidence.unit}"`} -- NAQSH does not convert between units`,
      describeExpected(check),
      raw
    );
  }
  const withinMin = check.min === null || (check.minInclusive ? raw >= check.min : raw > check.min);
  const withinMax = check.max === null || (check.maxInclusive ? raw <= check.max : raw < check.max);
  const description = `${check.min ?? "-inf"} ${check.minInclusive ? "<=" : "<"} ${check.property} ${check.maxInclusive ? "<=" : "<"} ${check.max ?? "+inf"}`;
  return withinMin && withinMax
    ? pass(`Within bounds: ${description} (observed ${raw})`, describeExpected(check), raw)
    : fail("violated", `Out of bounds: ${description} (observed ${raw})`, describeExpected(check), raw);
}

function evaluate(check: Check, evidence: Evidence, context: EvaluateCheckContext): Outcome {
  if (evidence.stateVersion !== null && evidence.stateVersion !== context.projectVersion) {
    return inconclusive(
      "evidence_stale",
      `Evidence for check "${check.id}" was captured at project version ${evidence.stateVersion}, but the current project version is ${context.projectVersion} -- re-observe before verifying`,
      describeExpected(check),
      evidence.observedValue ?? null
    );
  }
  if (evidence.objectId !== null && evidence.objectId !== check.objectId) {
    return inconclusive(
      "evidence_target_mismatch",
      `Evidence for check "${check.id}" describes object "${evidence.objectId}", but this check targets object "${check.objectId}"`,
      describeExpected(check),
      evidence.observedValue ?? null
    );
  }
  if ("property" in check && evidence.property !== null && evidence.property !== check.property) {
    // Same guard as the objectId check above, one level narrower: evidence
    // about the RIGHT object but the WRONG property must never be silently
    // read as if it were the property this check actually cares about
    // (audit finding: without this, evidence.observedValue from an
    // unrelated property could silently satisfy/violate a numeric check
    // that never actually observed the property it names).
    return inconclusive(
      "evidence_target_mismatch",
      `Evidence for check "${check.id}" describes property "${evidence.property}", but this check targets property "${check.property}"`,
      describeExpected(check),
      evidence.observedValue ?? null
    );
  }
  switch (check.kind) {
    case "object_exists":
      return evaluateObjectExists(check, evidence);
    case "object_type":
      return evaluateObjectType(check, evidence);
    case "property_required":
      return evaluatePropertyRequired(check, evidence);
    case "numeric_comparison":
      return evaluateNumericComparison(check, evidence);
    case "bounds_check":
      return evaluateBoundsCheck(check, evidence);
  }
}

export function evaluateCheck(check: Check, evidence: Evidence | null, context: EvaluateCheckContext): VerificationResult {
  const outcome =
    evidence === null
      ? inconclusive("evidence_missing", `No evidence was supplied for check "${check.id}"`, describeExpected(check))
      : evaluate(check, evidence, context);

  return createVerificationResult({
    checkId: check.id,
    checkKind: check.kind,
    status: outcome.status,
    reasonKind: outcome.reasonKind,
    message: outcome.message,
    expected: outcome.expected,
    actual: outcome.actual,
    evidence,
    projectId: context.projectId,
    projectVersion: context.projectVersion,
    environmentKind: context.environmentKind ?? null,
    documentName: context.documentName ?? null
  });
}
