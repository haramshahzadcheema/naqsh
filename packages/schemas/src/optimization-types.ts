import type { EntitySource } from "./types.js";
import type { NumericComparisonOperator } from "./verification-types.js";

/**
 * Phase 23: MULTI-OBJECTIVE OPTIMIZATION.
 *
 * P22 established: Objective -> Requirements -> Candidates -> Experiments ->
 * Deterministic Verification -> Factual Results. P23 adds ONE more
 * deterministic layer on top: Metrics -> Objective measurements -> Candidate
 * comparison -> Tradeoff analysis -> Pareto/weighted optimization. The
 * central rule (brief's own words): "NAQSH may optimize based on VERIFIED /
 * MEASURED engineering results. It must NOT optimize based on arbitrary LLM
 * opinions." Every type below exists to keep that boundary structurally
 * enforced, not merely documented:
 *
 *   - `CandidateMetricValue.status` distinguishes "measured" (backed by a
 *     REAL `VerificationResult`, P16) from "estimated" (a declared/research
 *     figure, never authoritative) from "unavailable" (honestly missing,
 *     never fabricated) -- the brief's own "$500 estimated" vs "$487
 *     verified" example, made structurally impossible to blur (see
 *     `optimization-semantics.ts`, core, for the cross-reference enforcement,
 *     and this file's own `assertCandidateMetricValue`, schemas, for the
 *     shape-level status/provenance consistency rule).
 *   - `OptimizationObjective.direction` is an explicit `"minimize"` /
 *     `"maximize"` enum -- never a fragile convention like negated numbers.
 *   - `OptimizationResult` is always produced by @naqsh/core's PURE,
 *     deterministic `computeOptimizationResult` (`optimization-engine.ts`)
 *     -- never hand-constructed by a tool, and never assignable by Gemini,
 *     matching `VerificationResult`/`ObjectiveSatisfactionResult`'s
 *     identical "no LLM verdict" precedent from P16/P17.
 *
 * Deliberately does NOT duplicate:
 *   - `Objective`/`Requirement`/`Constraint` (P1) -- an `OptimizationObjective`/
 *     `OptimizationConstraint` OPTIONALLY references a real `Requirement.id`/
 *     `Constraint.id` for traceability (`requirementId`/`constraintId`,
 *     never validated for existence here -- matching `ObjectiveConditionOutcome`'s
 *     (P17) identical "dangling references are a read-time concern"
 *     precedent), but never re-describes one. Nothing requires a formal
 *     `Requirement`/`Constraint` to exist first -- `description`/`unit` are
 *     carried directly so an objective/constraint can be defined standalone.
 *   - `NumericComparisonOperator` (P16, `verify.ts`'s own `compareNumeric`)
 *     -- `OptimizationConstraint.operator` reuses it directly rather than
 *     inventing a second comparison-operator vocabulary.
 *   - `VerificationResult`/`Evidence` (P16) -- a "measured"
 *     `CandidateMetricValue` REFERENCES a `VerificationResult.id`, it never
 *     re-embeds pass/fail logic or re-observes the environment.
 *   - `ResearchEvidence` (P21) -- an "estimated" metric sourced from
 *     research REFERENCES a `ResearchEvidence.id`, never duplicates its
 *     claim/excerpt.
 *   - `Candidate`/`Experiment` (P22) -- `CandidateMetricValue.candidateId`/
 *     `.experimentId` reference them by id; optimization never introduces a
 *     second "candidate" concept.
 *   - `compareCandidates`/`CandidateComparisonResult` (P22,
 *     `candidate-comparison.ts`) -- P23 builds a NEW, separate result
 *     (`OptimizationResult`) rather than bolting Pareto/scoring fields onto
 *     the P22 comparison, preserving that file's own explicit "no
 *     scoring/ranking -- that's P23" boundary as a real, still-true fact
 *     about that file, not something P23 quietly violates from the side.
 *
 * No unit CONVERSION system is introduced (the brief's own explicit
 * instruction: "if it does not exist, design the seam cleanly rather than
 * inventing an incomplete universal unit system" -- and `Evidence.unit`'s
 * (P16) own doc comment already confirms none exists anywhere in this
 * repository). `unit` fields here are raw strings, exactly like
 * `Requirement`/`Constraint`/`Check`/`Evidence.unit` already are; a mismatch
 * between an objective/constraint's declared unit and a metric's own unit is
 * detected and reported (`unit_mismatch`, mirroring P16's identical
 * `VerificationReasonKind` precedent) rather than silently compared as if
 * equal.
 */

