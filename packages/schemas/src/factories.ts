import { createId, toIsoTimestamp } from "./ids.js";
import type {
  EnvironmentDescriptor,
  EnvironmentDescriptorInput,
  EnvironmentHealth,
  EnvironmentHealthInput,
  EnvironmentObject,
  EnvironmentObjectInput,
  EnvironmentOperationResult,
  EnvironmentOperationResultInput,
  EnvironmentProperty,
  EnvironmentPropertyInput,
  EnvironmentRelationship,
  EnvironmentRelationshipInput,
  EnvironmentSession,
  EnvironmentSessionInput
} from "./environment-types.js";
import {
  assertEnvironmentDescriptor,
  assertEnvironmentHealth,
  assertEnvironmentObject,
  assertEnvironmentOperationResult,
  assertEnvironmentProperty,
  assertEnvironmentRelationship,
  assertEnvironmentSession,
  assertModelContext,
  assertModelInvocationResult,
  assertModelProviderDescriptor,
  assertModelRequest,
  assertModelRequestConfig,
  assertModelResponse,
  assertModelToolCallIntent,
  assertModelToolDeclaration
} from "./validators.js";
import type {
  ModelContext,
  ModelContextInput,
  ModelInvocationResult,
  ModelInvocationResultInput,
  ModelProviderDescriptor,
  ModelProviderDescriptorInput,
  ModelRequest,
  ModelRequestConfig,
  ModelRequestConfigInput,
  ModelRequestInput,
  ModelResponse,
  ModelResponseInput,
  ModelToolCallIntent,
  ModelToolCallIntentInput,
  ModelToolDeclaration,
  ModelToolDeclarationInput
} from "./model-types.js";
import { assertObservationResult } from "./validators.js";
import type { ObservationResult, ObservationResultInput } from "./observation-types.js";
import {
  assertAgentLoopRun,
  assertExecutionResult,
  assertPlan,
  assertPlanAssumption,
  assertPlanQuestion,
  assertPlanRisk,
  assertPlanStep,
  assertProposal,
  WorldModelValidationError
} from "./validators.js";
import type { Proposal, ProposalInput } from "./proposal-types.js";
import type { AgentLoopRun, AgentLoopRunInput, ExecutionResult, ExecutionResultInput } from "./agent-loop-types.js";
import type {
  Plan,
  PlanAssumption,
  PlanAssumptionInput,
  PlanInput,
  PlanQuestion,
  PlanQuestionInput,
  PlanRisk,
  PlanRiskInput,
  PlanStep,
  PlanStepInput
} from "./plan-types.js";
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
  EntityRelationship,
  EntityRelationshipInput,
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
  assertEntityRelationship,
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

