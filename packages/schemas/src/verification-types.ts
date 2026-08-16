import type { EntitySource } from "./types.js";
import type { EnvironmentObjectGenericType } from "./environment-types.js";

/**
 * Phase 16: DETERMINISTIC VERIFICATION.
 *
 * Answers "did this engineering condition actually become true?" using
 * structured evidence and deterministic rules -- never Gemini, never
 * conversational history, and never `tool.success === true` (a successful
 * command only proves the command executed, not that the engineering
 * objective it was meant to achieve was satisfied). The intended pipeline:
 *
 *   Environment -> Observation (P8/P13) -> Evidence -> Check.evaluate()
 *   (@naqsh/core's verify.ts, a PURE function) -> VerificationResult ->
 *   Agent/UI
 *
 * `EntitySource` already reserved `"verification"` back in P2 specifically
 * for this phase (see types.ts's own doc comment: "a Change's provenance
 * must be able to say a state transition was caused by a verification
 * result (P16)") and P3/P4 already reserved `ToolTarget: "verification"` /
 * `ToolMutationKind: "verify"` -- this phase fills in those pre-built seams
 * rather than inventing new ones.
 *
 * `Check`/`Evidence`/`VerificationResult` are three DELIBERATELY separate
 * concepts, matching this phase's own architectural principle ("do not
 * collapse these into one opaque verification blob"):
 *   Check              -- a stable, typed, reusable RULE ("diameter of
 *                          envobj_1 must be <= 20mm"). Created once, can be
 *                          evaluated many times as the project changes.
 *   Evidence           -- a structured, attributable OBSERVATION of the
 *                          world at one point in time, built from the
 *                          EXISTING P8/P13 observation/inspection output
 *                          (never a second, competing environment-access
 *                          path).
 *   VerificationResult -- the deterministic OUTCOME of evaluating one Check
 *                          against one piece of Evidence: PASS, FAIL, or
 *                          INCONCLUSIVE, with the expected/actual values
 *                          preserved separately so neither can silently
 *                          overwrite the other.
 */

export type NumericComparisonOperator = "eq" | "neq" | "lt" | "lte" | "gt" | "gte";

export const NUMERIC_COMPARISON_OPERATORS: readonly NumericComparisonOperator[] = ["eq", "neq", "lt", "lte", "gt", "gte"];

/**
 * A deliberately narrow, ALLOWLISTED set of deterministic check kinds
 * (Phase 16's own "no arbitrary expressions" requirement) -- adding a new
 * kind means adding a new typed variant here plus a new `evaluate*` branch
 * in @naqsh/core's verify.ts, never a generic expression interpreter.
 * Closed-but-additive, matching `EntitySource`/`ToolTarget`'s convention.
 */
export type CheckKind = "numeric_comparison" | "bounds_check" | "object_exists" | "object_type" | "property_required";

export const CHECK_KINDS: readonly CheckKind[] = ["numeric_comparison", "bounds_check", "object_exists", "object_type", "property_required"];

