import type { ChangeTarget, EntitySource, ToolTarget } from "./types.js";

/**
 * The Proposal contracts (P10) — concrete, inspectable, NON-EXECUTING
 * proposed engineering actions.
 *
 * The pipeline this phase adds:
 *
 *   PLAN -> PLAN STEP -> PROPOSAL -> (later, P11) HUMAN APPROVAL -> EXECUTION
 *
 * A `Proposal` is what NAQSH intends to do — never what already happened.
 * It is, deliberately, NOT a `Change` (P2): a `Change` is the first-class,
 * append-only record of a transition that ALREADY applied to
 * `WorldModelState`; a `Proposal` describes a transition that has NOT
 * applied, may never apply, and — critically — is not reachable from
 * `updateWorldModel` in either direction. Creating a `Proposal` can no more
 * mutate `WorldModelState` than creating a `Plan` (P9) can: nothing in this
 * file, and nothing that constructs a `Proposal`, imports the World Model
 * write path. See `packages/core/src/proposal-generator.ts`'s doc comment
 * and `repo-boundaries.test.ts`'s P10 guards for how that boundary is
 * enforced structurally, not just by convention.
 *
 * A `Proposal` is best understood as "a specific, concrete `Tool` call NAQSH
 * proposes making, and why" — not a bespoke "operation" vocabulary
 * reinvented from scratch. `toolName`/`input` mirror `ToolRequest`'s own
 * shape (P3): the exact `{name, arguments}` pair that WOULD be handed to
 * `executeTool` if this proposal is ever approved. This is what keeps the
 * abstraction genuinely environment-independent (P10's brief requirement):
 * a CAD parameter edit, a new CAD object, a simulation setup, or a
 * manufacturing operation are all just "a call to some registered `Tool`"
 * — the `Tool` system (P3) already IS the generic vocabulary for "an
 * action NAQSH can take," so a proposal is a proposed instance of exactly
 * that, not a second, parallel action-description system.
 *
 * `target` reuses `ChangeTarget` (P2) rather than inventing a new
 * "what this acts on" shape — the identical generic reference `Change`
 * already uses to record what an APPLIED transition touched, now used to
 * record what a NOT-YET-applied one WOULD touch. `entityId: null` is the
 * natural way to represent "this proposal would CREATE something that
 * doesn't have an id yet" (a from-scratch project's first `Proposal` will
 * always have a null-entityId target for exactly this reason — P10 must
 * work when `Project.objects = []`).
 */

/**
 * A proposal's lifecycle. P10 only ever PRODUCES `"proposed"` — there is
 * no `approveProposal`/`rejectProposal`/`executeProposal` function
 * anywhere in this phase, on purpose: approval mechanics belong to a later
 * phase, and execution belongs to P11. The remaining members are defined
 * now, populated later, the same "define the full enum, only produce a
 * subset now" convention `PlanStatus` (P9) already established — so P11
 * doesn't need a breaking schema change just to start setting them.
 * `superseded` exists for the same forward-compatible revision reason
 * `Plan.supersedesPlanId`/`version` do.
 */
export type ProposalStatus = "proposed" | "approved" | "rejected" | "executed" | "superseded";

export const PROPOSAL_STATUSES: readonly ProposalStatus[] = ["proposed", "approved", "rejected", "executed", "superseded"];

/**
 * A structured, inspectable, NON-EXECUTING proposed action. Produced by
 * `packages/core`'s `generateProposal` from an existing `Plan` and one of
 * its `PlanStep`s — never constructed by hand from raw `WorldModelState`,
 * and never trusted directly from Gemini's output (see
 * `proposal-generator.ts`'s doc comment for the full validation pipeline).
 */