export type ObjectiveDirection = "minimize" | "maximize";

export const OBJECTIVE_DIRECTIONS: readonly ObjectiveDirection[] = ["minimize", "maximize"];

/**
 * "measured"    -- backed by a REAL, resolvable `VerificationResult` whose
 *                  own `status` is `"pass"` or `"fail"` (never
 *                  `"inconclusive"` -- an inconclusive verification cannot
 *                  honestly back a measured claim). The ONLY status this
 *                  system will treat as authoritative engineering fact.
 * "estimated"   -- a declared figure (human/agent) or one sourced from
 *                  `ResearchEvidence` (P21) -- external or asserted, never
 *                  claimed as a live, verified measurement. The brief's own
 *                  "Estimated cost is $500" example.
 * "unavailable" -- honestly missing. `value` must be `null`. Never silently
 *                  treated as zero, as "feasible," or omitted without record.
 */
export type MetricValueStatus = "measured" | "estimated" | "unavailable";

export const METRIC_VALUE_STATUSES: readonly MetricValueStatus[] = ["measured", "estimated", "unavailable"];

/** Where a `CandidateMetricValue`'s number, if present, actually came from
 * -- the provenance axis `status` alone cannot express (two "estimated"
 * values can come from genuinely different places). */
export type MetricValueProvenanceKind = "verification_result" | "research_evidence" | "declared";

export const METRIC_VALUE_PROVENANCE_KINDS: readonly MetricValueProvenanceKind[] = ["verification_result", "research_evidence", "declared"];

export interface OptimizationObjective {
  id: string;
  /** Identifies WHICH measurable quantity this objective targets (e.g.
   * `"mass"`, `"cost"`) -- the join key `CandidateMetricValue.metricKey`
   * matches against. Free text, not a closed enum: the set of metrics a
   * project cares about is project-specific, the same way `Requirement
   * .category`/`Check.property` are already open strings. */
  metricKey: string;
  description: string;
  direction: ObjectiveDirection;
  /** Raw unit string this objective expects, or `null` if unit doesn't
   * apply/matter. Matches `Requirement.unit`'s exact convention. */
  unit: string | null;
  /** Optional traceability link to a real `Requirement.id` (P1) this
   * objective formalizes -- never validated for existence at the schema
   * layer (see this file's own top doc comment). */
  requirementId: string | null;
  /** `null` means "no weight assigned" -- Pareto/tradeoff analysis still
   * runs, but weighted scoring is skipped for the WHOLE problem unless
   * EVERY objective has an explicit, non-negative, finite weight (enforced
   * by `optimization-engine.ts`, core -- never silently defaulted here or
   * anywhere). This is what makes "never silently assign weights" a fact
   * about the TYPE, not just a convention a caller has to remember. */
  weight: number | null;
  metadata: Record<string, unknown>;
}

export interface OptimizationObjectiveInput {
  id?: string;
  metricKey: string;
  description: string;
  direction: ObjectiveDirection;
  unit?: string | null;
  requirementId?: string | null;
  weight?: number | null;
  metadata?: Record<string, unknown>;
}

export interface OptimizationConstraint {
  id: string;
  metricKey: string;
  description: string;
  /** Reuses P16's `NumericComparisonOperator` (`verify.ts`'s own
   * `compareNumeric`) directly -- never a second comparison vocabulary. */
  operator: NumericComparisonOperator;
  threshold: number;
  unit: string | null;
  /** Optional traceability link to a real `Constraint.id` (P1). */
  constraintId: string | null;
  metadata: Record<string, unknown>;
}

