import type { EntitySource } from "./types.js";

/**
 * Phase 24: LONG-TERM ENGINEERING MEMORY.
 *
 * MEMORY IS NOT THE WORLD MODEL. `WorldModelState` (P1) is what is true
 * NOW; a `MemoryRecord` is what has been LEARNED, DECIDED, ATTEMPTED,
 * OBSERVED, or RECORDED over time. A memory may reference current World
 * Model entities, but it must remain historically meaningful even after
 * the current state changes -- "steel was evaluated during experiment E17
 * but rejected because mass exceeded the requirement" stays true and
 * retrievable forever, even after the project's material later changes
 * again. `MemoryRecord` therefore lives in its OWN store (`MemoryStore`,
 * core), exactly like `Candidate`/`OptimizationProblem`/`Clarification` --
 * never `WorldModelState`, never written via the Change Model.
 *
 * Deliberately does NOT duplicate:
 *   - `Decision`/`Preference` (P1) -- a memory of `kind: "decision"`/
 *     `"preference"` REFERENCES a real `Decision.id`/`Preference.id`
 *     (`references.decisionIds`/`references.preferenceIds`), it never
 *     re-states or replaces either entity. P1 already anticipated this:
 *     `Decision`'s own doc comment calls it "the seed of project memory
 *     (P24)" -- this file is that promise being kept, not a competing
 *     mechanism.
 *   - `Experiment`/`Candidate` (P22), `VerificationResult` (P16),
 *     `OptimizationResult` (P23), `ResearchEvidence`/`Source` (P21),
 *     `Checkpoint` (P15), `Change` (P2), `EngineeringObject`/`Requirement`/
 *     `Constraint` (P1) -- every one of these is referenced by id only
 *     (`MemoryReferences`, below), matching every prior phase's identical
 *     "reference the canonical record, never re-embed its content"
 *     discipline (`Candidate.relevantResearchEvidenceIds`,
 *     `CandidateMetricValue.verificationResultId`, etc.).
 *
 * Provenance is the load-bearing concept here (brief: "Preserve the
 * distinction between observed fact, verified result, research evidence,
 * user statement, model inference, system-generated summary"). Unlike
 * `EntitySource` (WHO/WHAT wrote this record -- reused unchanged on every
 * entity in the repo, including this one), `MemoryProvenanceKind` answers
 * WHAT KIND OF GROUNDING this memory's content rests on. The two axes are
 * independent: an agent (`source: "agent"`) can record a memory grounded
 * in a real `VerificationResult` (`provenanceKind: "verification_result"`)
 * just as easily as one grounded in nothing but a human's own statement
 * (`provenanceKind: "user_statement"`). `assertMemoryRecord` enforces that
 * six of the ten provenance kinds REQUIRE a non-empty reference into the
 * store/entity they claim to be grounded in -- e.g. a "verification_result"
 * memory cannot exist with an empty `references.verificationResultIds`,
 * making "a memory summary can never override/outrank the real verified
 * result it claims to summarize" a structural fact of the type, not a
 * convention a caller has to remember (mirrors `CandidateMetricValue`'s
 * (P23) identical status/provenanceKind consistency discipline).
 *
 * `confidence` is restricted to `provenanceKind: "model_synthesis"` only
 * (never null there either, unless the caller chooses not to state one) --
 * every OTHER provenance kind is grounded in a deterministic record or a
 * plain human statement, neither of which a probabilistic "confidence"
 * number could meaningfully qualify without implying the underlying
 * deterministic fact (a real VerificationResult, a real OptimizationResult)
 * is itself uncertain. This is what makes "do not allow confidence to
 * override deterministic verification" (brief) a type-level fact: a
 * verification-grounded memory literally cannot carry a confidence field
 * that could be read as hedging the verification result it cites.
 */

export type MemoryKind =
  | "decision"
  | "lesson"
  | "failure"
  | "success"
  | "experiment_finding"
  | "verification_finding"
  | "optimization_finding"
  | "research_finding"
  | "preference"
  | "historical_observation";

export const MEMORY_KINDS: readonly MemoryKind[] = [
  "decision",
  "lesson",
  "failure",
  "success",
  "experiment_finding",
  "verification_finding",
  "optimization_finding",
  "research_finding",
  "preference",
  "historical_observation"
];

