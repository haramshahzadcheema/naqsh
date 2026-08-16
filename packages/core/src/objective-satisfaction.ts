import {
  createObjectiveConditionOutcome,
  createObjectiveSatisfactionResult,
  type ObjectiveConditionOutcome,
  type ObjectiveConditionReasonKind,
  type ObjectiveSatisfactionResult,
  type ObjectiveSatisfactionStatus,
  type VerificationResult,
  type VerificationStatus
} from "@naqsh/schemas";

/**
 * Phase 17: OBJECTIVE SATISFACTION.
 *
 * `evaluateObjectiveSatisfaction` is THE satisfaction engine -- a PURE
 * function of (resolved conditions, context), mirroring P16's
 * `evaluateCheck` exactly. Same inputs always produce the same status/
 * reason/conditions (only `id`/`evaluatedAt` vary, never the outcome). It
 * does not:
 *   - call Gemini or any model provider,
 *   - make a network call,
 *   - call an EnvironmentAdapter or look anything up from a store
 *     (resolving which VerificationResult backs each condition happens
 *     BEFORE this runs, in objective-satisfaction-tool.ts, which is also
 *     where the result gets PERSISTED -- calculation and recording stay
 *     separate, exactly like create_checkpoint/run_verification already
 *     keep them separate),
 *   - mutate the World Model, a checkpoint, or any VerificationResult,
 *   - re-check geometry or re-implement verification logic -- it only
 *     AGGREGATES `VerificationResult`s P16 already produced.
 *
 * It must NOT let "the tool ran" or "a command succeeded" influence the
 * verdict -- this file never sees a ToolResult, only VerificationResults
 * (or their absence), which is the whole point of P16/P17 staying two
 * separate layers.
 */

/** ONE condition to resolve into an `ObjectiveConditionOutcome` --
 * `verificationResult` is already looked up (or `null` if none was found)
 * by the impure tool layer; this is the pure engine's only view of it. */
export interface ResolvedObjectiveCondition {
  checkId: string;
  requirementId?: string | null;
  constraintId?: string | null;
  /** AND-composed (`true`, the default) or OR-composed (`false`). See this
   * file's own doc comment on `aggregate` for the exact semantics. */
  required?: boolean;
  verificationResult: VerificationResult | null;
}

export interface EvaluateObjectiveSatisfactionContext {
  projectId: string;
  /** The CURRENT project version this evaluation runs against -- every
   * condition's `VerificationResult.projectVersion` is compared against
   * this to detect staleness (Phase 17's "stale results must never
   * silently become current truth" requirement), reusing the SAME version
   * counter P1/P2/P15/P16 already maintain. */
  projectVersion: number;
  objectiveSummary?: string | null;
}

function buildOutcomeInput(condition: ResolvedObjectiveCondition, context: EvaluateObjectiveSatisfactionContext) {
  const required = condition.required ?? true;
  const base = {
    checkId: condition.checkId,
    requirementId: condition.requirementId ?? null,
    constraintId: condition.constraintId ?? null,
    required
  };
  const vr = condition.verificationResult;

  if (!vr) {
    return {
      ...base,
      checkKind: null,
      verificationResultId: null,
      effectiveStatus: "inconclusive" as VerificationStatus,
      reasonKind: "no_verification_result" as ObjectiveConditionReasonKind,
      message: `No verification result exists for check "${condition.checkId}"`
    };
  }

  if (vr.projectId !== context.projectId) {
    // Audit finding: VerificationResultStore is a single, global,
    // NOT project-scoped store (mirroring CheckStore -- see P16), so a
    // caller-pinned `verificationResultId` (or, in principle, a checkId
    // collision) could resolve to a result that genuinely belongs to a
    // DIFFERENT project. Checked BEFORE the version/staleness comparison
    // below, since a version match against the WRONG project's counter is
    // meaningless -- this must never be silently treated as evidence for
    // the current objective.
    return {
      ...base,
      checkKind: vr.checkKind,
      verificationResultId: vr.id,
      effectiveStatus: "inconclusive" as VerificationStatus,
      reasonKind: "verification_result_wrong_project" as ObjectiveConditionReasonKind,
      message: `Verification result for check "${condition.checkId}" belongs to project "${vr.projectId}", not the current project "${context.projectId}"`
    };
  }

  if (vr.projectVersion !== context.projectVersion) {
    return {
      ...base,
      checkKind: vr.checkKind,
      verificationResultId: vr.id,
      effectiveStatus: "inconclusive" as VerificationStatus,
      reasonKind: "stale_verification_result" as ObjectiveConditionReasonKind,
      message: `Verification result for check "${condition.checkId}" was evaluated at project version ${vr.projectVersion}, but the current version is ${context.projectVersion} -- re-verify before evaluating objective satisfaction`
    };
  }

  if (vr.status === "inconclusive") {
    return {
      ...base,
      checkKind: vr.checkKind,
      verificationResultId: vr.id,
      effectiveStatus: "inconclusive" as VerificationStatus,
      reasonKind: "verification_inconclusive" as ObjectiveConditionReasonKind,
      message: `Verification for check "${condition.checkId}" is inconclusive: ${vr.message}`
    };
  }

  return {
    ...base,
    checkKind: vr.checkKind,
    verificationResultId: vr.id,
    effectiveStatus: vr.status,
    reasonKind: (vr.status === "pass" ? "satisfied" : "violated") as ObjectiveConditionReasonKind,
    message: vr.message
  };
}

