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
 * Every "collection" entity kind a `Project` holds an array of — NOT
 * `project`/`session`/`objective` (singular, non-repeatable concepts that
 * `ChangeTarget.entityType` covers separately with an intentionally open
 * string). Closed-but-additive, matching `EntitySource`/`ToolTarget`'s
 * convention: extend only when a real new collection is added to `Project`.
 * Introduced in P8 to give `EntityRelationship`'s source/target real type
 * safety without reusing `ChangeTarget` (whose openness exists for a
 * different reason — auditing an arbitrary Change, not typing a
 * traversable relationship).
 */
export type EntityKind = "requirement" | "constraint" | "object" | "decision" | "experiment" | "preference";

export const ENTITY_KINDS: readonly EntityKind[] = [
  "requirement",
  "constraint",
  "object",
  "decision",
  "experiment",
  "preference"
];

/**
 * A first-class, queryable link between two World Model entities — e.g.
 * "requirement req_1 is satisfied_by object envobj_2". Deliberately
 * SEPARATE from `EngineeringObject.relationships` (P1, still intentionally
 * `unknown[]`): that field is reserved for CAD/domain-specific structural
 * facts an environment adapter reports (mates, joints, assembly
 * containment — P12+), while `EntityRelationship` is NAQSH's own
 * traceability concept (why a requirement, object, decision, or experiment
 * matters to another) and never touches an `EnvironmentAdapter`. `type` is
 * a freeform label (not a closed enum) — matching `EnvironmentRelationship`
 * (P5) — because NAQSH does not prescribe a fixed relationship vocabulary;
 * a caller (a tool, eventually a planner) chooses meaningful labels like
 * "satisfies", "affects", "informed_by", "tested_by".
 */