/**
 * WHAT KIND OF GROUNDING this memory's content rests on -- see this file's
 * own top doc comment. Closed-but-additive, matching `EntitySource`/
 * `ToolTarget`'s convention: extend only when a real new grounding kind
 * exists, never speculatively.
 */
export type MemoryProvenanceKind =
  | "user_statement"
  | "world_model_state"
  | "change_model"
  | "experiment_result"
  | "verification_result"
  | "optimization_result"
  | "research_evidence"
  | "environment_observation"
  | "system_analysis"
  | "model_synthesis";

export const MEMORY_PROVENANCE_KINDS: readonly MemoryProvenanceKind[] = [
  "user_statement",
  "world_model_state",
  "change_model",
  "experiment_result",
  "verification_result",
  "optimization_result",
  "research_evidence",
  "environment_observation",
  "system_analysis",
  "model_synthesis"
];

/**
 * Temporal lifecycle (brief: "Distinguish: created, superseded,
 * active/current, rejected, archived"). "created" and "active/current" are
 * the SAME state here (`"active"`, the state every record starts in and
 * stays in until an explicit transition) -- there is no separate
 * "just-created" state to distinguish from "currently active," matching
 * `Clarification.status`'s (P19) identical "pending is both the initial
 * and the ongoing state" precedent.
 *
 *   active     -- current, retrievable, not superseded/archived/rejected.
 *   superseded -- replaced by a newer MemoryRecord for the same knowledge
 *                 (`supersededByMemoryId` set) -- NEVER deleted, still
 *                 fully retrievable as historical context (brief: "Do not
 *                 delete historical knowledge merely because it is no
 *                 longer current").
 *   archived   -- explicitly set aside as no longer relevant, WITHOUT being
 *                 replaced by anything newer -- distinct from `superseded`
 *                 (there is no successor) and from `rejected` (it was once
 *                 valid, just no longer needed).
 *   rejected   -- found to be incorrect/invalid after creation (most
 *                 commonly: a `model_synthesis` memory a human/system later
 *                 determined was wrong) -- distinct from `archived` (it was
 *                 never actually a reliable record, even at creation).
 */
export type MemoryStatus = "active" | "superseded" | "archived" | "rejected";

export const MEMORY_STATUSES: readonly MemoryStatus[] = ["active", "superseded", "archived", "rejected"];

/**
 * Every cross-reference a `MemoryRecord` may carry -- id-only, never a
 * duplicated/embedded copy of the referenced entity (see this file's own
 * top doc comment). Each array independently defaults to `[]`; a memory
 * grounded in nothing referenceable (e.g. a bare `user_statement`) legally
 * carries every array empty. `assertMemoryRecord` requires specific arrays
 * to be non-empty for specific `provenanceKind`s -- see that function's own
 * doc comment.
 */
export interface MemoryReferences {
  /** `Requirement.id` (P1). */
  requirementIds: string[];
  /** `Constraint.id` (P1). */
  constraintIds: string[];
  /** `Decision.id` (P1). */
  decisionIds: string[];
  /** `Preference.id` (P1). */
  preferenceIds: string[];
  /** `EngineeringObject.id` (P1). */
  objectIds: string[];
  /** `Experiment.id` (P1, extended P22). */
  experimentIds: string[];
  /** `Candidate.id` (P22). */
  candidateIds: string[];
  /** `VerificationResult.id` (P16). */
  verificationResultIds: string[];
  /** `OptimizationResult.id` (P23). */
  optimizationResultIds: string[];
  /** `ResearchEvidence.id` (P21). */
  researchEvidenceIds: string[];
  /** `Source.id` (P21). */
  sourceIds: string[];
  /** `Checkpoint.id` (P15). */
  checkpointIds: string[];
  /** `Change.id` (P2). */
  changeIds: string[];
}

export type MemoryReferencesInput = Partial<MemoryReferences>;

