import type { TransitionKind, WorldModelTransition } from "./transitions.js";

/**
 * Canonical NAQSH World Model contracts (P1) plus the Change Model (P2).
 *
 * These types describe the PROJECT, not a conversation transcript. They are
 * intentionally narrower than the long-term vision (see repo root README) —
 * Observations, Proposed/Executed Actions, Verification Results,
 * Alternatives, and Artifacts are NOT modeled yet because no phase up to P2
 * produces them. Each of those will land as an additional entity + factory +
 * validator following the exact same pattern used here, plus a new
 * transition kind in @naqsh/core's registry — an additive change, not a
 * breaking one, because `metadata: Record<string, unknown>` on every entity
 * and the open transition-registry shape in core both exist specifically to
 * make that possible without touching existing entities.
 */

/**
 * Who/what produced a piece of state. Carried on every entity so later
 * phases (research provenance, memory, audit) can filter without guessing.
 *
 * "verification" and "tool" were added in P2: a Change's provenance must be
 * able to say a state transition was caused by a verification result (P16)
 * or a tool execution (P3) — named explicitly in the P2 brief. Additive
 * only; every existing value and every existing entity's `source` field is
 * unaffected.
 */
export type EntitySource =
  | "human"
  | "agent"
  | "environment"
  | "research"
  | "import"
  | "system"
  | "verification"
  | "tool";

export const ENTITY_SOURCES: readonly EntitySource[] = [
  "human",
  "agent",
  "environment",
  "research",
  "import",
  "system",
  "verification",
  "tool"
];

export interface Objective {
  summary: string;
  source: EntitySource;
  metadata: Record<string, unknown>;
}

export type ObjectiveInput = Partial<Objective>;

export type RequirementPriority = "low" | "medium" | "high";
export type RequirementStatus = "active" | "satisfied" | "rejected" | "superseded";

export interface Requirement {
  id: string;
  description: string;
  category: string;
  value: unknown;
  unit: string | null;
  priority: RequirementPriority;
  status: RequirementStatus;
  source: EntitySource;
  metadata: Record<string, unknown>;
}

export type RequirementInput = Partial<Requirement>;

export type ConstraintSeverity = "hard" | "soft";
export type ConstraintStatus = "active" | "satisfied" | "violated" | "superseded";

export interface Constraint {
  id: string;
  description: string;
  category: string;
  value: unknown;
  unit: string | null;
  severity: ConstraintSeverity;
  status: ConstraintStatus;
  source: EntitySource;
  metadata: Record<string, unknown>;
}

export type ConstraintInput = Partial<Constraint>;

/**
 * Relationships are intentionally unshaped (`unknown[]`) rather than a fixed
 * union. What "relates" two engineering objects (assembly containment,
 * mates/joints, dependency, derived-from) is CAD/domain-specific and isn't
 * needed until an environment adapter (P12+) actually reports relationships.
 * Fixing the shape now would mean guessing; leaving it as a documented
 * extension point lets a later phase introduce a real `Relationship` type
 * without a breaking change to `EngineeringObject`.
 */
export interface EngineeringObject {
  id: string;
  type: string;
  name: string;
  description: string;
  properties: Record<string, unknown>;
  relationships: unknown[];
  metadata: Record<string, unknown>;
}

export type EngineeringObjectInput = Partial<EngineeringObject>;

/** A recorded decision and its rationale. This is the seed of project
 * memory (P24) — every decision already carries `reason`, so later phases
 * can surface "why" without re-deriving it from conversation history. */
