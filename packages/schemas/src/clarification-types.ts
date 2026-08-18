import type { EntitySource } from "./types.js";
import type { RequirementCandidate } from "./requirement-candidate-types.js";

/**
 * Phase 19: REQUIREMENT CLARIFICATION.
 *
 * The pipeline:
 *
 *   RequirementCandidate (P18, already interpreted) ->
 *   analyzeRequirementCandidateCompleteness() (core, a PURE, deterministic
 *   function -- no Gemini call) -> zero or more `ClarificationInput`s ->
 *   `Clarification` (THIS file) -> user answers -> answerClarification()
 *   re-runs the EXISTING, unmodified `interpretRequirementFromText` (P18)
 *   on a FOCUSED question+answer statement -> a fresh, specific
 *   `RequirementCandidate` -> the EXISTING, unmodified `add_requirement`
 *   tool (P18) -> World Model.
 *
 * `Clarification` is deliberately a SEPARATE entity from `Requirement`
 * (P1) and `RequirementCandidate` (P18) -- it describes a QUESTION about a
 * candidate, never a mutated/half-filled requirement itself, mirroring
 * every prior phase's "candidate/process record is not yet real state"
 * discipline (`Proposal` for P10, `RequirementCandidate` for P18).
 *
 * `candidateSnapshot` embeds the FULL `RequirementCandidate` this
 * clarification was raised against, rather than storing only a bare
 * `requirementCandidateId` and requiring a new `RequirementCandidateStore`
 * to resolve it later -- P18 never introduced such a store (a candidate is
 * ephemeral, returned by `interpret_requirement` and never persisted on
 * its own), so a bare id would be a dangling reference the moment the
 * caller's local copy went out of scope. Embedding the snapshot keeps each
 * `Clarification` fully self-contained and independently traceable (P19's
 * own "traceability matters" requirement) without inventing a second
 * candidate-persistence mechanism.
 */

/**
 * A closed, allowlisted set of reasons a requirement candidate might be
 * insufficiently specified for the next engineering stage -- deliberately
 * NOT an "enormous engineering ontology" (the brief's own explicit
 * warning): these are the categories `analyzeRequirementCandidateCompleteness`
 * (core) actually produces, nothing speculative. Closed-but-additive,
 * matching `EntitySource`/`ToolTarget`'s convention.
 */
export type ClarificationCategory =
  | "missing_threshold"
  | "missing_unit"
  | "missing_target"
  | "missing_operating_condition"
  | "ambiguous_terminology"
  | "ambiguous_comparison"
  | "conflicting_constraints"
  | "missing_priority"
  | "ambiguous_scope"
  | "unresolved_reference"
  | "insufficient_context";

export const CLARIFICATION_CATEGORIES: readonly ClarificationCategory[] = [
  "missing_threshold",
  "missing_unit",
  "missing_target",
  "missing_operating_condition",
  "ambiguous_terminology",
  "ambiguous_comparison",
  "conflicting_constraints",
  "missing_priority",
  "ambiguous_scope",
  "unresolved_reference",
  "insufficient_context"
];

/**
 * The explicit lifecycle the brief's Step 4 requires, distinguishing
 * "requirement is incomplete" (not modeled here -- that's
 * `RequirementCandidate.interpretationStatus`, P18) from "clarification has
 * been asked" (`pending`) from "clarification has been answered"
 * (`answered`) from "requirement has been updated" (a NEW, separate
 * `RequirementCandidate` returned by `answerClarification`, never an
 * in-place edit of this `Clarification` or of any `Requirement`).
 *
 *   pending     -- created, awaiting an answer.
 *   answered    -- the user provided an answer that, combined with the
 *                  clarification's own question, re-interpreted (via P18,
 *                  unchanged) into a specific candidate.
 *   dismissed   -- explicitly closed WITHOUT an answer (the user/caller
 *                  decided this clarification isn't needed) -- distinct
 *                  from `answered` so a reader can never mistake "we chose
 *                  not to ask this" for "this was resolved."
 *   superseded  -- replaced by a newer `Clarification` for the SAME
 *                  (requirementCandidateId, category) pair, because the
 *                  candidate was re-interpreted and the question/reason
 *                  changed -- the duplicate-prevention mechanism Step 19
 *                  requires ("do not create duplicate clarifications for
 *                  the same unresolved issue").
 */
