import type { CheckKind, VerificationStatus } from "./verification-types.js";

/**
 * Phase 17: OBJECTIVE SATISFACTION.
 *
 * Answers a DIFFERENT question than P16 does. P16's `evaluateCheck`
 * answers "does this ONE engineering condition currently hold?" -- this
 * file's `evaluateObjectiveSatisfaction` (in @naqsh/core) answers "taken
 * TOGETHER, do the conditions that were verified establish that the
 * OBJECTIVE is satisfied?" These stay two separate, composable layers on
 * purpose (P17's own explicit rule): P17 never re-checks geometry or
 * re-implements verification logic -- it only AGGREGATES `VerificationResult`s
 * P16 already produced.
 *
 * The critical distinction this phase exists to enforce:
 *   COMMAND SUCCESS != STATE CHANGE != VERIFICATION RESULT != OBJECTIVE
 *   SATISFACTION
 * A tool reporting `status: "success"` only proves the tool ran. A `PASS`
 * VerificationResult only proves ONE condition holds. Only
 * `ObjectiveSatisfactionResult.status` -- computed deterministically from
 * the FULL set of relevant VerificationResults -- answers whether the
 * user's actual objective has been met.
 *
 * `Objective`/`Requirement`/`Constraint` (types.ts, P1) are NOT
 * redefined or duplicated here. `Project` has exactly ONE `Objective`
 * (a summary, not an id-addressable list), so an `ObjectiveSatisfactionResult`
 * identifies "which objective" the same way `ObservationResult` (P8)
 * already does -- a snapshot of `objective.summary`, not a foreign key to a
 * separate id scheme that doesn't exist. `Requirement.id`/`Constraint.id`
 * ARE real, existing ids -- `ObjectiveConditionOutcome` below references
 * them directly when a condition corresponds to one, closing the
 * traceability chain Objective -> Requirement/Constraint -> Check ->
 * VerificationResult -> Evidence without inventing a parallel entity.
 */

export type ObjectiveSatisfactionStatus = "satisfied" | "not_satisfied" | "inconclusive";

export const OBJECTIVE_SATISFACTION_STATUSES: readonly ObjectiveSatisfactionStatus[] = ["satisfied", "not_satisfied", "inconclusive"];

/**
 * Every distinct reason ONE condition landed where it did within an
 * objective evaluation -- named specifically so a caller can branch on
 * `.reasonKind` instead of string-matching `.message`, matching
 * `VerificationReasonKind`'s (P16) identical discipline.
 *   "satisfied"                 -- the condition's VerificationResult was
 *                                   PASS at the current project version.
 *   "violated"                  -- the condition's VerificationResult was
 *                                   FAIL at the current project version.
 *   "no_verification_result"    -- no VerificationResult exists yet for
 *                                   this condition's check (never verified,
 *                                   or the specified verificationResultId
 *                                   was not found).
 *   "verification_inconclusive" -- the condition's VerificationResult was
 *                                   itself INCONCLUSIVE.
 *   "stale_verification_result"        -- a VerificationResult exists and
 *                                          was PASS or FAIL, but was
 *                                          evaluated against a DIFFERENT
 *                                          project version than the one
 *                                          this objective evaluation is
 *                                          running against -- never
 *                                          silently trusted as still
 *                                          current.
 *   "verification_result_wrong_project" -- a VerificationResult was found
 *                                          (typically via a caller-pinned
 *                                          `verificationResultId`, since
 *                                          `VerificationResultStore` is not
 *                                          itself project-scoped), but its
 *                                          own `projectId` does not match
 *                                          the project this objective
 *                                          evaluation is running against --
 *                                          never treated as evidence for a
 *                                          DIFFERENT project's objective,
 *                                          checked BEFORE the version/
 *                                          staleness comparison even means
 *                                          anything.
 */
export type ObjectiveConditionReasonKind =
  | "satisfied"
  | "violated"
  | "no_verification_result"
  | "verification_inconclusive"
  | "stale_verification_result"
  | "verification_result_wrong_project";

export const OBJECTIVE_CONDITION_REASON_KINDS: readonly ObjectiveConditionReasonKind[] = [
  "satisfied",
  "violated",
  "no_verification_result",
  "verification_inconclusive",
  "stale_verification_result",
  "verification_result_wrong_project"
];