export interface EntityRelationship {
  id: string;
  type: string;
  sourceType: EntityKind;
  sourceId: string;
  targetType: EntityKind;
  targetId: string;
  source: EntitySource;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface EntityRelationshipInput {
  id?: string;
  type: string;
  sourceType: EntityKind;
  sourceId: string;
  targetType: EntityKind;
  targetId: string;
  source?: EntitySource;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

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
  relationships: EntityRelationship[];
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
  relationships?: EntityRelationshipInput[];
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

/**
 * The Typed Tool System (P3).
 *
 * A `Tool` is pure metadata — identity, contracts, classification. It never
 * carries a handler function (handlers are behavior, not data: they live
 * only in @naqsh/core's ToolRegistry, exactly like `apply()` for
 * transitions never left core in P1). This is what keeps a Tool
 * serializable and keeps the "no arbitrary execution" boundary real: a
 * Tool cannot smuggle code across a process/network boundary because it
 * has none to smuggle.
 *
 * `inputSchema`/`outputSchema` are `ToolValueSchema` — a small, self-hosted
 * JSON-Schema-compatible subset (type/properties/required/items/enum/
 * description), not a hand-written imperative assert function. Two reasons:
 * it is the ONE declarative definition that both (a) this package's own
 * generic validator enforces at P3's execution boundary, and (b) P7 hands
 * to Gemini's function-calling `parameters` field later, unchanged — the
 * JSON-Schema bridge the P2 audit flagged as a future risk is closed by
 * construction rather than deferred again.
 *
 * `nullable` (P8): every leaf/array/object schema may additionally accept
 * `null` on top of its declared `type`. Added when P8's observation tool
 * became the first real tool needing to describe a field that is
 * genuinely `T | null` in its underlying schemas type (e.g.
 * `ObservationResult.scopeObjectId`) — `ToolValueSchema` has no
 * `oneOf`/union support, so without this a tool author would have to
 * either mis-describe the field (reject legitimately null data) or drop
 * accurate typing altogether. Purely additive: omitted/falsy behaves
 * identically to every schema written before P8.
 */
export type ToolValueSchemaType = "string" | "number" | "boolean" | "null" | "array" | "object";

interface ToolValueSchemaBase {
  description?: string;
  nullable?: boolean;
}

export interface ToolStringSchema extends ToolValueSchemaBase {
  type: "string";
  enum?: string[];
}

export interface ToolNumberSchema extends ToolValueSchemaBase {
  type: "number";
}

export interface ToolBooleanSchema extends ToolValueSchemaBase {
  type: "boolean";
}

export interface ToolNullSchema extends ToolValueSchemaBase {
  type: "null";
}

export interface ToolArraySchema extends ToolValueSchemaBase {
  type: "array";
  items: ToolValueSchema;
}

export interface ToolObjectSchema extends ToolValueSchemaBase {
  type: "object";
  properties: Record<string, ToolValueSchema>;
  required?: string[];
  /** Whether keys not listed in `properties` are allowed. Defaults to
   * `true` (permissive, matching JSON Schema's own default and Gemini/
   * OpenAI function-calling conventions) when omitted — explicit here so
   * "unknown fields" behavior is a documented choice per schema, not an
   * accident of whatever the validator happens to do. */
  additionalProperties?: boolean;
}

export type ToolValueSchema =
  | ToolStringSchema
  | ToolNumberSchema
  | ToolBooleanSchema
  | ToolNullSchema
  | ToolArraySchema
  | ToolObjectSchema;

/**
 * What domain a tool acts on. Deliberately NOT "freecad" / "gemini" /
 * anything vendor-specific — these are the generic categories the P3 brief
 * names, matching `EntitySource`'s "closed but additive" convention:
 * extend this list only when a real producer exists (an EnvironmentAdapter
 * for a new target, a verification engine, etc.), never speculatively.
 */
export type ToolTarget =
  | "world_model"
  | "environment"
  | "verification"
  | "research"
  | "simulation"
  | "robotics"
  | "eda";

export const TOOL_TARGETS: readonly ToolTarget[] = [
  "world_model",
  "environment",
  "verification",
  "research",
  "simulation",
  "robotics",
  "eda"
];

/**
 * Classifies what KIND of effect invoking a tool has — the axis P4
 * (autonomy/approval) will gate on. This is P3's only concession to P4:
 * a classification, not an enforcement mechanism. No policy logic exists
 * anywhere in this package or in @naqsh/core's tool execution boundary.
 */
export type ToolMutationKind = "observe" | "suggest" | "mutate" | "verify";

export const TOOL_MUTATION_KINDS: readonly ToolMutationKind[] = ["observe", "suggest", "mutate", "verify"];

export interface Tool {
  id: string;
  /** The stable, callable identifier (e.g. "inspect_project") — what a
   * ToolRequest names and what the registry is keyed by. Unlike `id`
   * (generated), this is caller-chosen and must be unique in a registry. */
  name: string;
  description: string;
  version: string;
  target: ToolTarget;
  mutation: ToolMutationKind;
  inputSchema: ToolValueSchema;
  outputSchema: ToolValueSchema;
  /** Provenance: where this tool definition came from (who registered it).
   * Reuses EntitySource rather than inventing a parallel concept. */
  source: EntitySource;
  metadata: Record<string, unknown>;
}

export interface ToolInput {
  id?: string;
  name: string;
  description?: string;
  version?: string;
  target: ToolTarget;
  mutation: ToolMutationKind;
  inputSchema: ToolValueSchema;
  outputSchema: ToolValueSchema;
  source?: EntitySource;
  metadata?: Record<string, unknown>;
}

/** A single call attempt against a named tool, before it's known whether
 * the input is even valid. Constructed by @naqsh/core's `executeTool`
 * before validation runs, so a ToolRequest can exist even for a request
 * that gets rejected. */
export interface ToolRequest {
  id: string;
  toolName: string;
  input: unknown;
  source: EntitySource;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface ToolRequestInput {
  id?: string;
  toolName: string;
  input: unknown;
  source?: EntitySource;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export type ToolResultStatus = "success" | "error";

/**
 * Distinguishes every rejection/failure mode named in the P3 brief, plus
 * `duplicate_registration` for the registry's own "prevent duplicate
 * IDs/names" requirement (a registration-time failure, not an
 * execution-time one, but the same taxonomy of "be specific, not
 * Error('failed')" applies).
 */
export type ToolErrorKind =
  | "invalid_input"
  | "unknown_tool"
  | "execution_failure"
  | "invalid_output"
  | "policy_rejected"
  | "unavailable"
  | "duplicate_registration";

export const TOOL_ERROR_KINDS: readonly ToolErrorKind[] = [
  "invalid_input",
  "unknown_tool",
  "execution_failure",
  "invalid_output",
  "policy_rejected",
  "unavailable",
  "duplicate_registration"
];

export interface ToolResultError {
  kind: ToolErrorKind;
  message: string;
}

export interface ToolResult {
  id: string;
  requestId: string;
  toolName: string;
  status: ToolResultStatus;
  /** Present (non-null) iff status is "success". */
  output: unknown;
  /** Present (non-null) iff status is "error". */
  error: ToolResultError | null;
  startedAt: string;
  completedAt: string;
  metadata: Record<string, unknown>;
}

export interface ToolResultInput {
  id?: string;
  requestId: string;
  toolName: string;
  status: ToolResultStatus;
  output?: unknown;
  error?: ToolResultError | null;
  startedAt: string;
  completedAt?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Authorization + Approval (P4).
 *
 * `AutonomyLevel` is an ORDERED progression — index in `AUTONOMY_LEVELS` IS
 * the rank @naqsh/core's authorization logic compares against, so the
 * order below is load-bearing, not just documentation. Each level is a
 * strict superset of what the previous one permits:
 *   observe         -> inspect only, zero mutation
 *   suggest         -> may also reason/propose (still zero mutation)
 *   approved_modify -> may mutate, but only with a matching Approval
 *   autonomous      -> may mutate within an explicit, bounded AutonomyGrant
 *
 * Never treated as a boolean "is autonomous" switch — see AutonomyGrant.
 */
export type AutonomyLevel = "observe" | "suggest" | "approved_modify" | "autonomous";

export const AUTONOMY_LEVELS: readonly AutonomyLevel[] = ["observe", "suggest", "approved_modify", "autonomous"];

/**
 * A structured, single-action authorization record — never a bare
 * `approved: true` flag. Tied to exactly one `toolName` and an optional
 * target scope (`targetType`/`targetId`, same shape/semantics as
 * `ChangeTarget`), so an approval for one action can never accidentally
 * cover a different tool or a different target. Single-use: once
 * `consumedAt` is set by @naqsh/core's ApprovalStore after a successful
 * authorized call, the same approval cannot authorize a second call.
 *
 * `targetType`/`targetId` both `null` means "any target of any type" —
 * the caller requesting approval controls how broad or narrow that is,
 * this type itself doesn't restrict it.
 */
export type ApprovalStatus = "pending" | "approved" | "rejected" | "revoked";

export const APPROVAL_STATUSES: readonly ApprovalStatus[] = ["pending", "approved", "rejected", "revoked"];

export interface Approval {
  id: string;
  toolName: string;
  targetType: string | null;
  targetId: string | null;
  /** P11: which `Proposal` (P10) this approval was requested for, or `null`
   * for a generic tool-level approval not tied to a specific proposal (e.g.
   * a hand-built fixture, or any future non-proposal-driven mutation path).
   * Additive -- every `Approval` created before P11 implicitly had no
   * proposal association, and this field defaults to `null` without
   * changing `evaluateToolAuthorization`'s own tool+target matching
   * semantics at all. Phase 11's agent-loop layer uses this to enforce
   * "approval must be associated with the EXACT proposal it was requested
   * for" on top of (never instead of) P4's existing tool/target
   * authorization -- toolName+target alone cannot distinguish two different
   * proposals that happen to name the same tool and target. */
  proposalId: string | null;
  status: ApprovalStatus;
  /** Who/what asked for this approval (typically "agent"). */
  requestedBy: EntitySource;
  /** Who/what decided it (typically "human"); null while pending. */
  decidedBy: EntitySource | null;
  /** Why it was requested, and/or why it was approved/rejected/revoked —
   * whichever is most recent. Freeform, matching ChangeCause.description's
   * role. */
  reason: string;
  createdAt: string;
  /** When approve()/reject() was called; null while pending. */
  respondedAt: string | null;
  /** Optional expiry. Checked at evaluation time (derived), not swept by
   * a background process -- there is deliberately no "expired" status. */
  expiresAt: string | null;
  /** When this approval was actually used to authorize a call; null if
   * never consumed. Distinct from `respondedAt` (when a human decided)
   * because a human can approve something that's never actually invoked. */
  consumedAt: string | null;
  metadata: Record<string, unknown>;
}

export interface ApprovalInput {
  id?: string;
  toolName: string;
  targetType?: string | null;
  targetId?: string | null;
  proposalId?: string | null;
  status?: ApprovalStatus;
  requestedBy?: EntitySource;
  decidedBy?: EntitySource | null;
  reason?: string;
  createdAt?: string;
  respondedAt?: string | null;
  expiresAt?: string | null;
  consumedAt?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * A bounded grant of AUTONOMOUS execution — explicitly NOT "unrestricted
 * power". Scoped to an explicit allowlist of tool names (`toolNames`,
 * never a wildcard) and, like Approval, an optional target scope. Bounded
 * by `expiresAt` and/or `maxUses`; `useCount` is incremented by
 * @naqsh/core's AutonomyGrantStore each time it authorizes a call.
 * Revocable via `status`.
 */
export type AutonomyGrantStatus = "active" | "revoked";

export const AUTONOMY_GRANT_STATUSES: readonly AutonomyGrantStatus[] = ["active", "revoked"];

export interface AutonomyGrant {
  id: string;
  /** Explicit allowlist -- must be non-empty. No wildcards: an autonomy
   * grant covers exactly the tools named here, never "everything". */
  toolNames: string[];
  targetType: string | null;
  targetId: string | null;
  status: AutonomyGrantStatus;
  grantedBy: EntitySource;
  reason: string;
  createdAt: string;
  expiresAt: string | null;
  /** When revoke() was called; null unless status is "revoked". */
  revokedAt: string | null;
  /** Who/what revoked it; null unless status is "revoked". Mirrors
   * Approval.decidedBy -- a grant with `status: "revoked"` and no record
   * of who revoked it would be exactly the kind of unauditable state
   * transition the P0-P4 foundation audit exists to catch. */
  revokedBy: EntitySource | null;
  /** Optional cap on total uses; null means unbounded by count (still
   * bounded by expiresAt/revocation). */
  maxUses: number | null;
  useCount: number;
  metadata: Record<string, unknown>;
}

export interface AutonomyGrantInput {
  id?: string;
  toolNames: string[];
  targetType?: string | null;
  targetId?: string | null;
  status?: AutonomyGrantStatus;
  grantedBy?: EntitySource;
  reason?: string;
  createdAt?: string;
  expiresAt?: string | null;
  revokedAt?: string | null;
  revokedBy?: EntitySource | null;
  maxUses?: number | null;
  useCount?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Every distinct way an authorization check can deny a call, named
 * specifically enough to answer "why" without string-matching a message —
 * matching every denial path the P4 brief enumerates.
 */
export type AuthorizationDenialReason =
  | "unknown_autonomy_level"
  | "insufficient_autonomy_level"
  | "approval_not_found"
  | "approval_target_mismatch"
  | "approval_required"
  | "approval_rejected"
  | "approval_revoked"
  | "approval_expired"
  | "approval_already_consumed"
  | "autonomy_grant_not_found"
  | "autonomy_grant_target_mismatch"
  | "autonomy_grant_revoked"
  | "autonomy_grant_expired"
  | "autonomy_grant_exhausted";

export const AUTHORIZATION_DENIAL_REASONS: readonly AuthorizationDenialReason[] = [
  "unknown_autonomy_level",
  "insufficient_autonomy_level",
  "approval_not_found",
  "approval_target_mismatch",
  "approval_required",
  "approval_rejected",
  "approval_revoked",
  "approval_expired",
  "approval_already_consumed",
  "autonomy_grant_not_found",
  "autonomy_grant_target_mismatch",
  "autonomy_grant_revoked",
  "autonomy_grant_expired",
  "autonomy_grant_exhausted"
];

/**
 * The auditable record of one authorization evaluation — the "Audit/change
 * event" step in the P4 brief's flow diagram. Produced by
 * @naqsh/core's `evaluateToolAuthorization` for every tool call it
 * evaluates, allowed or denied, so denial is a first-class, inspectable
 * outcome rather than a thrown exception or a silent no-op.
 */
export interface AuthorizationDecision {
  id: string;
  toolName: string;
  target: ChangeTarget | null;
  autonomyLevel: string;
  source: EntitySource;
  requestId: string;
  allowed: boolean;
  denialReason: AuthorizationDenialReason | null;
  message: string;
  matchedApprovalId: string | null;
  matchedAutonomyGrantId: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface AuthorizationDecisionInput {
  id?: string;
  toolName: string;
  target: ChangeTarget | null;
  autonomyLevel: string;
  source: EntitySource;
  requestId: string;
  allowed: boolean;
  denialReason?: AuthorizationDenialReason | null;
  message?: string;
  matchedApprovalId?: string | null;
  matchedAutonomyGrantId?: string | null;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}