/** Reported when no conditions were supplied at all -- see `aggregate`'s
 * doc comment for why this is INCONCLUSIVE, never SATISFIED. */
export const EMPTY_CONDITIONS_REASON = "No conditions were supplied for this objective evaluation -- an objective with nothing verified cannot be considered satisfied.";

/**
 * The deterministic aggregation rule (Phase 17's own explicit AND/OR
 * composition requirement):
 *
 * Conditions split into two groups by `required`:
 *   REQUIRED (AND) -- must ALL hold. A single deterministic FAIL among
 *     required conditions immediately establishes NOT_SATISFIED, even if
 *     other required conditions are merely INCONCLUSIVE (a known failure
 *     already proves the objective isn't met -- Phase 17's own explicit
 *     "INCONCLUSIVE + FAIL -> NOT_SATISFIED" example). Absent any FAIL, a
 *     single INCONCLUSIVE among required conditions makes the whole
 *     objective INCONCLUSIVE. This is how a violated HARD `Constraint`
 *     always forces NOT_SATISFIED (objective-satisfaction-tool.ts refuses
 *     to let a hard constraint's condition be marked anything but
 *     `required: true`).
 *   OPTIONAL (OR) -- at least ONE must PASS; only consulted once every
 *     required condition has already passed (or there were none). At
 *     least one PASS -> satisfied. No pass but at least one INCONCLUSIVE ->
 *     INCONCLUSIVE. All FAIL -> NOT_SATISFIED.
 *
 * An EMPTY condition list is deliberately INCONCLUSIVE, never SATISFIED --
 * an objective with nothing verified provides no evidence either way, and
 * treating "nothing was checked" as success would be the exact silent-
 * success failure mode this whole phase exists to prevent.
 */
function aggregate(outcomes: ObjectiveConditionOutcome[]): { status: ObjectiveSatisfactionStatus; reason: string } {
  if (outcomes.length === 0) {
    return { status: "inconclusive", reason: EMPTY_CONDITIONS_REASON };
  }

  const required = outcomes.filter((outcome) => outcome.required);
  const optional = outcomes.filter((outcome) => !outcome.required);

  const requiredFail = required.find((outcome) => outcome.effectiveStatus === "fail");
  if (requiredFail) {
    return { status: "not_satisfied", reason: `Required condition for check "${requiredFail.checkId}" is violated: ${requiredFail.message}` };
  }
  const requiredInconclusive = required.find((outcome) => outcome.effectiveStatus === "inconclusive");
  if (requiredInconclusive) {
    return { status: "inconclusive", reason: `Required condition for check "${requiredInconclusive.checkId}" is inconclusive: ${requiredInconclusive.message}` };
  }
  // Every required condition passed (or there were none at all).

  if (optional.length === 0) {
    return { status: "satisfied", reason: "All required conditions are satisfied." };
  }
  const optionalPass = optional.find((outcome) => outcome.effectiveStatus === "pass");
  if (optionalPass) {
    return { status: "satisfied", reason: `All required conditions are satisfied, and alternative condition for check "${optionalPass.checkId}" is satisfied.` };
  }
  const optionalInconclusive = optional.find((outcome) => outcome.effectiveStatus === "inconclusive");
  if (optionalInconclusive) {
    return { status: "inconclusive", reason: `No alternative condition passed, and condition for check "${optionalInconclusive.checkId}" is inconclusive.` };
  }
  return { status: "not_satisfied", reason: "No alternative (optional) condition was satisfied." };
}

export function evaluateObjectiveSatisfaction(conditions: ResolvedObjectiveCondition[], context: EvaluateObjectiveSatisfactionContext): ObjectiveSatisfactionResult {
  // Validate each condition's shape once via the factory (never trust the
  // raw, unvalidated input objects), THEN aggregate over the validated
  // outcomes, THEN build the final result once.
  const outcomes = conditions.map((condition) => createObjectiveConditionOutcome(buildOutcomeInput(condition, context)));
  const { status, reason } = aggregate(outcomes);
  return createObjectiveSatisfactionResult({
    projectId: context.projectId,
    projectVersion: context.projectVersion,
    objectiveSummary: context.objectiveSummary ?? null,
    status,
    reason,
    conditions: outcomes
  });
}
