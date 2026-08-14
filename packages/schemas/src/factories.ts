import { createId, toIsoTimestamp } from "./ids.js";
import type {
  Approval,
  ApprovalInput,
  AuthorizationDecision,
  AuthorizationDecisionInput,
  AutonomyGrant,
  AutonomyGrantInput,
  Change,
  ChangeCause,
  ChangeCauseInput,
  ChangeInput,
  Constraint,
  ConstraintInput,
  Decision,
  DecisionInput,
  EngineeringObject,
  EngineeringObjectInput,
  Experiment,
  ExperimentInput,
  Objective,
  ObjectiveInput,
  Preference,
  PreferenceInput,
  Project,
  ProjectInput,
  Requirement,
  RequirementInput,
  SessionState,
  SessionStateInput,
  Tool,
  ToolInput,
  ToolRequest,
  ToolRequestInput,
  ToolResult,
  ToolResultInput,
  WorldModelState
} from "./types.js";
import {
  assertApproval,
  assertAuthorizationDecision,
  assertAutonomyGrant,
  assertChange,
  assertChangeCause,
  assertConstraint,
  assertDecision,
  assertEngineeringObject,
  assertExperiment,
  assertObjective,
  assertPreference,
  assertProject,
  assertRequirement,
  assertSessionState,
  assertTool,
  assertToolRequest,
  assertToolResult,
  assertWorldModelState
} from "./validators.js";

export function createObjective(input: ObjectiveInput = {}): Objective {
  const objective: Objective = {
    summary: input.summary ?? "",
    source: input.source ?? "human",
    metadata: input.metadata ?? {}
  };
  assertObjective(objective);
  return objective;
}

export function createRequirement(input: RequirementInput = {}): Requirement {
  const requirement: Requirement = {
    id: input.id ?? createId("req"),
    description: input.description ?? "",
    category: input.category ?? "general",
    value: input.value ?? null,
    unit: input.unit ?? null,
    priority: input.priority ?? "medium",
    status: input.status ?? "active",
    source: input.source ?? "human",
    metadata: input.metadata ?? {}
  };
  assertRequirement(requirement);
  return requirement;
}

export function createConstraint(input: ConstraintInput = {}): Constraint {
  const constraint: Constraint = {
    id: input.id ?? createId("con"),
    description: input.description ?? "",
    category: input.category ?? "general",
    value: input.value ?? null,
    unit: input.unit ?? null,
    severity: input.severity ?? "hard",
    status: input.status ?? "active",
    source: input.source ?? "human",
    metadata: input.metadata ?? {}
  };
  assertConstraint(constraint);
  return constraint;
}

export function createEngineeringObject(input: EngineeringObjectInput = {}): EngineeringObject {
  const object: EngineeringObject = {
    id: input.id ?? createId("obj"),
    type: input.type ?? "engineering_object",
    name: input.name ?? "",
    description: input.description ?? "",
    properties: input.properties ?? {},
    relationships: input.relationships ?? [],
    metadata: input.metadata ?? {}
  };
  assertEngineeringObject(object);
  return object;
}

export function createDecision(input: DecisionInput = {}): Decision {
  const decision: Decision = {
    id: input.id ?? createId("dec"),
    statement: input.statement ?? "",
    reason: input.reason ?? "",
    source: input.source ?? "human",
    createdAt: input.createdAt ?? toIsoTimestamp(),
    metadata: input.metadata ?? {}
  };
  assertDecision(decision);
  return decision;
}

export function createExperiment(input: ExperimentInput = {}): Experiment {
  const createdAt = input.createdAt ?? toIsoTimestamp();
  const experiment: Experiment = {
    id: input.id ?? createId("exp"),
    objective: input.objective ?? "",
    hypothesis: input.hypothesis ?? "",
    inputs: input.inputs ?? [],
    status: input.status ?? "planned",
    result: input.result ?? null,
    conclusion: input.conclusion ?? null,
    source: input.source ?? "system",
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    metadata: input.metadata ?? {}
  };
  assertExperiment(experiment);
  return experiment;
}

export function createPreference(input: PreferenceInput = {}): Preference {
  const preference: Preference = {
    id: input.id ?? createId("pref"),
    description: input.description ?? "",
    category: input.category ?? "general",
    value: input.value ?? null,
    source: input.source ?? "human",
    status: input.status ?? "active",
    metadata: input.metadata ?? {}
  };
  assertPreference(preference);
  return preference;
}