export function createEntityRelationship(input: EntityRelationshipInput): EntityRelationship {
  const relationship: EntityRelationship = {
    id: input.id ?? createId("rel"),
    type: input.type,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    targetType: input.targetType,
    targetId: input.targetId,
    source: input.source ?? "system",
    createdAt: input.createdAt ?? toIsoTimestamp(),
    metadata: input.metadata ?? {}
  };
  assertEntityRelationship(relationship);
  return relationship;
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
    relationships: (input.relationships ?? []).map((relationship) => createEntityRelationship(relationship)),
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
    proposalId: input.proposalId ?? null,
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
 * AutonomyGrantStore.
 *
 * `toolNames` is deep-frozen, not just the top-level `grant` object:
 * `Object.freeze(grant)` alone leaves the ARRAY `grant.toolNames` points at
 * fully mutable, and `AutonomyGrantStore` hands out this exact object
 * reference from `create()`/`getById()`/`list()` with no defensive copy.
 * Confirmed exploitable during the P0-P8 audit: without this,
 * `grant.toolNames.push("dangerous_tool")` on a returned grant silently
 * expands what an ALREADY-ACTIVE autonomy grant authorizes -- no new
 * Change, no revoke/recreate, nothing for `evaluateAutonomyGrant`
 * (authorization.ts, which reads `grant.toolNames.includes(...)` directly)
 * to catch, since it trusts the stored object's own field. */
export function createAutonomyGrant(input: AutonomyGrantInput): AutonomyGrant {
  const grant: AutonomyGrant = {
    id: input.id ?? createId("grant"),
    toolNames: Object.freeze([...input.toolNames]) as readonly string[] as string[],
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

export function createEnvironmentDescriptor(input: EnvironmentDescriptorInput): EnvironmentDescriptor {
  const descriptor: EnvironmentDescriptor = {
    kind: input.kind,
    name: input.name,
    version: input.version ?? "0.1.0",
    capabilities: [...(input.capabilities ?? [])],
    metadata: input.metadata ?? {}
  };
  assertEnvironmentDescriptor(descriptor);
  return Object.freeze(descriptor);
}

export function createEnvironmentSession(input: EnvironmentSessionInput): EnvironmentSession {
  const session: EnvironmentSession = {
    id: input.id ?? createId("envsess"),
    environmentKind: input.environmentKind,
    status: input.status ?? "connected",
    documentName: input.documentName ?? null,
    openedAt: input.openedAt ?? toIsoTimestamp(),
    metadata: input.metadata ?? {}
  };
  assertEnvironmentSession(session);
  return Object.freeze(session);
}

export function createEnvironmentProperty(input: EnvironmentPropertyInput): EnvironmentProperty {
  const property: EnvironmentProperty = {
    key: input.key,
    value: input.value ?? null,
    readOnly: input.readOnly ?? false
  };
  assertEnvironmentProperty(property);
  return Object.freeze(property);
}

export function createEnvironmentRelationship(input: EnvironmentRelationshipInput): EnvironmentRelationship {
  const relationship: EnvironmentRelationship = {
    type: input.type,
    targetId: input.targetId,
    metadata: input.metadata ?? {}
  };
  assertEnvironmentRelationship(relationship);
  return Object.freeze(relationship);
}

export function createEnvironmentObject(input: EnvironmentObjectInput): EnvironmentObject {
  const object: EnvironmentObject = {
    id: input.id ?? createId("envobj"),
    type: input.type,
    name: input.name,
    properties: (input.properties ?? []).map((property) => createEnvironmentProperty(property)),
    relationships: (input.relationships ?? []).map((relationship) => createEnvironmentRelationship(relationship)),
    metadata: input.metadata ?? {}
  };
  assertEnvironmentObject(object);
  return Object.freeze(object);
}

export function createEnvironmentHealth(input: EnvironmentHealthInput): EnvironmentHealth {
  const health: EnvironmentHealth = {
    status: input.status,
    message: input.message ?? "",
    checkedAt: input.checkedAt ?? toIsoTimestamp()
  };
  assertEnvironmentHealth(health);
  return Object.freeze(health);
}

export function createEnvironmentOperationResult(input: EnvironmentOperationResultInput): EnvironmentOperationResult {
  const result: EnvironmentOperationResult = {
    id: input.id ?? createId("envop"),
    operation: input.operation,
    sessionId: input.sessionId ?? null,
    objectId: input.objectId ?? null,
    status: input.status,
    data: input.data ?? null,
    error: input.error ?? null,
    startedAt: input.startedAt,
    completedAt: input.completedAt ?? toIsoTimestamp(),
    metadata: input.metadata ?? {}
  };
  assertEnvironmentOperationResult(result);
  return Object.freeze(result);
}

export function createModelRequestConfig(input: ModelRequestConfigInput): ModelRequestConfig {
  const config: ModelRequestConfig = {
    modelId: input.modelId,
    temperature: input.temperature ?? null,
    maxOutputTokens: input.maxOutputTokens ?? null,
    timeoutMs: input.timeoutMs ?? null
  };
  assertModelRequestConfig(config);
  return Object.freeze(config);
}

export function createModelToolDeclaration(input: ModelToolDeclarationInput): ModelToolDeclaration {
  const declaration: ModelToolDeclaration = {
    name: input.name,
    description: input.description,
    inputSchema: input.inputSchema,
    mutation: input.mutation,
    target: input.target
  };
  assertModelToolDeclaration(declaration);
  return Object.freeze(declaration);
}

export function createModelContext(input: ModelContextInput = {}): ModelContext {
  const context: ModelContext = {
    projectId: input.projectId ?? null,
    projectName: input.projectName ?? null,
    projectSummary: input.projectSummary ?? null,
    objectiveSummary: input.objectiveSummary ?? null,
    requirementCount: input.requirementCount ?? 0,
    constraintCount: input.constraintCount ?? 0,
    objectCount: input.objectCount ?? 0,
    decisionCount: input.decisionCount ?? 0,
    sessionMode: input.sessionMode ?? null,
    focusObjectIds: [...(input.focusObjectIds ?? [])],
    metadata: input.metadata ?? {}
  };
  assertModelContext(context);
  return Object.freeze(context);
}

export function createModelRequest(input: ModelRequestInput): ModelRequest {
  const request: ModelRequest = {
    id: input.id ?? createId("modelreq"),
    systemInstruction: input.systemInstruction ?? null,
    context: createModelContext(input.context),
    instruction: input.instruction,
    tools: (input.tools ?? []).map((tool) => createModelToolDeclaration(tool)),
    outputSchema: input.outputSchema ?? null,
    config: createModelRequestConfig(input.config),
    sessionId: input.sessionId ?? null,
    createdAt: input.createdAt ?? toIsoTimestamp(),
    metadata: input.metadata ?? {}
  };
  assertModelRequest(request);
  return Object.freeze(request);
}

export function createModelToolCallIntent(input: ModelToolCallIntentInput): ModelToolCallIntent {
  const intent: ModelToolCallIntent = {
    id: input.id ?? createId("modelcall"),
    toolName: input.toolName,
    arguments: input.arguments ?? {}
  };
  assertModelToolCallIntent(intent);
  return Object.freeze(intent);
}

export function createModelResponse(input: ModelResponseInput): ModelResponse {
  const response: ModelResponse = {
    id: input.id ?? createId("modelresp"),
    requestId: input.requestId,
    kind: input.kind,
    text: input.text ?? null,
    structuredResult: input.structuredResult ?? null,
    toolCall: input.toolCall ? createModelToolCallIntent(input.toolCall) : null,
    errorMessage: input.errorMessage ?? null,
    createdAt: input.createdAt ?? toIsoTimestamp(),
    metadata: input.metadata ?? {}
  };
  assertModelResponse(response);
  return Object.freeze(response);
}

export function createModelInvocationResult(input: ModelInvocationResultInput): ModelInvocationResult {
  const result: ModelInvocationResult = {
    id: input.id ?? createId("modelinv"),
    requestId: input.requestId,
    providerId: input.providerId,
    modelId: input.modelId,
    sessionId: input.sessionId ?? null,
    status: input.status,
    response: input.response ?? null,
    error: input.error ?? null,
    startedAt: input.startedAt,
    completedAt: input.completedAt ?? toIsoTimestamp(),
    metadata: input.metadata ?? {}
  };
  assertModelInvocationResult(result);
  return Object.freeze(result);
}

export function createModelProviderDescriptor(input: ModelProviderDescriptorInput): ModelProviderDescriptor {
  const descriptor: ModelProviderDescriptor = {
    providerId: input.providerId,
    modelId: input.modelId,
    supportsToolCalling: input.supportsToolCalling ?? false,
    supportsStructuredOutput: input.supportsStructuredOutput ?? false,
    metadata: input.metadata ?? {}
  };
  assertModelProviderDescriptor(descriptor);
  return Object.freeze(descriptor);
}

/**
 * `structuredClone` BEFORE `deepFreeze` (not after, and not skipped) is
 * load-bearing here, not a style choice. `deepFreeze` alone would freeze
 * whatever reference it's given -- if that reference is the SAME array
 * `WorldModelState.project.requirements` already is (which it is: neither
 * P1's entity factories nor `Project.requirements` itself freeze their
 * output), freezing it in place would permanently freeze the World
 * Model's own live array, breaking `updateWorldModel`'s "always start
 * from a plain, spreadable array" assumption elsewhere. `structuredClone`
 * breaks the reference FIRST, so `deepFreeze` only ever locks an
 * independent copy. Confirmed by direct reproduction during the P8 audit:
 * without this, `observationResult.requirements.push(...)` silently
 * mutated the source project's requirements array.
 */
export function createObservationResult(input: ObservationResultInput): ObservationResult {
  const result: ObservationResult = {
    id: input.id ?? createId("obs"),
    projectId: input.projectId,
    projectVersion: input.projectVersion,
    scope: input.scope,
    scopeObjectId: input.scopeObjectId ?? null,
    objectiveSummary: input.objectiveSummary ?? null,
    requirements: structuredClone(input.requirements ?? []),
    constraints: structuredClone(input.constraints ?? []),
    objects: structuredClone(input.objects ?? []),
    relationships: structuredClone(input.relationships ?? []),
    decisions: structuredClone(input.decisions ?? []),
    experiments: structuredClone(input.experiments ?? []),
    preferences: structuredClone(input.preferences ?? []),
    focusObjectIds: structuredClone(input.focusObjectIds ?? []),
    sessionMode: input.sessionMode ?? "idle",
    missingInformation: structuredClone(input.missingInformation ?? []),
    ambiguityIndicators: structuredClone(input.ambiguityIndicators ?? []),
    source: input.source ?? "system",
    observedAt: input.observedAt ?? toIsoTimestamp(),
    metadata: structuredClone(input.metadata ?? {})
  };
  assertObservationResult(result);
  return deepFreeze(result);
}

/** `structuredClone` throws a raw, unclassified `DOMException` ("could not
 * be cloned") for a non-cloneable value (a function, a Symbol) — leaking
 * that past a factory would violate the one-error-class-per-layer
 * convention every other validation failure in this file follows. Cloning
 * happens before the corresponding assert* runs (defaults must be applied
 * to build the candidate object first), so a clone failure has to be
 * caught and re-thrown as `WorldModelValidationError` here rather than
 * relying on the assert call afterward to catch it — by then it's too
 * late, the throw already escaped. Shared by every factory in this file
 * that needs a defensive independent copy of a caller-supplied
 * array/object field (`Plan`/`PlanStep`, `Proposal`). */
function safeStructuredClone<T>(value: T, path: string): T {
  try {
    return structuredClone(value);
  } catch {
    throw new WorldModelValidationError("invalid_shape", `${path} must be JSON-serializable`);
  }
}

export function createPlanAssumption(input: PlanAssumptionInput): PlanAssumption {
  const assumption: PlanAssumption = {
    id: input.id ?? createId("planasm"),
    description: input.description,
    rationale: input.rationale
  };
  assertPlanAssumption(assumption);
  return Object.freeze(assumption);
}

export function createPlanQuestion(input: PlanQuestionInput): PlanQuestion {
  const question: PlanQuestion = {
    id: input.id ?? createId("planq"),
    question: input.question,
    reason: input.reason
  };
  assertPlanQuestion(question);
  return Object.freeze(question);
}

export function createPlanRisk(input: PlanRiskInput): PlanRisk {
  const risk: PlanRisk = {
    id: input.id ?? createId("planrisk"),
    description: input.description,
    impact: input.impact,
    severity: input.severity
  };
  assertPlanRisk(risk);
  return Object.freeze(risk);
}

export function createPlanStep(input: PlanStepInput): PlanStep {
  const step: PlanStep = {
    id: input.id ?? createId("planstep"),
    order: input.order ?? 0,
    title: input.title,
    description: input.description,
    purpose: input.purpose,
    dependsOn: safeStructuredClone(input.dependsOn ?? [], "planStep.dependsOn"),
    inputs: safeStructuredClone(input.inputs ?? [], "planStep.inputs"),
    expectedOutputs: safeStructuredClone(input.expectedOutputs ?? [], "planStep.expectedOutputs"),
    relevantRequirementIds: safeStructuredClone(input.relevantRequirementIds ?? [], "planStep.relevantRequirementIds"),
    relevantConstraintIds: safeStructuredClone(input.relevantConstraintIds ?? [], "planStep.relevantConstraintIds"),
    relevantObjectIds: safeStructuredClone(input.relevantObjectIds ?? [], "planStep.relevantObjectIds"),
    relevantDecisionIds: safeStructuredClone(input.relevantDecisionIds ?? [], "planStep.relevantDecisionIds"),
    verificationIntent: input.verificationIntent ?? null,
    assumptionIds: safeStructuredClone(input.assumptionIds ?? [], "planStep.assumptionIds"),
    status: input.status ?? "pending",
    metadata: safeStructuredClone(input.metadata ?? {}, "planStep.metadata")
  };
  assertPlanStep(step);
  return deepFreeze(step);
}

/**
 * `structuredClone` before `deepFreeze`, for the exact reason
 * `createObservationResult` needs it (see that factory's doc comment): a
 * caller may still hold the arrays/objects passed in `input` and mutate
 * them after this call returns. Unlike `ObservationResult`, a `Plan` never
 * holds a live reference into `WorldModelState` in the first place — every
 * project-entity reference here is an ID string, never an embedded entity
 * — so there is no analogous "this would freeze the World Model itself"
 * risk; this is still the right defensive default for a value that claims
 * to be an immutable, storable record.
 */
export function createPlan(input: PlanInput): Plan {
  const createdAt = input.createdAt ?? toIsoTimestamp();
  const plan: Plan = {
    id: input.id ?? createId("plan"),
    projectId: input.projectId,
    projectVersion: input.projectVersion,
    observationId: input.observationId,
    objectiveSummary: input.objectiveSummary,
    status: input.status ?? "proposed",
    steps: (input.steps ?? []).map((step) => createPlanStep(step)),
    assumptions: (input.assumptions ?? []).map((assumption) => createPlanAssumption(assumption)),
    unresolvedQuestions: (input.unresolvedQuestions ?? []).map((question) => createPlanQuestion(question)),
    risks: (input.risks ?? []).map((risk) => createPlanRisk(risk)),
    missingInformation: safeStructuredClone(input.missingInformation ?? [], "plan.missingInformation"),
    supersedesPlanId: input.supersedesPlanId ?? null,
    version: input.version ?? 1,
    source: input.source ?? "agent",
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    metadata: safeStructuredClone(input.metadata ?? {}, "plan.metadata")
  };
  assertPlan(plan);
  return deepFreeze(plan);
}

/**
 * `structuredClone` before `deepFreeze`, same reasoning as `createPlan`
 * above: a caller may still hold `input.target`/`input.metadata`/etc and
 * mutate them after this call returns, and `Proposal` claims to be an
 * immutable, storable record. `target` is cloned as a plain spread (rather
 * than reconstructed via a `createChangeTarget` factory — no such factory
 * exists; `Change` itself just builds `target` with a bare
 * `Object.freeze({...input.target})`, see `createChange` above) so this
 * factory doesn't need to know `ChangeTarget`'s internals beyond what
 * `assertChangeTarget` already checks; the final `deepFreeze` call below
 * freezes it along with everything else.
 */
export function createProposal(input: ProposalInput): Proposal {
  const createdAt = input.createdAt ?? toIsoTimestamp();
  const proposal: Proposal = {
    id: input.id ?? createId("proposal"),
    projectId: input.projectId,
    projectVersion: input.projectVersion,
    planId: input.planId,
    planStepId: input.planStepId,
    objectiveSummary: input.objectiveSummary,
    toolName: input.toolName,
    toolTarget: input.toolTarget,
    input: safeStructuredClone(input.input ?? {}, "proposal.input"),
    target: input.target === undefined || input.target === null ? null : safeStructuredClone({ ...input.target }, "proposal.target"),
    rationale: input.rationale,
    expectedEffect: input.expectedEffect,
    relevantRequirementIds: safeStructuredClone(input.relevantRequirementIds ?? [], "proposal.relevantRequirementIds"),
    relevantConstraintIds: safeStructuredClone(input.relevantConstraintIds ?? [], "proposal.relevantConstraintIds"),
    status: input.status ?? "proposed",
    supersedesProposalId: input.supersedesProposalId ?? null,
    version: input.version ?? 1,
    source: input.source ?? "agent",
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    metadata: safeStructuredClone(input.metadata ?? {}, "proposal.metadata")
  };
  assertProposal(proposal);
  return deepFreeze(proposal);
}

/** `toolResult` is cloned+frozen along with everything else via `deepFreeze`
 * below, matching `createChange`'s "a recorded fact, not a working draft"
 * reasoning applied to P11's own execution record. */
export function createExecutionResult(input: ExecutionResultInput): ExecutionResult {
  const result: ExecutionResult = {
    id: input.id ?? createId("execres"),
    proposalId: input.proposalId,
    approvalId: input.approvalId ?? null,
    toolRequestId: input.toolRequestId ?? null,
    outcome: input.outcome,
    toolResult: input.toolResult === undefined ? null : safeStructuredClone(input.toolResult, "executionResult.toolResult"),
    startedAt: input.startedAt,
    completedAt: input.completedAt ?? toIsoTimestamp(),
    metadata: safeStructuredClone(input.metadata ?? {}, "executionResult.metadata")
  };
  assertExecutionResult(result);
  return deepFreeze(result);
}

/**
 * Builds the traceable P11 audit record. Every nested entity
 * (`observationBefore`/`plan`/`proposal`/`approval`/`executionResult`/
 * `observationAfter`) is ALREADY a validated, frozen value by the time it
 * reaches this factory (each was built by its own phase's `createX`) --
 * this factory does not re-validate their internals beyond what
 * `assertAgentLoopRun` already checks, and does not clone them (they are
 * already immutable, so there is nothing to defend against here the way
 * `safeStructuredClone` defends a caller-supplied plain object/array).
 */
export function createAgentLoopRun(input: AgentLoopRunInput): AgentLoopRun {
  const createdAt = input.createdAt ?? toIsoTimestamp();
  const run: AgentLoopRun = {
    id: input.id ?? createId("looprun"),
    projectId: input.projectId,
    observationBefore: input.observationBefore,
    plan: input.plan,
    planStepId: input.planStepId,
    proposal: input.proposal,
    approval: input.approval ?? null,
    executionResult: input.executionResult ?? null,
    observationAfter: input.observationAfter ?? null,
    discrepancy: input.discrepancy ?? null,
    status: input.status ?? "observed",
    source: input.source ?? "agent",
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    metadata: safeStructuredClone(input.metadata ?? {}, "agentLoopRun.metadata")
  };
  assertAgentLoopRun(run);
  return Object.freeze(run);
}
