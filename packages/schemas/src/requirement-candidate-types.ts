import type { EntitySource, RequirementPriority } from "./types.js";
import type { NumericComparisonOperator } from "./verification-types.js";

/**
 * Phase 18: NATURAL LANGUAGE -> STRUCTURED REQUIREMENT.
 *
 * The pipeline:
 *
 *   user text -> interpretRequirementFromText() (core, calls Gemini via the
 *   existing ModelProvider/structured-output machinery, P7) ->
 *   RequirementCandidate (THIS file, NOT yet a real Requirement) ->
 *   deterministic validation (assertRequirementCandidate, below) ->
 *   add_requirement tool (mutation:"mutate", approval-gated like every
 *   other mutation) -> the EXISTING `add_requirement` WorldModelTransition
 *   (P1/P2, unchanged) -> a real, audited `Requirement` in `Project.
 *   requirements`.
 *
 * `RequirementCandidate` is deliberately a SEPARATE entity from
 * `Requirement` (types.ts, P1) -- never a mutated/half-filled Requirement,
 * mirroring `Proposal`'s (P10) identical "describes INTENT, is not yet
 * real state" relationship to the `Change` it might eventually cause. This
 * is what makes "candidate" and "accepted" genuinely distinct: a
 * `RequirementCandidate` can be produced, inspected, and rejected without
 * ever having existed as a `Requirement`, and creating one can no more
 * mutate `WorldModelState` than creating a `Proposal` can (see
 * `requirement-interpreter.ts`'s doc comment and `repo-boundaries.test.ts`'s
 * P18 guards for how that boundary is enforced structurally).
 *
 * `operator`/`value`/`unit` deliberately reuse P16's `NumericComparisonOperator`
 * vocabulary (`eq`/`neq`/`lt`/`lte`/`gt`/`gte`) rather than inventing a
 * parallel one -- a quantitative requirement's criterion is structurally
 * the same shape as a `NumericComparisonCheck`'s, which is exactly the
 * point: a future phase wiring "this requirement is met" to P16
 * verification does not need a translation layer between two incompatible
 * operator vocabularies.
 */

/**
 * Whether a candidate has enough concrete, user-grounded content to be
 * recorded as-is, or is too vague/subjective to state a criterion without
 * inventing one. Deliberately NOT about whether the requirement is
 * numeric: `"the design should be easy to manufacture"` is `"specific"`
 * with `operator`/`value`/`unit` all `null` -- a requirement does not need
 * a number to be a real, specific constraint. `"make it lightweight"` is
 * `"ambiguous"` -- there is no explicit basis for any particular numeric
 * threshold, and Phase 18 must not invent one. Resolving an `"ambiguous"`
 * candidate into a `"specific"` one via a clarifying question is P19's
 * job, not this phase's -- P18 stops at honestly representing the
 * uncertainty.
 */
export type RequirementInterpretationStatus = "specific" | "ambiguous";

export const REQUIREMENT_INTERPRETATION_STATUSES: readonly RequirementInterpretationStatus[] = ["specific", "ambiguous"];

export interface RequirementCandidate {
  id: string;
  projectId: string;
  /** `Project.version` this candidate was interpreted against -- an audit/
   * traceability field (Phase 18's "state/environment revision" ask),
   * mirroring `Proposal.projectVersion`'s identical role. Deliberately NOT
   * enforced as a hard staleness gate at accept-time the way P16/P17
   * enforce evidence freshness: unlike a CAD verification result, a
   * natural-language interpretation's CONTENT does not depend on live
   * environment state, so a later project-version bump does not make an
   * already-produced candidate wrong -- only stale in the sense that a
   * human reviewing it should know when it was produced. */
  projectVersion: number;
  /** The user's original statement, verbatim -- retained so a future
   * phase (P19 clarification, P24 memory) can reason about the source
   * text without needing to re-run interpretation (Phase 18's own
   * explicit "retain the original statement for traceability" requirement). */
  statementText: string;
  /** Gemini's restated, structured description -- NOT a copy of
   * `statementText`, but never asserting anything `statementText` doesn't
   * support. Mirrors `Requirement.description`'s role for the eventual
   * accepted requirement. */
  description: string;
  category: string;
  /** Non-null only for a genuinely quantitative candidate. `null` for a
   * qualitative `"specific"` candidate (e.g. manufacturability) AND
   * always `null` for an `"ambiguous"` one (see `assertRequirementCandidate`
   * -- an ambiguous candidate can never carry a numeric criterion,
   * regardless of what the model's raw output claimed). */
  operator: NumericComparisonOperator | null;
  value: number | null;
  unit: string | null;
  interpretationStatus: RequirementInterpretationStatus;
  /** WHY this candidate is ambiguous -- required (non-empty) when
   * `interpretationStatus` is `"ambiguous"`, and required to be `null`
   * when `"specific"` (never a stray explanation attached to a
   * requirement that doesn't need one). */
  ambiguityReason: string | null;
  priority: RequirementPriority;
  /** Provenance: who/what produced this candidate. Always `"agent"` in
   * practice (Gemini interpreted the text via `interpretRequirementFromText`)
   * -- reuses `EntitySource` rather than inventing a parallel provenance
   * concept, exactly like `Proposal.source`/`Plan.source`. */
  source: EntitySource;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface RequirementCandidateInput {
  id?: string;
  projectId: string;
  projectVersion: number;
  statementText: string;
  description: string;
  category: string;
  operator?: NumericComparisonOperator | null;
  value?: number | null;
  unit?: string | null;
  interpretationStatus: RequirementInterpretationStatus;
  ambiguityReason?: string | null;
  priority?: RequirementPriority;
  source?: EntitySource;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

/** Every distinct way a REQUIREMENT INTERPRETATION REQUEST or the
 * resulting structure can fail -- never a bare `Error("interpretation
 * failed")`. Mirrors `ProposalGenerationErrorKind`'s (P10) granularity and
 * reasoning exactly:
 *   "invalid_input"            -> the text/projectId/options given to
 *                                  interpretRequirementFromText are
 *                                  malformed (e.g. empty text)
 *   "model_unavailable"        -> the underlying ModelProvider.generate()
 *                                  call itself returned status:"error"
 *   "invalid_model_output"     -> the model didn't return a
 *                                  structured_result at all
 *   "malformed_candidate_shape" -> the structured JSON came back but does
 *                                  not assemble into a valid
 *                                  RequirementCandidate (assertRequirement
 *                                  CandidateShape failed)
 */
export type RequirementInterpretationErrorKind = "invalid_input" | "model_unavailable" | "invalid_model_output" | "malformed_candidate_shape";

export const REQUIREMENT_INTERPRETATION_ERROR_KINDS: readonly RequirementInterpretationErrorKind[] = [
  "invalid_input",
  "model_unavailable",
  "invalid_model_output",
  "malformed_candidate_shape"
];