export function createProject(input: ProjectInput = {}): Project {
  const createdAt = input.createdAt ?? toIsoTimestamp();
  const project: Project = {
    id: input.id ?? createId("proj"),
    name: input.name ?? "",
    description: input.description ?? "",
    objective: createObjective(input.objective ?? {}),
    requirements: (input.requirements ?? []).map((requirement) => createRequirement(requirement)),
    constraints: (input.constraints ?? []).map((constraint) => createConstraint(constraint)),
    objects: (input.objects ?? []).map((object) => createEngineeringObject(object)),
    decisions: (input.decisions ?? []).map((decision) => createDecision(decision)),
    experiments: (input.experiments ?? []).map((experiment) => createExperiment(experiment)),
    preferences: (input.preferences ?? []).map((preference) => createPreference(preference)),
    metadata: input.metadata ?? {},
    version: input.version ?? 1,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt
  };
  assertProject(project);
  return project;
}

export function createSessionState(input: SessionStateInput = {}): SessionState {
  const session: SessionState = {
    id: input.id ?? createId("sess"),
    projectId: input.projectId ?? null,
    mode: input.mode ?? "idle",
    focusObjectIds: input.focusObjectIds ?? [],
    selectedRequirementIds: input.selectedRequirementIds ?? [],
    selectedConstraintIds: input.selectedConstraintIds ?? [],
    lastObservedAt: input.lastObservedAt ?? null,
    metadata: input.metadata ?? {}
  };
  assertSessionState(session);
  return session;
}

export function createWorldModelState(input: {
  project?: ProjectInput | Project;
  session?: SessionStateInput | SessionState;
}): WorldModelState {
  const project = createProject(input.project ?? {});
  const session = createSessionState(input.session ?? {});
  const state: WorldModelState = { project, session };
  assertWorldModelState(state);
  return state;
}

export function createChangeCause(input: ChangeCauseInput = {}): ChangeCause {
  const cause: ChangeCause = {
    kind: input.kind ?? "system",
    description: input.description ?? ""
  };
  assertChangeCause(cause);
  return Object.freeze(cause);
}

/**
 * Unlike every other createX above, most fields here have no sensible
 * default (see ChangeInput's doc comment) — this factory's job is to fill
 * in the few that do (id/source/cause/createdAt/metadata) and validate the
 * result, not to make a Change out of thin air.
 *
 * The returned Change (and its `cause`/`target` sub-objects) is frozen: a
 * Change is a recorded fact, not a working draft, and `ChangeHistory`
 * stores this exact object by reference — an unfrozen Change would let a
 * caller silently corrupt history after the fact by mutating a reference
 * it still holds. `before`/`after`/`transition`/`metadata` are left
 * unfrozen deliberately: they hold arbitrary caller-shaped data that
 * doesn't belong to this factory to lock down beyond the JSON-safety
 * `assertChange` already enforces.
 */
export function createChange(input: ChangeInput): Change {
  const change: Change = {
    id: input.id ?? createId("chg"),
    sequence: input.sequence,
    parentChangeId: input.parentChangeId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    source: input.source ?? "system",
    cause: createChangeCause(input.cause ?? {}),
    transitionKind: input.transitionKind,
    transition: input.transition,
    target: Object.freeze({ ...input.target }),
    before: input.before ?? null,
    after: input.after ?? null,
    resultingProjectVersion: input.resultingProjectVersion,
    createdAt: input.createdAt ?? toIsoTimestamp(),
    metadata: input.metadata ?? {}
  };
  assertChange(change);
  return Object.freeze(change);
}

/** Recursively freezes a plain object/array tree. Used specifically for a
 * Tool's `inputSchema`/`outputSchema`: the registry returns the SAME Tool
 * object reference on every `getByName` call, so a shallow freeze alone
 * would still let a caller mutate `tool.inputSchema.properties.x` and
 * silently change validation behavior for every future call to that
 * already-registered tool -- the same class of bug the P2 audit fixed for
 * Change by freezing it. Schemas are small, bounded-depth structures, so a
 * plain recursive walk is cheap and safe here. */
function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return Object.freeze(value);
}

/** Builds a Tool definition. `id` is generated (an opaque internal
 * reference); `name` is caller-chosen and is what a ToolRequest/registry
 * lookup actually uses — see Tool's doc comment in types.ts. */