export type ClarificationStatus = "pending" | "answered" | "dismissed" | "superseded";

export const CLARIFICATION_STATUSES: readonly ClarificationStatus[] = ["pending", "answered", "dismissed", "superseded"];

export interface Clarification {
  id: string;
  projectId: string;
  /** `RequirementCandidate.id` this clarification concerns -- the grouping
   * key `listForCandidate`/duplicate-detection use. Also present, in full,
   * as `candidateSnapshot.id`; kept as its own top-level field purely for
   * cheap indexing/filtering without deserializing the snapshot. */
  requirementCandidateId: string;
  candidateSnapshot: RequirementCandidate;
  /** A specific, minimal, directly-answerable question (Step 7's own
   * quality bar) -- never "Can you provide more details?". */
  question: string;
  /** WHY this is being asked -- for an `"ambiguous"` candidate this
   * typically echoes/derives from `candidateSnapshot.ambiguityReason`; for
   * a conflict it names the conflicting requirement; never a stray
   * explanation for a clarification that doesn't need one. */
  reason: string;
  category: ClarificationCategory;
  /** Which `RequirementCandidate` field(s) this clarification is trying to
   * fill in, e.g. `["value", "unit"]` -- lets a caller/UI highlight the
   * relevant part of the candidate without re-parsing `reason`. */
  affectedFields: readonly string[];
  status: ClarificationStatus;
  /** The user's raw answer text, verbatim -- `null` until answered. Set
   * ONLY on a successful `answered` transition (see `answer-clarification.ts`'s
   * doc comment for why an answer that fails re-interpretation is never
   * persisted here). Never executed, never interpreted as anything but
   * text input to the next `interpretRequirementFromText` call. */
  answerText: string | null;
  answeredAt: string | null;
  /** Set when `status` becomes `"superseded"`: the id of the newer
   * `Clarification` that replaced this one. `null` otherwise. */
  supersededBy: string | null;
  /** Who/what raised this clarification -- always `"agent"` in practice
   * (the deterministic analyzer runs as part of the agent-facing
   * `analyze_requirement_completeness` tool), reusing `EntitySource`
   * rather than inventing a parallel provenance concept, exactly like
   * `RequirementCandidate.source`. */
  source: EntitySource;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface ClarificationInput {
  id?: string;
  projectId: string;
  requirementCandidateId: string;
  candidateSnapshot: RequirementCandidate;
  question: string;
  reason: string;
  category: ClarificationCategory;
  affectedFields?: readonly string[];
  status?: ClarificationStatus;
  answerText?: string | null;
  answeredAt?: string | null;
  supersededBy?: string | null;
  source?: EntitySource;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

/** Every distinct way ANSWERING a clarification can fail -- never a bare
 * `Error("invalid answer")`. Mirrors `RequirementInterpretationErrorKind`'s
 * (P18) granularity exactly:
 *   "invalid_input"       -> clarificationId/answerText malformed (e.g.
 *                             empty answer), or the clarification is not
 *                             `"pending"` (already answered/dismissed/
 *                             superseded)
 *   "not_found"           -> no clarification with that id exists
 *   "model_unavailable"   -> the re-interpretation's underlying
 *                             ModelProvider.generate() call returned
 *                             status:"error"
 *   "answer_insufficient" -> re-interpretation succeeded but the resulting
 *                             candidate is STILL "ambiguous" -- the answer
 *                             did not actually resolve the gap (e.g. a
 *                             non-numeric answer to a numeric question).
 *                             The clarification is left untouched, exactly
 *                             like an ambiguous candidate is never silently
 *                             promoted to "specific" in P18.
 */
export type ClarificationAnswerErrorKind = "invalid_input" | "not_found" | "model_unavailable" | "answer_insufficient";

export const CLARIFICATION_ANSWER_ERROR_KINDS: readonly ClarificationAnswerErrorKind[] = [
  "invalid_input",
  "not_found",
  "model_unavailable",
  "answer_insufficient"
];