export interface Proposal {
  id: string;
  projectId: string;
  /** `Project.version` as of the observation the ORIGINATING PLAN was
   * built from — a staleness signal, mirroring `Plan.projectVersion`.
   * Copied from `plan.projectVersion`, not re-derived. */
  projectVersion: number;
  /** The `Plan.id` this proposal realizes one step of. */
  planId: string;
  /** The `PlanStep.id` (within that plan) this proposal concretely
   * realizes — the required traceability link the P10 brief calls out:
   * "a proposal must not exist as an unexplained orphan." */
  planStepId: string;
  /** Copied from `Plan.objectiveSummary` at creation time — same "a
   * record describes what it was asked to accomplish AT THE TIME"
   * reasoning `Plan.objectiveSummary` itself already documents. There is
   * no separate "objective id" to reference: `Objective` (P1) has no id
   * of its own, it is a singular field on `Project` — copying the text is
   * the honest representation of "originating objective," not a
   * fabricated identifier for a concept that isn't independently
   * identified anywhere else in the schema. */
  objectiveSummary: string;
  /** The name of the registered `Tool` (P3) that WOULD be invoked if this
   * proposal is approved and executed — never a bespoke "operation" enum. */
  toolName: string;
  /** Copied from the real `Tool.target` this proposal's `toolName` names
   * (see `generateProposal`) — the "proposal type/category" the P10
   * brief asks for, expressed via the vocabulary P3 already defined,
   * rather than a second, parallel classification. */
  toolTarget: ToolTarget;
  /** The arguments that WOULD be passed to `toolName` — mirrors
   * `ToolRequest.input`'s shape exactly (P3). JSON-safe, checked more
   * strictly than `ToolRequest.input` itself (which isn't checked at
   * all): a `Proposal` is a long-lived, storable, inspectable record,
   * not a transient execution-time construct, so it earns the same
   * JSON-safety rigor `Plan`/`ObservationResult` already have. */
  input: unknown;
  /** What entity this proposal would act on, or `null` (e.g. a proposal
   * that would CREATE a new entity that doesn't have an id yet). Reuses
   * `ChangeTarget` — see this file's own doc comment for why. */
  target: ChangeTarget | null;
  /** WHY this proposal exists. */
  rationale: string;
  /** What should become true if this proposal is approved and executed.
   * A description of intent, not an executable predicate — deterministic
   * verification that a proposal's effect actually occurred is P16/P17's
   * job, not this one's. */
  expectedEffect: string;
  /** Real requirement ids this proposal is motivated by — must be a
   * subset of the originating `PlanStep.relevantRequirementIds` (checked
   * by `proposal-semantics.ts`'s `validateProposalSemantics`): a proposal
   * may narrow which of its plan step's already-vetted requirements it
   * actually addresses, never introduce a new one the plan step never
   * cited. */
  relevantRequirementIds: string[];
  relevantConstraintIds: string[];
  status: ProposalStatus;
  /** id of the proposal this one revises/replaces, or `null` for an
   * original proposal. P10 never sets this to anything but `null` — see
   * `ProposalStatus`'s own doc comment. */
  supersedesProposalId: string | null;
  version: number;
  /** Provenance: who/what produced this proposal. Typically `"agent"`
   * (Gemini proposed it via `generateProposal`) — reuses `EntitySource`
   * rather than inventing a parallel provenance concept, exactly like
   * `Plan.source`/`ObservationResult.source`. */
  source: EntitySource;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface ProposalInput {
  id?: string;
  projectId: string;
  projectVersion: number;
  planId: string;
  planStepId: string;
  objectiveSummary: string;
  toolName: string;
  toolTarget: ToolTarget;
  input?: unknown;
  target?: ChangeTarget | null;
  rationale: string;
  expectedEffect: string;
  relevantRequirementIds?: string[];
  relevantConstraintIds?: string[];
  status?: ProposalStatus;
  supersedesProposalId?: string | null;
  version?: number;
  source?: EntitySource;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

/** Every distinct way a PROPOSAL GENERATION REQUEST or the resulting
 * structure can fail — never a bare `Error("proposal failed")`. Mirrors
 * `PlanGenerationErrorKind`'s (P9) granularity and reasoning exactly:
 *   "invalid_input"              -> the Plan/planStepId/options given to
 *                                    generateProposal are malformed, or
 *                                    planStepId doesn't name a real step
 *                                    in the given plan
 *   "model_unavailable"          -> the underlying ModelProvider.generate()
 *                                    call itself returned status:"error"
 *   "invalid_model_output"       -> the model didn't return a
 *                                    structured_result at all
 *   "malformed_proposal_shape"   -> the structured JSON came back but does
 *                                    not assemble into a valid Proposal
 *                                    (assertProposal failed)
 *   "semantic_validation_failed" -> the shape is valid but references a
 *                                    step/entity/tool that doesn't exist,
 *                                    or proposes input that doesn't match
 *                                    the named tool's own inputSchema
 */
export type ProposalGenerationErrorKind =
  | "invalid_input"
  | "model_unavailable"
  | "invalid_model_output"
  | "malformed_proposal_shape"
  | "semantic_validation_failed";

export const PROPOSAL_GENERATION_ERROR_KINDS: readonly ProposalGenerationErrorKind[] = [
  "invalid_input",
  "model_unavailable",
  "invalid_model_output",
  "malformed_proposal_shape",
  "semantic_validation_failed"
];