interface BaseCheck<Kind extends string> {
  id: string;
  kind: Kind;
  /** Human-readable statement of what this check asserts, e.g. "mounting
   * bracket thickness must be at least 3mm". */
  description: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

/**
 * `value <operator> expectedValue`, optionally within `tolerance` -- see
 * verify.ts's `compareNumeric` for the exact, explicit, documented
 * tolerance semantics (Phase 16's "no hidden epsilon" requirement:
 * `tolerance` must be spelled out on the Check itself, never a silently
 * baked-in constant).
 */
export interface NumericComparisonCheck extends BaseCheck<"numeric_comparison"> {
  objectId: string;
  property: string;
  operator: NumericComparisonOperator;
  expectedValue: number;
  /** Raw unit string, matching `Requirement`/`Constraint.unit`'s existing
   * convention exactly -- no second unit system. `null` means "unit
   * doesn't matter for this check"; a non-null value means the evaluator
   * requires evidence reporting the SAME unit string, and reports
   * INCONCLUSIVE (never a silent pass) if evidence doesn't confirm it --
   * see verify.ts. NAQSH does not convert between units today. */
  expectedUnit: string | null;
  /** Explicit, deterministic tolerance for floating-point comparison
   * (`null` = exact comparison). Only meaningful for `eq`/`neq`; see
   * verify.ts's doc comment on `compareNumeric` for the full semantics
   * across every operator. */
  tolerance: number | null;
}

export interface NumericComparisonCheckInput {
  id?: string;
  kind: "numeric_comparison";
  description: string;
  objectId: string;
  property: string;
  operator: NumericComparisonOperator;
  expectedValue: number;
  expectedUnit?: string | null;
  tolerance?: number | null;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

/** `min <= value <= max` (inclusivity independently configurable per
 * bound) -- the "simple constraint / property lies within specified
 * bounds" check the P16 brief names explicitly. */
export interface BoundsCheck extends BaseCheck<"bounds_check"> {
  objectId: string;
  property: string;
  /** `null` means "no lower bound"; likewise `max`. At least one of
   * `min`/`max` must be non-null -- enforced by `assertBoundsCheck`. */
  min: number | null;
  max: number | null;
  minInclusive: boolean;
  maxInclusive: boolean;
  unit: string | null;
}

export interface BoundsCheckInput {
  id?: string;
  kind: "bounds_check";
  description: string;
  objectId: string;
  property: string;
  min?: number | null;
  max?: number | null;
  minInclusive?: boolean;
  maxInclusive?: boolean;
  unit?: string | null;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface ObjectExistsCheck extends BaseCheck<"object_exists"> {
  objectId: string;
}

export interface ObjectExistsCheckInput {
  id?: string;
  kind: "object_exists";
  description: string;
  objectId: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

/** Reuses `EnvironmentObjectGenericType` (P13) rather than inventing a
 * second object-classification vocabulary. */
export interface ObjectTypeCheck extends BaseCheck<"object_type"> {
  objectId: string;
  expectedGenericType: EnvironmentObjectGenericType;
}

export interface ObjectTypeCheckInput {
  id?: string;
  kind: "object_type";
  description: string;
  objectId: string;
  expectedGenericType: EnvironmentObjectGenericType;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface PropertyRequiredCheck extends BaseCheck<"property_required"> {
  objectId: string;
  property: string;
  /** If `true`, a property that is present but `null`/`undefined` still
   * fails; if `false`, mere key presence is sufficient. */
  requireNonNull: boolean;
}

export interface PropertyRequiredCheckInput {
  id?: string;
  kind: "property_required";
  description: string;
  objectId: string;
  property: string;
  requireNonNull?: boolean;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export type Check = NumericComparisonCheck | BoundsCheck | ObjectExistsCheck | ObjectTypeCheck | PropertyRequiredCheck;

export type CheckInput =
  | NumericComparisonCheckInput
  | BoundsCheckInput
  | ObjectExistsCheckInput
  | ObjectTypeCheckInput
  | PropertyRequiredCheckInput;

/**
 * A structured, attributable observation of the world at one point in
 * time -- what a Check is evaluated AGAINST. Deliberately ONE flat shape
 * (not a union per check kind) matching `EnvironmentObjectGeometry`'s own
 * "every field independently nullable" convention: a caller/evaluator
 * reads only the fields relevant to the Check kind it cares about, and a
 * field that genuinely couldn't be observed is `null`, never fabricated.
 *
 * Built by @naqsh/core's `buildEvidenceFromEnvironmentObject` from an
 * EXISTING `EnvironmentObject` (the exact same data `inspect_environment_
 * object`/`inspect_environment_objects` already return) -- never a second,
 * independent environment-access path. This is what keeps verification
 * FreeCAD-independent: Evidence looks identical whether the underlying
 * `EnvironmentObject` came from the mock adapter or the real FreeCAD one.
 */
export interface Evidence {
  id: string;
  /** Which object this evidence describes, or `null` if the evidence is
   * not about one specific object (no P16 check kind needs this yet, kept
   * nullable for the same "not every field applies to every use" reason
   * `EnvironmentObject.parentId` is nullable). */
  objectId: string | null;
  /** Whether `objectId` was confirmed to exist at observation time --
   * `null` only when existence itself could not be determined (e.g. no
   * environment session connected). Distinct from `propertyExists`: "the
   * object doesn't exist" and "the object exists but the property is
   * unset" are different, independently meaningful facts. */
  objectExists: boolean | null;
  observedGenericType: EnvironmentObjectGenericType | null;
  property: string | null;
  /** Whether `property` was found at all on the object (vs. found but
   * `null`) -- `null` when this was never checked (e.g. `property` itself
   * is `null`, or the object doesn't exist). */
  propertyExists: boolean | null;
  observedValue: unknown;
  /** Raw unit string reported alongside `observedValue`, or `null` if
   * none is known. `EnvironmentProperty` (P5/P13) does not carry a unit
   * today, so evidence built from a real `EnvironmentObject` will always
   * report `null` here -- an honest reflection of what the adapter layer
   * actually knows, not a fabricated unit (Phase 16's own "if unit
   * handling is intentionally not yet implemented, keep it explicit and
   * safe" requirement). */
  unit: string | null;
  /** Correlates this evidence back to the `ObservationResult`/inspection
   * call that produced it, when one exists -- `null` for evidence built
   * outside that flow (e.g. directly in a test fixture). */
  observationId: string | null;
  /** `WorldModelState.project.version` in effect when this evidence was
   * captured -- the SAME version counter P1/P2/P15 already maintain,
   * never a second, competing versioning system. This is the freshness
   * signal verify.ts compares against the CURRENT project version at
   * evaluation time: a mismatch means the world has moved on since this
   * evidence was captured, and must never silently produce PASS. */
  stateVersion: number | null;
  environmentKind: string | null;
  observedAt: string;
  /** Who/what produced this evidence -- always `"system"` in practice
   * (evidence is built by deterministic core code from adapter output,
   * never authored by Gemini), reusing `EntitySource` rather than
   * inventing a parallel provenance concept. */
  source: EntitySource;
  metadata: Record<string, unknown>;
}

export interface EvidenceInput {
  id?: string;
  objectId?: string | null;
  objectExists?: boolean | null;
  observedGenericType?: EnvironmentObjectGenericType | null;
  property?: string | null;
  propertyExists?: boolean | null;
  observedValue?: unknown;
  unit?: string | null;
  observationId?: string | null;
  stateVersion?: number | null;
  environmentKind?: string | null;
  observedAt?: string;
  source?: EntitySource;
  metadata?: Record<string, unknown>;
}

export type VerificationStatus = "pass" | "fail" | "inconclusive";

export const VERIFICATION_STATUSES: readonly VerificationStatus[] = ["pass", "fail", "inconclusive"];

/**
 * Every distinct reason a `VerificationResult` landed where it did --
 * named specifically so a caller can branch on `.reasonKind` instead of
 * string-matching `.message`, matching `RestoreCheckpointFailureReason`'s
 * (P15) identical "be specific, not generic" discipline.
 *   "satisfied"             -- PASS: the check's condition holds.
 *   "violated"               -- FAIL: evidence was available and fresh,
 *                                but the condition does not hold.
 *   "object_not_found"       -- FAIL: evidence confirms the target object
 *                                does not exist (a definitive, deterministic
 *                                "no", not an inconclusive one).
 *   "property_not_found"     -- FAIL: the object exists but the required
 *                                property was confirmed absent.
 *   "evidence_missing"       -- INCONCLUSIVE: no evidence was supplied, or
 *                                the evidence supplied doesn't report the
 *                                field this check needs.
 *   "evidence_stale"         -- INCONCLUSIVE: evidence.stateVersion does
 *                                not match the project version being
 *                                verified against.
 *   "evidence_target_mismatch" -- INCONCLUSIVE: evidence was supplied for a
 *                                DIFFERENT object, or a different property
 *                                on the right object, than the check
 *                                targets.
 *   "unit_mismatch"           -- INCONCLUSIVE: the check requires a unit
 *                                evidence doesn't confirm.
 *   "invalid_evidence_value"  -- INCONCLUSIVE: evidence.observedValue is
 *                                not a value this check kind can evaluate
 *                                (e.g. non-numeric for a numeric check).
 */
export type VerificationReasonKind =
  | "satisfied"
  | "violated"
  | "object_not_found"
  | "property_not_found"
  | "evidence_missing"
  | "evidence_stale"
  | "evidence_target_mismatch"
  | "unit_mismatch"
  | "invalid_evidence_value";

export const VERIFICATION_REASON_KINDS: readonly VerificationReasonKind[] = [
  "satisfied",
  "violated",
  "object_not_found",
  "property_not_found",
  "evidence_missing",
  "evidence_stale",
  "evidence_target_mismatch",
  "unit_mismatch",
  "invalid_evidence_value"
];

/**
 * The deterministic OUTCOME of evaluating one `Check` against one piece of
 * `Evidence` (or none). Always produced by @naqsh/core's `evaluateCheck` --
 * never hand-constructed by a tool to fake a result (Phase 16's explicit
 * hackathon-integrity requirement).
 *
 * `expected`/`actual` are preserved SEPARATELY and are never mutated after
 * `evaluate()` sees the evidence -- the check's own condition (`expected`)
 * is derived purely from the `Check`, before evidence is even consulted.
 */
export interface VerificationResult {
  id: string;
  checkId: string;
  checkKind: CheckKind;
  status: VerificationStatus;
  reasonKind: VerificationReasonKind;
  message: string;
  /** JSON-safe description of the expected condition, e.g.
   * `{ operator: "lte", value: 20, unit: "mm" }` -- derived purely from
   * the Check, independent of whatever evidence turns out to say. */
  expected: unknown;
  /** JSON-safe description of what was actually observed, or `null` when
   * no usable value was available (evidence missing/stale/invalid). */
  actual: unknown;
  /** The evidence this result was evaluated against, or `null` if none was
   * available. Embedded (not a separate lookup) so a `VerificationResult`
   * remains a complete, self-contained audit record on its own. */
  evidence: Evidence | null;
  projectId: string;
  /** The CURRENT project version this result was evaluated against (not
   * necessarily equal to `evidence.stateVersion` -- when they differ, this
   * result is `inconclusive`/`evidence_stale`, and both numbers are
   * preserved here and on `evidence` for audit purposes). */
  projectVersion: number;
  environmentKind: string | null;
  documentName: string | null;
  evaluatedAt: string;
  metadata: Record<string, unknown>;
}

export interface VerificationResultInput {
  id?: string;
  checkId: string;
  checkKind: CheckKind;
  status: VerificationStatus;
  reasonKind: VerificationReasonKind;
  message: string;
  expected?: unknown;
  actual?: unknown;
  evidence?: Evidence | null;
  projectId: string;
  projectVersion: number;
  environmentKind?: string | null;
  documentName?: string | null;
  evaluatedAt?: string;
  metadata?: Record<string, unknown>;
}
