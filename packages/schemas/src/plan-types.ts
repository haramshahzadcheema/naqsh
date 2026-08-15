import type { EntitySource } from "./types.js";

/**
 * The Plan / Planning contracts (P9).
 *
 * A `Plan` is NAQSH's answer to "what should happen next" — deliberately a
 * SEPARATE concept from `WorldModelState`/`Project`, never a field on
 * either. The World Model is what is currently known to be true about the
 * project; a Plan is what NAQSH PROPOSES should happen next. Generating a
 * plan must never add a requirement, add a decision, modify an object, or
 * mark anything complete — those are all World Model mutations, and a Plan
 * is not one. This is why `Plan` has no `WorldModelTransition` (no
 * `add_plan`/`update_plan_step` entry exists in @naqsh/core's transition
 * registry) and is not reachable from `updateWorldModel` in either
 * direction — see `packages/core/src/planner.ts`'s doc comment for the full
 * boundary explanation and `packages/core/test/repo-boundaries.test.ts`'s
 * P9 guards for how that's enforced structurally, not just by convention.
 *
 * There is deliberately only ONE `Plan` type, not a parallel
 * "PlanProposal" schema — the same design `Approval` already uses
 * (`status: "pending" -> "approved"`, one type, not two). A freshly
 * generated plan is simply a `Plan` with `status: "proposed"`; nothing
 * about it is auto-persisted or auto-approved. `packages/core`'s
 * `generatePlanProposal` is the FUNCTION that produces one; a plan only
 * becomes "stored" once a caller explicitly hands it to a `PlanStore` —
 * exactly like a `Change` only exists once `recordTransition` is called,
 * never implicitly.
 *
 * Every reference a plan step makes to project information — a
 * requirement, a constraint, an object, a decision, another step it
 * assumes — is an ID pointing at a real entity, never free text ("based on
 * what we discussed earlier..."). This is the same traceability discipline
 * `EntityRelationship` (P8) already established, applied to planning:
 * anything a plan step claims to be based on must be independently
 * checkable against the `ObservationResult` the plan was built from (see
 * `packages/core/src/plan-semantics.ts`).
 */

/**
 * A plan's lifecycle. P9 only ever PRODUCES `"proposed"` (`draft` is
 * reserved for a future iterative-refinement flow that doesn't exist yet)
 * and only ever READS/STORES plans — nothing in this phase transitions a
 * plan's status past "proposed". `approved`/`executing`/`completed`/
 * `rejected`/`superseded` are defined now so the shape doesn't have to
 * change when P10 (proposals -> concrete actions) and P11 (the agent loop)
 * actually drive those transitions — the same "define the full enum,
 * populate a subset now" convention `RequirementStatus`/`ExperimentStatus`
 * already use.
 */
export type PlanStatus = "draft" | "proposed" | "approved" | "executing" | "completed" | "rejected" | "superseded";

export const PLAN_STATUSES: readonly PlanStatus[] = [
  "draft",
  "proposed",
  "approved",
  "executing",
  "completed",
  "rejected",
  "superseded"
];

/**
 * A step's own lifecycle. P9 only ever produces `"pending"` — execution
 * semantics (what makes a step `"complete"`, who marks it `"blocked"`) are
 * explicitly out of scope for this phase (see the P9 brief's §2/§26); the
 * remaining members exist so a future execution loop (P11) doesn't need a
 * breaking schema change to record step-level progress.
 */
export type PlanStepStatus = "pending" | "in_progress" | "complete" | "blocked" | "skipped";

export const PLAN_STEP_STATUSES: readonly PlanStepStatus[] = ["pending", "in_progress", "complete", "blocked", "skipped"];

/**
 * Something the plan treats as true FOR PLANNING PURPOSES without it being
 * a confirmed project fact — the "ASSUMED" category the P9 brief requires
 * stays explicit and distinct from "KNOWN" (a real `Requirement`/
 * `Constraint`/etc referenced by id) and "UNKNOWN" (`Plan.missingInformation`).
 * Plan-scoped (not per-step) and referenced by id from `PlanStep.assumptionIds`
 * so the same assumption affecting several steps is recorded once, not
 * copy-pasted — the same reasoning `EntityRelationship` records a link once
 * rather than duplicating it onto every entity it touches.
 */
export interface PlanAssumption {
  id: string;
  description: string;
  /** Why this had to be assumed rather than confirmed — e.g. "no material
   * requirement exists yet; assuming aluminum per the project's stated
   * preference for lightweight parts." */
  rationale: string;
}