/**
 * The outcome of ONE condition considered as part of an objective
 * evaluation -- the unit the deterministic aggregation rules (in
 * @naqsh/core's objective-satisfaction.ts) combine. `effectiveStatus` is
 * NOT always the same as the referenced `VerificationResult.status`: a
 * stale result's ORIGINAL pass/fail is downgraded to `"inconclusive"` here
 * (Phase 17's "stale results must never silently become current truth"
 * requirement) -- `effectiveStatus` is always what actually counted toward
 * the aggregate, `reasonKind`/`message` explain why it differs from the
 * raw VerificationResult when it does.
 */
export interface ObjectiveConditionOutcome {
  checkId: string;
  checkKind: CheckKind | null;
  /** Non-null when this condition corresponds to a real `Requirement.id`
   * (P1) -- never validated for existence here (matching `add_relationship`'s
   * identical "dangling references are a read-time concern" precedent from
   * P8), just carried through for traceability. */
  requirementId: string | null;
  /** Non-null when this condition corresponds to a real `Constraint.id`
   * (P1). */
  constraintId: string | null;
  /** Whether this condition is AND-composed (`true`, the default -- must
   * hold for the objective to be satisfied) or OR-composed (`false` --
   * this condition is one of several ACCEPTABLE alternatives; at least one
   * must pass). A condition backed by a HARD `Constraint` can never be
   * `false` -- see objective-satisfaction-tool.ts. */
  required: boolean;
  /** The specific `VerificationResult.id` this outcome was computed from,
   * or `null` if none could be found. */
  verificationResultId: string | null;
  effectiveStatus: VerificationStatus;
  reasonKind: ObjectiveConditionReasonKind;
  message: string;
}

export interface ObjectiveConditionOutcomeInput {
  checkId: string;
  checkKind?: CheckKind | null;
  requirementId?: string | null;
  constraintId?: string | null;
  required?: boolean;
  verificationResultId?: string | null;
  effectiveStatus: VerificationStatus;
  reasonKind: ObjectiveConditionReasonKind;
  message: string;
}

/**
 * The deterministic OUTCOME of evaluating an objective against a set of
 * `ObjectiveConditionOutcome`s. Always produced by @naqsh/core's
 * `evaluateObjectiveSatisfaction` -- never hand-constructed by a tool, and
 * never assignable by Gemini (Phase 17's non-negotiable "no LLM verdict"
 * rule).
 */
export interface ObjectiveSatisfactionResult {
  id: string;
  projectId: string;
  /** The CURRENT project version this evaluation ran against -- every
   * `ObjectiveConditionOutcome.verificationResultId`'s own
   * `VerificationResult.projectVersion` is compared against this to detect
   * staleness. The SAME version counter P1/P2/P15/P16 already maintain,
   * never a second, competing one. */
  projectVersion: number;
  /** Snapshot of `Project.objective.summary` at evaluation time -- `null`
   * only if the objective was never set. Matches `ObservationResult.
   * objectiveSummary`'s identical "which objective" convention (P8);
   * `Project` has exactly one `Objective`, so there is no separate id to
   * reference. */
  objectiveSummary: string | null;
  status: ObjectiveSatisfactionStatus;
  /** Human-readable explanation of `status`, DERIVED from `conditions`
   * (never authored independently of them -- Phase 17's "a natural-language
   * summary must derive from the structured result" requirement). */
  reason: string;
  /** Every condition considered, in the order supplied -- the full,
   * structured trace `NOT_SATISFIED`/`INCONCLUSIVE` causes are drawn from.
   * Never empty when `status` was computed from real conditions; an empty
   * array is itself meaningful (see EMPTY_CONDITIONS_REASON in
   * objective-satisfaction.ts) and always produces `"inconclusive"`. */
  conditions: ObjectiveConditionOutcome[];
  evaluatedAt: string;
  metadata: Record<string, unknown>;
}

export interface ObjectiveSatisfactionResultInput {
  id?: string;
  projectId: string;
  projectVersion: number;
  objectiveSummary?: string | null;
  status: ObjectiveSatisfactionStatus;
  reason: string;
  conditions: ObjectiveConditionOutcomeInput[];
  evaluatedAt?: string;
  metadata?: Record<string, unknown>;
}
