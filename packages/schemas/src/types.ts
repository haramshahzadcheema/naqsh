/**
 * Canonical NAQSH World Model contracts (P1).
 *
 * These types describe the PROJECT, not a conversation transcript. They are
 * intentionally narrower than the long-term vision (see repo root README) —
 * Observations, Proposed/Executed Actions, Verification Results,
 * Alternatives, and Artifacts are NOT modeled yet because no phase up to P1
 * produces them. Each of those will land as an additional entity + factory +
 * validator following the exact same pattern used here, plus a new
 * transition kind in @naqsh/core — an additive change, not a breaking one,
 * because `metadata: Record<string, unknown>` on every entity and the open
 * transition-registry shape in core both exist specifically to make that
 * possible without touching existing entities.
 */

/** Who/what produced a piece of state. Carried on every entity so later
 * phases (research provenance, memory, audit) can filter without guessing. */
export type EntitySource = "human" | "agent" | "environment" | "research" | "import" | "system";

export const ENTITY_SOURCES: readonly EntitySource[] = [
  "human",
  "agent",
  "environment",
  "research",
  "import",
  "system"
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
 * intentionally NOT the event/history log — see @naqsh/core's
 * `updateWorldModel`, which is the seam a future Change Model (P2) wraps to
 * persist the sequence of transitions that produced this state. */
export interface WorldModelState {
  project: Project;
  session: SessionState;
}