export type PlanAssumptionInput = Partial<PlanAssumption> & Pick<PlanAssumption, "description" | "rationale">;

/** Something the plan explicitly does NOT know and needs a human (or a
 * later phase) to resolve — the "UNKNOWN" category made concrete and
 * actionable, distinct from `Plan.missingInformation` (bare structural
 * gaps, mirroring `ObservationResult.missingInformation`) by carrying WHY
 * the answer matters, not just that it's absent. */
export interface PlanQuestion {
  id: string;
  question: string;
  /** What's blocked, or what would change, depending on the answer. */
  reason: string;
}

export type PlanQuestionInput = Partial<PlanQuestion> & Pick<PlanQuestion, "question" | "reason">;

export type PlanRiskSeverity = "low" | "medium" | "high";

export const PLAN_RISK_SEVERITIES: readonly PlanRiskSeverity[] = ["low", "medium", "high"];

export interface PlanRisk {
  id: string;
  description: string;
  /** What happens if this risk materializes. */
  impact: string;
  severity: PlanRiskSeverity;
}

export type PlanRiskInput = Partial<PlanRisk> & Pick<PlanRisk, "description" | "impact" | "severity">;

/**
 * One engineering step in a plan. `dependsOn` is the AUTHORITATIVE
 * dependency signal (a list of other `PlanStep.id`s in the same plan) —
 * `order` is a display/sequencing hint, not a substitute for it, so a
 * future execution loop can eventually run independent steps in parallel
 * rather than being forced into one linear numeric sequence (P9 brief
 * §11: "Do not rely exclusively on numeric ordering").
 *
 * `relevantRequirementIds`/`relevantConstraintIds`/`relevantObjectIds`/
 * `relevantDecisionIds` are the "KNOWN" category made concrete: every id
 * here must resolve to a real entity in the `ObservationResult` the plan
 * was generated from (checked by `packages/core/src/plan-semantics.ts`,
 * never assumed). An empty array is a legitimate answer ("this step isn't
 * based on any specific existing requirement") — absence of a reference is
 * not itself an error, a REFERENCE TO SOMETHING THAT DOESN'T EXIST is.
 */
export interface PlanStep {
  id: string;
  /** Display/sequencing hint — see the field's doc comment above for why
   * this is not the authoritative dependency signal. */
  order: number;
  title: string;
  description: string;
  /** WHY this step exists / what it accomplishes toward the objective —
   * distinct from `description` (WHAT the step involves). */
  purpose: string;
  /** ids of other steps IN THIS PLAN that must happen first. */
  dependsOn: string[];
  /** Freeform description of what this step consumes (e.g. "current
   * geometry", "material property data") — not tied to a specific entity
   * id, since an engineering step's inputs are often descriptive rather
   * than a reference to one existing record. */
  inputs: string[];
  expectedOutputs: string[];
  relevantRequirementIds: string[];
  relevantConstraintIds: string[];
  relevantObjectIds: string[];
  relevantDecisionIds: string[];
  /** What "done correctly" means for this step — a description of intent,
   * not an executable check. Deterministic, automated verification is
   * P16's job; this field exists so a plan can express verification INTENT
   * now without pretending to implement verification early. `null` when a
   * step has no meaningful verification criterion of its own (e.g. a pure
   * research/clarification step). */
  verificationIntent: string | null;
  /** ids into this plan's own `assumptions` list that this step relies on
   * — see `PlanAssumption`'s doc comment for why assumptions are recorded
   * once at the plan level and referenced, not duplicated per step. */
  assumptionIds: string[];
  status: PlanStepStatus;
  metadata: Record<string, unknown>;
}

export type PlanStepInput = Partial<PlanStep> & Pick<PlanStep, "title" | "description" | "purpose">;

