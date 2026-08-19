import type { EntitySource } from "./types.js";

/**
 * Phase 22: MULTIPLE CANDIDATE DESIGNS / EXPERIMENTATION.
 *
 *   Plan
 *      ↓
 *   Candidate A ──┐
 *   Candidate B ──┤   (this file)
 *   Candidate C ──┘
 *      ↓
 *   Experiment (types.ts, P1 -- extended additively below, not duplicated)
 *      ↓
 *   VerificationResult (P16, untouched)
 *
 * `Candidate` is a PROCESS/CANDIDATE record -- mirrors `DesignSpecification`
 * (P20) and `Proposal` (P10)'s identical "describes a proposed alternative,
 * not yet accepted project truth" pattern: it lives in its own store
 * (`CandidateStore`, core), NOT in `Project`, NOT added via the Change
 * Model. This is deliberate, not an oversight -- a candidate is exactly as
 * "not yet real" as a `DesignSpecification` is, and P20 already established
 * that a `DesignSpecification` is never `Project` state. `Candidate` is
 * positioned ONE LEVEL ABOVE `DesignSpecification`: where a
 * `DesignSpecification` is "the structured geometry/component content of
 * one alternative," a `Candidate` is "the alternative itself" -- its
 * hypothesis, rationale, and which requirement/constraint/evidence it is
 * trying to satisfy -- and REFERENCES a `DesignSpecification` by id rather
 * than duplicating any of its fields.
 *
 * Deliberately does NOT duplicate:
 *   - `Objective`/`Requirement`/`Constraint` (P1) -- referenced by id
 *     (`relevantRequirementIds`/`relevantConstraintIds`), same convention
 *     `DesignSpecification`/`PlanStep` already use.
 *   - `Plan`/`PlanStep` (P9) -- referenced by `planId`/`planStepId`, same
 *     convention `DesignSpecification` already uses. `PlanAssumption` is
 *     referenced via `assumptionIds`, mirroring `PlanStep.assumptionIds`
 *     exactly (a candidate's assumptions are a SUBSET of the plan's own
 *     recorded assumptions, never a second, parallel assumption list).
 *   - `Proposal` (P10) -- referenced by `proposalId` when a candidate also
 *     has an associated concrete environment-modification proposal.
 *   - `DesignSpecification` (P20) -- referenced by `designSpecificationId`,
 *     never re-described here.
 *   - `Experiment`/`VerificationResult`/`ResearchEvidence` -- a `Candidate`
 *     does NOT embed a list of "its experiments": experiments reference
 *     the candidate that produced them (`Experiment.candidateId`, added
 *     below), not the other way around, because a `Candidate` is
 *     IMMUTABLE once created (matching every process-record store's
 *     "save-once" discipline) while new experiments against it can keep
 *     happening. Querying "which experiments tested this candidate" is a
 *     read-time join (see `candidate-comparison.ts`, core), not a
 *     write-time field.
 *
 * `parentCandidateId` records lineage (a candidate refined/derived from an
 * earlier one) -- mirrors `DesignSpecification.supersedesDesignSpecificationId`/
 * `Plan.supersedesPlanId` in SPIRIT, but is deliberately a plain "origin"
 * reference rather than a strict linear "supersedes" chain: unlike a
 * design revision (v1 -> v2, the same thing improved), sibling candidates
 * are ALTERNATIVES that coexist, not replacements of one another -- a
 * `parentCandidateId` says "candidate D was inspired by / branched from
 * candidate A," not "candidate D replaces candidate A."
 *
 * `status` is a closed, human/agent-set lifecycle -- the SYSTEM never
 * transitions a candidate to a terminal "winner" state automatically
 * (that would be P23's optimization/ranking job). There is deliberately
 * no "selected"/"optimal"/"best" status here: recording that a candidate
 * was chosen is an ordinary `Decision` (P1, unmodified) with
 * `metadata.selectedCandidateId` set, the exact same "reuse the existing
 * extension point" convention P18 already established for
 * `Requirement.metadata.requirementCandidateId` -- not a new concept this
 * file needs to invent.
 */

export type CandidateStatus = "proposed" | "experimenting" | "tested" | "abandoned";

export const CANDIDATE_STATUSES: readonly CandidateStatus[] = ["proposed", "experimenting", "tested", "abandoned"];

export interface Candidate {
  id: string;
  projectId: string;
  /** `Project.version` this candidate was generated against -- staleness
   * signal, mirrors `DesignSpecification.projectVersion`/`Plan.projectVersion`. */
  projectVersion: number;
  /** The `Plan.id` this candidate is an alternative approach for. */
  planId: string;
  /** The specific `PlanStep.id` this candidate addresses, or `null` when
   * the candidate represents an alternative approach to the WHOLE plan
   * rather than one step. Candidates sharing the same
   * `(planId, planStepId)` pair form the natural "candidate set" the P22
   * brief describes -- no separate grouping entity was introduced; the
   * shared plan/step reference already IS the set, the same way multiple
   * `Proposal`s or `DesignSpecification`s for one plan step are already
   * implicitly grouped by sharing `planStepId`. */
  planStepId: string | null;
  /** The structured design content for this alternative, or `null` when a
   * candidate has been proposed conceptually (hypothesis/rationale) but no
   * `DesignSpecification` has been generated for it yet. */
  designSpecificationId: string | null;
  /** An associated concrete environment-modification `Proposal` (P10), or
   * `null` when this candidate has no such proposal (e.g. a from-scratch
   * build candidate realized entirely through `DesignSpecification` ->
   * build, which needs no `Proposal`). */
  proposalId: string | null;
  relevantRequirementIds: string[];
  relevantConstraintIds: string[];
  /** `ResearchEvidence.id`s (P21) this candidate's hypothesis/rationale
   * relies on -- referenced, never duplicated (P22 brief's own "Do NOT
   * duplicate research data inside the candidate" instruction). */
  relevantResearchEvidenceIds: string[];
  /** `Plan.assumptions[].id`s (P9) this candidate relies on -- mirrors
   * `PlanStep.assumptionIds` exactly; never a second assumption list. */
  assumptionIds: string[];
  /** What this candidate claims/tests, e.g. "A ribbed aluminum bracket
   * will meet the 500 N load requirement at lower mass than a solid
   * plate." Required and non-empty -- a candidate with no hypothesis is
   * not yet a real alternative, just an idea. */
  hypothesis: string;
  /** WHY this particular approach was chosen -- distinct from
   * `hypothesis` (WHAT it claims), mirroring `PlanStep.purpose` vs
   * `PlanStep.description`'s identical WHY/WHAT split. */
  rationale: string;
  parentCandidateId: string | null;
  status: CandidateStatus;
  source: EntitySource;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface CandidateInput {
  id?: string;
  projectId: string;
  projectVersion: number;
  planId: string;
  planStepId?: string | null;
  designSpecificationId?: string | null;
  proposalId?: string | null;
  relevantRequirementIds?: string[];
  relevantConstraintIds?: string[];
  relevantResearchEvidenceIds?: string[];
  assumptionIds?: string[];
  hypothesis: string;
  rationale: string;
  parentCandidateId?: string | null;
  status?: CandidateStatus;
  source?: EntitySource;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}