export interface Decision {
  id: string;
  statement: string;
  reason: string;
  source: EntitySource;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export type DecisionInput = Partial<Decision>;

export type ExperimentStatus = "planned" | "running" | "complete" | "failed" | "cancelled";

export interface Experiment {
  id: string;
  objective: string;
  hypothesis: string;
  inputs: unknown[];
  status: ExperimentStatus;
  result: unknown;
  conclusion: string | null;
  source: EntitySource;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export type ExperimentInput = Partial<Experiment>;

export type PreferenceStatus = "active" | "inactive";

export interface Preference {
  id: string;
  description: string;
  category: string;
  value: unknown;
  source: EntitySource;
  status: PreferenceStatus;
  metadata: Record<string, unknown>;
}

export type PreferenceInput = Partial<Preference>;

/**
 * The Project is the source of truth for a single engineering effort. It
 * deliberately has NO required geometry/objects — a from-scratch project
 * (no CAD yet, only intent) and an existing-CAD project are the same shape;
 * `objects` is simply empty until an environment adapter populates it or the
 * agent creates the first one. See ADR-0002 for why this is load-bearing.
 */
export interface Project {
  id: string;
  name: string;
  description: string;
  objective: Objective;
  requirements: Requirement[];
  constraints: Constraint[];
  objects: EngineeringObject[];
  decisions: Decision[];
  experiments: Experiment[];
  preferences: Preference[];
  metadata: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectInput {
  id?: string;
  name?: string;
  description?: string;
  objective?: ObjectiveInput;
  requirements?: RequirementInput[];
  constraints?: ConstraintInput[];
  objects?: EngineeringObjectInput[];
  decisions?: DecisionInput[];
  experiments?: ExperimentInput[];
  preferences?: PreferenceInput[];
  metadata?: Record<string, unknown>;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
}

export type SessionMode = "idle" | "reviewing" | "designing" | "executing";

/** Transient, per-interaction focus state (what the human/agent is looking
 * at right now). Deliberately separate from Project: session state is
 * cheap to discard and rebuild, Project state is not. */
export interface SessionState {
  id: string;
  projectId: string | null;
  mode: SessionMode;
  focusObjectIds: string[];
  selectedRequirementIds: string[];
  selectedConstraintIds: string[];
  lastObservedAt: string | null;
  metadata: Record<string, unknown>;
}

export type SessionStateInput = Partial<SessionState>;

/** The composite CURRENT STATE the agent loop reasons over. This is
 * intentionally NOT the event/history log — see `Change` below and
 * @naqsh/core's `ChangeHistory`/`recordTransition`, which wrap
 * `updateWorldModel` to persist the sequence of transitions that produced
 * this state without the reducer itself becoming stateful. */
export interface WorldModelState {
  project: Project;
  session: SessionState;
}

/**
 * What kind of trigger produced a Change. Distinct from `source` (WHO/WHAT
 * — an actor category shared with every other entity via `EntitySource`):
 * `cause` answers WHY a transition happened. Kept intentionally small — add
 * a member only when a real producer exists, exactly like `EntitySource`.
 */
export type ChangeCauseKind =
  | "user_request"
  | "agent_decision"
  | "tool_execution"
  | "environment_sync"
  | "derived_update"
  | "system";

export const CHANGE_CAUSE_KINDS: readonly ChangeCauseKind[] = [
  "user_request",
  "agent_decision",
  "tool_execution",
  "environment_sync",
  "derived_update",
  "system"
];

export interface ChangeCause {
  kind: ChangeCauseKind;
  /** Freeform human-readable "why", e.g. "Make the bracket 20% lighter."
   * May be empty — this is the REQUEST/INTENT half of a Change; `kind`
   * gives it a queryable category without forcing every cause into one. */
  description: string;
}

export type ChangeCauseInput = Partial<ChangeCause>;

/** Identifies exactly which materialized entity a Change touched.
 * `entityId` is null only for project/session-level changes that have no
 * single entity of their own (e.g. `set_project_metadata`). */
export interface ChangeTarget {
  entityType: string;
  entityId: string | null;
}

/**
 * A first-class, serializable record of one applied WorldModelTransition —
 * the Change Model (P2). A Change never mutates: it is written once by
 * `@naqsh/core`'s `recordTransition` and never edited afterward.
 *
 * How the three things P2 must distinguish map onto these fields:
 *   1. REQUEST/INTENT           -> `source` + `cause` (kind + description)
 *   2. ACTUAL STATE TRANSITION  -> `transition` (the literal command applied)
 *   3. RESULTING WORLD MODEL STATE -> `target.before`/`target.after`, i.e.
 *      `before`/`after` below, scoped to the one entity this transition
 *      touched (not a full-project snapshot — see `resultingProjectVersion`
 *      and the P2 report for why full-state duplication is unnecessary:
 *      the full resulting state is always reconstructible by replaying
 *      `transition` through `updateWorldModel` from the prior state).
 *
 * `sequence` is the authoritative ordering key (assigned by ChangeHistory,
 * monotonic, gapless) — NOT `createdAt`. Wall-clock timestamps are not a
 * safe ordering key once background/concurrent work (P25) exists.
 */
export interface Change {
  id: string;
  /** Monotonic position in its ChangeHistory. Starts at 1. */
  sequence: number;
  /** The immediately preceding change's id in the same history, or null
   * for the first change. The seam P15 (checkpoints) walks to rebuild or
   * rewind state. */
  parentChangeId: string | null;
  projectId: string;
  sessionId: string | null;
  source: EntitySource;
  cause: ChangeCause;
  transitionKind: TransitionKind;
  transition: WorldModelTransition;
  target: ChangeTarget;
  /** Entity state before this change, or null if the entity did not exist
   * yet (e.g. an add_* transition). */
  before: unknown;
  /** Entity state after this change, or null if the entity was removed. */
  after: unknown;
  /** `project.version` as of immediately after this change was applied —
   * a cheap denormalized pointer, not a snapshot. */
  resultingProjectVersion: number;
  createdAt: string;
  metadata: Record<string, unknown>;
}

/**
 * Every field a caller must actually decide; `id`/`source`/`cause`/
 * `createdAt`/`metadata` default the same way every other `createX` does.
 * `sequence`/`parentChangeId`/`before`/`after`/`resultingProjectVersion`
 * are NOT optional — they describe a fact that already happened and have
 * no sensible default, matching how e.g. `AddRequirementTransition.
 * requirement` is required rather than defaulted.
 */
export interface ChangeInput {
  id?: string;
  sequence: number;
  parentChangeId: string | null;
  projectId: string;
  sessionId: string | null;
  source?: EntitySource;
  cause?: ChangeCauseInput;
  transitionKind: TransitionKind;
  transition: WorldModelTransition;
  target: ChangeTarget;
  before: unknown;
  after: unknown;
  resultingProjectVersion: number;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}