export function createTool(input: ToolInput): Tool {
  const tool: Tool = {
    id: input.id ?? createId("tool"),
    name: input.name,
    description: input.description ?? "",
    version: input.version ?? "0.1.0",
    target: input.target,
    mutation: input.mutation,
    inputSchema: deepFreeze(structuredClone(input.inputSchema)),
    outputSchema: deepFreeze(structuredClone(input.outputSchema)),
    source: input.source ?? "system",
    metadata: input.metadata ?? {}
  };
  assertTool(tool);
  return Object.freeze(tool);
}

export function createToolRequest(input: ToolRequestInput): ToolRequest {
  const request: ToolRequest = {
    id: input.id ?? createId("treq"),
    toolName: input.toolName,
    input: input.input,
    source: input.source ?? "system",
    createdAt: input.createdAt ?? toIsoTimestamp(),
    metadata: input.metadata ?? {}
  };
  assertToolRequest(request);
  return Object.freeze(request);
}

export function createToolResult(input: ToolResultInput): ToolResult {
  const result: ToolResult = {
    id: input.id ?? createId("tres"),
    requestId: input.requestId,
    toolName: input.toolName,
    status: input.status,
    output: input.output ?? null,
    error: input.error ?? null,
    startedAt: input.startedAt,
    completedAt: input.completedAt ?? toIsoTimestamp(),
    metadata: input.metadata ?? {}
  };
  assertToolResult(result);
  return Object.freeze(result);
}

/** Defaults `status` to "pending" when omitted, like every other optional
 * field on every other createX factory -- callers requesting a NEW
 * approval simply don't pass `status` and get "pending". `status` is
 * still settable explicitly because @naqsh/core's ApprovalStore relies on
 * exactly that to reconstruct each updated snapshot after a transition
 * (`createApproval({ ...current, status: "approved", ... })`); it is
 * lifecycle-managed by the store's approve/reject/revoke/consume methods
 * in ordinary use, not because this factory forbids setting it directly. */
export function createApproval(input: ApprovalInput): Approval {
  const approval: Approval = {
    id: input.id ?? createId("appr"),
    toolName: input.toolName,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    status: input.status ?? "pending",
    requestedBy: input.requestedBy ?? "agent",
    decidedBy: input.decidedBy ?? null,
    reason: input.reason ?? "",
    createdAt: input.createdAt ?? toIsoTimestamp(),
    respondedAt: input.respondedAt ?? null,
    expiresAt: input.expiresAt ?? null,
    consumedAt: input.consumedAt ?? null,
    metadata: input.metadata ?? {}
  };
  assertApproval(approval);
  return Object.freeze(approval);
}

/** Defaults `status` to "active" when omitted, for the same reason
 * createApproval defaults to "pending" -- see its doc comment and
 * AutonomyGrantStore. */
export function createAutonomyGrant(input: AutonomyGrantInput): AutonomyGrant {
  const grant: AutonomyGrant = {
    id: input.id ?? createId("grant"),
    toolNames: [...input.toolNames],
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    status: input.status ?? "active",
    grantedBy: input.grantedBy ?? "human",
    reason: input.reason ?? "",
    createdAt: input.createdAt ?? toIsoTimestamp(),
    expiresAt: input.expiresAt ?? null,
    revokedAt: input.revokedAt ?? null,
    revokedBy: input.revokedBy ?? null,
    maxUses: input.maxUses ?? null,
    useCount: input.useCount ?? 0,
    metadata: input.metadata ?? {}
  };
  assertAutonomyGrant(grant);
  return Object.freeze(grant);
}

export function createAuthorizationDecision(input: AuthorizationDecisionInput): AuthorizationDecision {
  const decision: AuthorizationDecision = {
    id: input.id ?? createId("authz"),
    toolName: input.toolName,
    target: input.target,
    autonomyLevel: input.autonomyLevel,
    source: input.source,
    requestId: input.requestId,
    allowed: input.allowed,
    denialReason: input.allowed ? null : (input.denialReason ?? null),
    message: input.message ?? "",
    matchedApprovalId: input.matchedApprovalId ?? null,
    matchedAutonomyGrantId: input.matchedAutonomyGrantId ?? null,
    createdAt: input.createdAt ?? toIsoTimestamp(),
    metadata: input.metadata ?? {}
  };
  assertAuthorizationDecision(decision);
  return Object.freeze(decision);
}