/**
 * A single durable piece of engineering memory. Immutable CONTENT once
 * created (mirrors `Candidate`/`Check`/`OptimizationProblem`'s "process
 * record, no in-place content edit" discipline) -- the only things that
 * ever change after creation are LIFECYCLE fields (`status`,
 * `supersededByMemoryId`, `updatedAt`), applied exclusively by
 * `MemoryStore.archive`/`.supersede` (core), exactly like
 * `Clarification.status`'s (P19) identical "transitions replace the stored
 * record with a new frozen snapshot; the store never hands out a mutable
 * reference" precedent. This is what makes "do not rewrite history" a
 * structural guarantee: a memory's `title`/`content`/`references` can
 * never change after the moment it was recorded, no matter how its
 * lifecycle status later evolves.
 */
export interface MemoryRecord {
  id: string;
  projectId: string;
  /** `Project.version` in effect when this memory was recorded -- the same
   * staleness/context signal `Candidate`/`OptimizationProblem`.
   * `projectVersion` already carry, never a second versioning system. */
  projectVersion: number;
  kind: MemoryKind;
  /** A short, specific summary, e.g. "Candidate B selected over Candidate
   * A." Required and non-empty -- a memory with no title is not yet a
   * retrievable fact, just a draft. */
  title: string;
  /** The actual finding/statement, e.g. "Candidate B was selected because
   * it was the only feasible, verification-passing candidate on the
   * Pareto frontier for the mass/strength tradeoff (see
   * OptimizationResult optresult_1, Experiment experiment_2)." Required
   * and non-empty. Free text -- NAQSH does not attempt to structure
   * arbitrary engineering prose beyond the typed `references` that ground
   * it. */
  content: string;
  provenanceKind: MemoryProvenanceKind;
  /** `null` for every `provenanceKind` except `"model_synthesis"` --
   * enforced by `assertMemoryRecord`. When present, a finite number in
   * `[0, 1]`: the MODEL's own stated confidence in its synthesis, never a
   * measure of whether the underlying engineering fact is true (a
   * deterministic verification result is never "90% confident" -- it is
   * pass, fail, or inconclusive; see `VerificationResult`, P16). */
  confidence: number | null;
  references: MemoryReferences;
  status: MemoryStatus;
  /** Set at creation when this memory is INTENDED to replace an existing
   * one -- a declared, forward-looking claim (mirrors `Plan.
   * supersedesPlanId`/`Proposal.supersedesProposalId`'s identical
   * "forward pointer set on the new record" convention). This field ALONE
   * does not transition the OLD record -- only `MemoryStore.supersede`
   * (core), which cross-checks both records are real and rejects a cycle,
   * actually flips the old record's `status`/`supersededByMemoryId`. A
   * caller that sets this at creation is expected to also call
   * `MemoryStore.supersede` as a follow-up step (typically via the
   * separate `memory_supersede` tool) -- `memory_add` validates that a
   * supplied `supersedesMemoryId` resolves to a real, active, same-project
   * memory, but deliberately does NOT itself apply the transition, to
   * avoid a partial-failure window where a new record could be saved but
   * the old one left un-superseded (see `memory-add-tool.ts`'s own doc
   * comment). */
  supersedesMemoryId: string | null;
  /** Set ONLY by `MemoryStore.supersede` (core) on the OLD record, the
   * moment a newer memory formally replaces it -- mirrors
   * `Clarification.supersededBy`'s (P19) identical field/store-transition
   * split exactly. Non-null if and only if `status === "superseded"`
   * (enforced by `assertMemoryRecord`). */
  supersededByMemoryId: string | null;
  source: EntitySource;
  createdAt: string;
  /** Equals `createdAt` until a lifecycle transition (`archive`/
   * `supersede`) updates it -- content never changes, so this reflects
   * only the most recent LIFECYCLE change, mirroring `Experiment.
   * updatedAt`'s (P1) identical "bumped on each patch" semantics. */
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface MemoryRecordInput {
  id?: string;
  projectId: string;
  projectVersion: number;
  kind: MemoryKind;
  title: string;
  content: string;
  provenanceKind: MemoryProvenanceKind;
  confidence?: number | null;
  references?: MemoryReferencesInput;
  status?: MemoryStatus;
  supersedesMemoryId?: string | null;
  supersededByMemoryId?: string | null;
  source?: EntitySource;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}