export interface OptimizationConstraintInput {
  id?: string;
  metricKey: string;
  description: string;
  operator: NumericComparisonOperator;
  threshold: number;
  unit?: string | null;
  constraintId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * A single deterministic, engineering-grounded number for one `Candidate`
 * on one metric -- what `OptimizationObjective`/`OptimizationConstraint`
 * actually get evaluated against. APPEND-ONLY once recorded (mirrors
 * `VerificationResult`/`BuildResult`'s identical "never overwrite, only add
 * a new one" discipline -- a metric can genuinely be re-measured or refined
 * from an estimate into a real measurement over time; the OLD record stays
 * a real historical fact, never silently replaced).
 *
 * `status`/`provenanceKind` are NOT independent free choices -- a shape-level
 * consistency rule (`assertCandidateMetricValue`) enforces:
 *   status "measured"    <=> provenanceKind "verification_result"
 *   status "estimated"   <=> provenanceKind "declared" | "research_evidence"
 *   status "unavailable" <=> value is null
 * This is what makes "a model-generated number can never masquerade as a
 * measured engineering result" a structural fact of the TYPE, not merely
 * something a well-behaved caller has to remember. The DEEPER guarantee --
 * that a claimed `verificationResultId` actually resolves to a real,
 * non-inconclusive `VerificationResult` -- is a cross-reference check this
 * schema-only file cannot make (it has no store to consult); that is
 * `record-candidate-metric-value-tool.ts`'s (core) job, mirroring
 * `create-check-tool.ts`'s (P16) identical shape/cross-reference split.
 */
export interface CandidateMetricValue {
  id: string;
  candidateId: string;
  metricKey: string;
  status: MetricValueStatus;
  value: number | null;
  unit: string | null;
  provenanceKind: MetricValueProvenanceKind;
  /** Set iff `provenanceKind === "verification_result"`. */
  verificationResultId: string | null;
  /** Set iff `provenanceKind === "research_evidence"`. */
  researchEvidenceId: string | null;
  /** Optional additional linkage to the `Experiment` (P22) this value was
   * observed during, independent of `provenanceKind`. */
  experimentId: string | null;
  source: EntitySource;
  measuredAt: string;
  metadata: Record<string, unknown>;
}

export interface CandidateMetricValueInput {
  id?: string;
  candidateId: string;
  metricKey: string;
  status?: MetricValueStatus;
  value?: number | null;
  unit?: string | null;
  provenanceKind: MetricValueProvenanceKind;
  verificationResultId?: string | null;
  researchEvidenceId?: string | null;
  experimentId?: string | null;
  source?: EntitySource;
  measuredAt?: string;
  metadata?: Record<string, unknown>;
}

/** The ONE explicit, deterministic normalization method this phase
 * implements (min-max, scaled to `[0, 1]` respecting `direction` --
 * see `optimization-engine.ts` for the exact, documented, edge-case-tested
 * arithmetic). A closed-but-additive enum (mirrors `EntitySource`/
 * `ToolTarget`'s convention) rather than a free string or a pluggable
 * strategy interface -- the brief's own "do not introduce normalization
 * complexity without a clear need" applied literally: ONE method, made
 * explicit and auditable, not a speculative framework. */
export type NormalizationMethod = "min_max";

export const NORMALIZATION_METHODS: readonly NormalizationMethod[] = ["min_max"];

/**
 * A named, reusable optimization configuration for one "candidate set"
 * (mirrors `CandidateComparisonResult`'s (P22) own `(planId, planStepId)`
 * grouping convention, but candidates are named EXPLICITLY by id here,
 * matching `compare_candidates`'s (P22) tool-input convention exactly --
 * a caller who already has a candidate list passes the ids it cares about).
 * Immutable once created (mirrors `Candidate`/`DesignSpecification`'s
 * identical "process record, own store, never `WorldModelState`" pattern --
 * an `OptimizationProblem` is a proposed ANALYSIS configuration, not
 * accepted project truth, exactly as `DesignSpecification` is not).
 */
export interface OptimizationProblem {
  id: string;
  projectId: string;
  projectVersion: number;
  planId: string | null;
  planStepId: string | null;
  candidateIds: string[];
  objectives: OptimizationObjective[];
  constraints: OptimizationConstraint[];
  normalizationMethod: NormalizationMethod;
  source: EntitySource;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface OptimizationProblemInput {
  id?: string;
  projectId: string;
  projectVersion: number;
  planId?: string | null;
  planStepId?: string | null;
  candidateIds: string[];
  objectives: OptimizationObjectiveInput[];
  constraints?: OptimizationConstraintInput[];
  normalizationMethod?: NormalizationMethod;
  source?: EntitySource;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

/** Deterministic feasibility of ONE candidate against the problem's hard
 * constraints. `"unknown"` is a DISTINCT, non-collapsible state (the
 * brief's own explicit "do not silently treat UNKNOWN as FEASIBLE") --
 * produced when a constraint's metric is unavailable for this candidate,
 * never defaulted to `"feasible"` or `"infeasible"`. */
export type CandidateFeasibility = "feasible" | "infeasible" | "unknown";

export const CANDIDATE_FEASIBILITIES: readonly CandidateFeasibility[] = ["feasible", "infeasible", "unknown"];

/** Whether every OBJECTIVE metric this problem needs is present (measured
 * or estimated, doesn't matter which -- see `CandidateMetricSnapshot.status`
 * for that distinction) for this candidate. Distinct from `feasibility`,
 * which is about CONSTRAINTS -- a candidate can be feasible (all
 * constraints satisfied) yet have incomplete objective data (missing an
 * objective metric), and vice versa. */
export type DataCompleteness = "complete" | "incomplete";

export const DATA_COMPLETENESS_VALUES: readonly DataCompleteness[] = ["complete", "incomplete"];

/**
 *   "satisfied"          -- the metric was available and the constraint holds.
 *   "violated"           -- the metric was available and the constraint does NOT hold.
 *   "metric_unavailable" -- no usable `CandidateMetricValue` exists for this
 *                            (candidateId, metricKey) -- `satisfied` is `null`.
 *   "unit_mismatch"      -- a metric value exists but its `unit` disagrees
 *                            with the constraint's declared `unit` -- never
 *                            silently compared as equal (mirrors P16's
 *                            `VerificationReasonKind: "unit_mismatch"`
 *                            precedent exactly). `satisfied` is `null`.
 */
export type ConstraintOutcomeReasonKind = "satisfied" | "violated" | "metric_unavailable" | "unit_mismatch";

export const CONSTRAINT_OUTCOME_REASON_KINDS: readonly ConstraintOutcomeReasonKind[] = ["satisfied", "violated", "metric_unavailable", "unit_mismatch"];

/** A self-contained snapshot of the metric value USED for one candidate's
 * evaluation -- embedded (not a live lookup) so a `CandidateEvaluation`
 * remains a complete, reproducible audit record on its own, mirroring
 * `VerificationResult` embedding `Evidence` (P16) for the identical reason. */
export interface CandidateMetricSnapshot {
  metricKey: string;
  status: MetricValueStatus;
  value: number | null;
  unit: string | null;
  provenanceKind: MetricValueProvenanceKind | null;
  /** The `CandidateMetricValue.id` this snapshot was taken from, or `null`
   * if no value existed for this metric at all. */
  metricValueId: string | null;
}

export interface ConstraintEvaluationOutcome {
  /** `OptimizationConstraint.id` this outcome evaluates. */
  optimizationConstraintId: string;
  metricKey: string;
  operator: NumericComparisonOperator;
  threshold: number;
  unit: string | null;
  actualValue: number | null;
  /** `null` means unknown/undeterminable -- see `reasonKind`. */
  satisfied: boolean | null;
  reasonKind: ConstraintOutcomeReasonKind;
}

/** One objective's worth of the explanation for WHY one candidate
 * dominates another -- the brief's own explicit "Candidate B is
 * Pareto-dominated by Candidate A because: cost: A=700, B=850, A is
 * better..." example, expressed as structured, deterministic data rather
 * than free text a model would have to compose. */
export interface ObjectiveComparisonEntry {
  metricKey: string;
  direction: ObjectiveDirection;
  dominatorValue: number;
  dominatedValue: number;
  /** Whether the dominator is AT LEAST as good as the dominated candidate
   * on this one objective (accounting for `direction`). */
  dominatorAtLeastAsGood: boolean;
  /** Whether the dominator is STRICTLY better on this one objective. Pareto
   * dominance requires this to be `true` for AT LEAST ONE comparison across
   * the whole `DominanceRelation.comparisons` array. */
  dominatorStrictlyBetter: boolean;
}

/** One PROVEN Pareto-dominance relationship between two candidates,
 * complete with the objective-by-objective evidence for it -- see this
 * file's own doc comment on `ObjectiveComparisonEntry`. */
export interface DominanceRelation {
  dominatorCandidateId: string;
  dominatedCandidateId: string;
  comparisons: ObjectiveComparisonEntry[];
}

/** The complete, self-contained evaluation of ONE candidate against an
 * `OptimizationProblem`'s objectives/constraints. */
export interface CandidateEvaluation {
  candidateId: string;
  feasibility: CandidateFeasibility;
  dataCompleteness: DataCompleteness;
  metrics: CandidateMetricSnapshot[];
  constraintResults: ConstraintEvaluationOutcome[];
  /** `true` only when `feasibility === "feasible"` AND `dataCompleteness ===
   * "complete"` -- the ONLY candidates Pareto dominance is computed among
   * (an infeasible or data-incomplete candidate can never dominate or be
   * dominated; it is reported separately -- see `OptimizationResult`'s own
   * `infeasibleCandidateIds`/`unknownFeasibilityCandidateIds`/
   * `incompleteDataCandidateIds`, never silently folded into the Pareto set). */
  paretoEligible: boolean;
  /** `null` unless EVERY objective in the problem had an explicit weight
   * AND this candidate has a usable value for every one of them. Never a
   * fabricated/defaulted number. */
  weightedScore: number | null;
}

/**
 * The deterministic OUTCOME of evaluating an `OptimizationProblem` against
 * `CandidateMetricValue`s -- always produced by @naqsh/core's PURE
 * `computeOptimizationResult` (`optimization-engine.ts`), never
 * hand-constructed by a tool and never assignable by Gemini, matching
 * `VerificationResult`/`ObjectiveSatisfactionResult`'s identical rule.
 * APPEND-ONLY once persisted (mirrors `VerificationResult`/`BuildResult`).
 *
 * Deliberately carries NO "best candidate" field, NO ranking, NO single
 * verdict -- `paretoOptimalCandidateIds` may legitimately contain MULTIPLE
 * ids (the brief's own explicit "there may be multiple Pareto-optimal
 * candidates... do not automatically call a Pareto-optimal candidate 'the
 * best'"). A caller who wants a single choice supplies an explicit
 * `weight` on every objective and reads `weightedScore` themselves; this
 * type never draws that conclusion for them.
 */
export interface OptimizationResult {
  id: string;
  problemId: string;
  projectId: string;
  projectVersion: number;
  candidateEvaluations: CandidateEvaluation[];
  /** Candidates with `paretoEligible: true` that no OTHER paretoEligible
   * candidate dominates. May contain multiple ids (ties/incomparable
   * tradeoffs are the NORMAL case for Pareto analysis, not an error). */
  paretoOptimalCandidateIds: string[];
  /** Candidates with `paretoEligible: true` that at least one other
   * paretoEligible candidate dominates. */
  dominatedCandidateIds: string[];
  infeasibleCandidateIds: string[];
  unknownFeasibilityCandidateIds: string[];
  /** Feasible candidates excluded from Pareto analysis solely because an
   * OBJECTIVE metric (not a constraint) was missing -- kept distinct from
   * `infeasibleCandidateIds` since infeasibility and incomplete objective
   * data are different, independently meaningful facts. */
  incompleteDataCandidateIds: string[];
  dominance: DominanceRelation[];
  /** A fixed literal identifying the deterministic algorithm+version that
   * produced this result -- reproducibility/audit metadata, never a
   * user-facing "explanation." */
  algorithm: string;
  computedAt: string;
  /** Always `"system"` in practice -- this result is computed by
   * deterministic core code, never authored by Gemini, reusing
   * `EntitySource` rather than inventing a parallel provenance concept
   * (matches `Evidence.source`'s (P16) identical convention/reasoning). */
  source: EntitySource;
  metadata: Record<string, unknown>;
}

export interface OptimizationResultInput {
  id?: string;
  problemId: string;
  projectId: string;
  projectVersion: number;
  candidateEvaluations: CandidateEvaluation[];
  paretoOptimalCandidateIds: string[];
  dominatedCandidateIds: string[];
  infeasibleCandidateIds: string[];
  unknownFeasibilityCandidateIds: string[];
  incompleteDataCandidateIds: string[];
  dominance: DominanceRelation[];
  algorithm?: string;
  computedAt?: string;
  source?: EntitySource;
  metadata?: Record<string, unknown>;
}