/**
 * A structured, inspectable, NON-EXECUTING engineering plan (P9). Produced
 * by `packages/core`'s `generatePlanProposal` from an `ObservationResult`
 * — never constructed by hand from raw `WorldModelState`, and never by
 * Gemini directly (Gemini's structured output is validated and reassembled
 * into a `Plan` by `generatePlanProposal`, the same "LLM output is never
 * automatically authoritative" discipline `ObservationResult`/
 * `ModelResponse` already established).
 *
 * `observationId`/`projectVersion` are the plan's PROVENANCE: which
 * `ObservationResult` (and which version of the World Model) it was
 * generated against, so a caller can later detect a plan has gone stale
 * (the project has changed since) without this type needing to know
 * anything about how staleness detection actually works — that's a query
 * concern, not a storage concern.
 *
 * `supersedesPlanId`/`version` exist so a future revision mechanism (P9
 * brief §14) has somewhere to record "this plan replaces that one" without
 * a breaking schema change — P9 itself never sets `supersedesPlanId` to
 * anything but `null`, and never produces a `version` other than `1`.
 */
export interface Plan {
  id: string;
  projectId: string;
  /** `Project.version` as of the `ObservationResult` this plan was built
   * from — a cheap staleness signal, not a live reference (mirrors
   * `ObservationResult.projectVersion`/`Change.resultingProjectVersion`). */
  projectVersion: number;
  /** The `ObservationResult.id` this plan was generated from — the plan's
   * traceable basis, so "what did NAQSH know when it proposed this" is
   * always answerable. */
  observationId: string;
  /** Copied from the source `ObservationResult.objectiveSummary` at
   * generation time, not re-derived later — a plan describes what it was
   * asked to accomplish AT THE TIME, even if the project's objective text
   * changes afterward. */
  objectiveSummary: string;
  status: PlanStatus;
  steps: PlanStep[];
  assumptions: PlanAssumption[];
  unresolvedQuestions: PlanQuestion[];
  risks: PlanRisk[];
  /** Structural gaps, in the exact same sense as
   * `ObservationResult.missingInformation` (real, deterministic, never
   * fabricated) — seeded FROM the source observation's own
   * `missingInformation` (so a gap the World Model already knew about
   * isn't silently dropped) plus whatever additional gaps plan generation
   * itself identifies. */
  missingInformation: string[];
  /** id of the plan this one revises/replaces, or `null` for an original
   * plan. P9 never sets this to anything but `null` — see this type's own
   * doc comment. */
  supersedesPlanId: string | null;
  version: number;
  /** Provenance: who/what produced this plan. Typically `"agent"` (Gemini
   * proposed it via `generatePlanProposal`) — reuses `EntitySource` rather
   * than inventing a parallel provenance concept, exactly like
   * `ObservationResult.source`. */
  source: EntitySource;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface PlanInput {
  id?: string;
  projectId: string;
  projectVersion: number;
  observationId: string;
  objectiveSummary: string;
  status?: PlanStatus;
  steps?: PlanStepInput[];
  assumptions?: PlanAssumptionInput[];
  unresolvedQuestions?: PlanQuestionInput[];
  risks?: PlanRiskInput[];
  missingInformation?: string[];
  supersedesPlanId?: string | null;
  version?: number;
  source?: EntitySource;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

/** Every distinct way a PLAN GENERATION REQUEST or the resulting structure
 * can fail — never a bare `Error("planning failed")`. Deliberately mirrors
 * `ModelErrorKind`/`ObservationErrorKind`'s granularity, split into "the
 * model call itself failed" vs "the model responded but what it produced
 * doesn't hold together":
 *   "invalid_input"            -> the ObservationResult/options given to
 *                                  generatePlanProposal are malformed
 *                                  (e.g. not a real ObservationResult)
 *   "model_unavailable"        -> the underlying ModelProvider.generate()
 *                                  call itself returned status:"error"
 *                                  (network/auth/timeout/rate-limit/etc)
 *   "invalid_model_output"     -> the model didn't return a
 *                                  structured_result at all (replied with
 *                                  plain text, asked a tool-call, etc)
 *   "malformed_plan_shape"     -> the structured JSON came back but does
 *                                  not assemble into a valid Plan
 *                                  (assertPlan failed)
 *   "semantic_validation_failed" -> the shape is valid but references a
 *                                  step/entity id that doesn't exist, has a
 *                                  dependency cycle, or another semantic
 *                                  violation (see plan-semantics.ts)
 */
export type PlanGenerationErrorKind =
  | "invalid_input"
  | "model_unavailable"
  | "invalid_model_output"
  | "malformed_plan_shape"
  | "semantic_validation_failed";

export const PLAN_GENERATION_ERROR_KINDS: readonly PlanGenerationErrorKind[] = [
  "invalid_input",
  "model_unavailable",
  "invalid_model_output",
  "malformed_plan_shape",
  "semantic_validation_failed"
];
