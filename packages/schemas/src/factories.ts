import { createId, toIsoTimestamp } from "./ids.js";
import {
  UNAVAILABLE_ENVIRONMENT_GEOMETRY,
  type EnvironmentDescriptor,
  type EnvironmentDescriptorInput,
  type EnvironmentDocumentInspection,
  type EnvironmentDocumentInspectionInput,
  type EnvironmentHealth,
  type EnvironmentHealthInput,
  type EnvironmentInspectionError,
  type EnvironmentInspectionErrorInput,
  type EnvironmentObject,
  type EnvironmentObjectGeometry,
  type EnvironmentObjectGeometryInput,
  type EnvironmentObjectInput,
  type EnvironmentOperationResult,
  type EnvironmentOperationResultInput,
  type EnvironmentProperty,
  type EnvironmentPropertyChange,
  type EnvironmentPropertyChangeInput,
  type EnvironmentPropertyInput,
  type EnvironmentRelationship,
  type EnvironmentRelationshipInput,
  type EnvironmentSession,
  type EnvironmentSessionInput
} from "./environment-types.js";
import {
  assertEnvironmentDescriptor,
  assertEnvironmentDocumentInspection,
  assertEnvironmentHealth,
  assertEnvironmentInspectionError,
  assertEnvironmentObject,
  assertEnvironmentObjectGeometry,
  assertEnvironmentOperationResult,
  assertEnvironmentProperty,
  assertEnvironmentPropertyChange,
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
import { assertCandidate } from "./validators.js";
import type { Candidate, CandidateInput } from "./candidate-types.js";
import { assertCandidateMetricValue, assertOptimizationConstraint, assertOptimizationObjective, assertOptimizationProblem, assertOptimizationResult } from "./validators.js";
import type {
  CandidateMetricValue,
  CandidateMetricValueInput,
  OptimizationConstraint,
  OptimizationConstraintInput,
  OptimizationObjective,
  OptimizationObjectiveInput,
  OptimizationProblem,
  OptimizationProblemInput,
  OptimizationResult,
  OptimizationResultInput
} from "./optimization-types.js";
import { assertMemoryRecord } from "./validators.js";
import type { MemoryReferences, MemoryReferencesInput, MemoryRecord, MemoryRecordInput } from "./memory-types.js";
import type { AgentLoopRun, AgentLoopRunInput, ExecutionResult, ExecutionResultInput } from "./agent-loop-types.js";
import { assertCheckpoint, assertCheckpointArtifactRef, assertCheckpointEnvironmentSnapshot } from "./validators.js";
import { assertCheck, assertEvidence, assertVerificationResult } from "./validators.js";
import type { Check, CheckInput, Evidence, EvidenceInput, VerificationResult, VerificationResultInput } from "./verification-types.js";
import { assertObjectiveConditionOutcome, assertObjectiveSatisfactionResult } from "./validators.js";
import type {
  ObjectiveConditionOutcome,
  ObjectiveConditionOutcomeInput,
  ObjectiveSatisfactionResult,
  ObjectiveSatisfactionResultInput
} from "./objective-satisfaction-types.js";
import { assertRequirementCandidate } from "./validators.js";
import type { RequirementCandidate, RequirementCandidateInput } from "./requirement-candidate-types.js";
import { assertClarification } from "./validators.js";
import type { Clarification, ClarificationInput } from "./clarification-types.js";
import { assertDesignComponent, assertDesignRelationship, assertExpectedBuildOutput, assertDesignSpecification } from "./validators.js";
import type {
  DesignComponent,
  DesignComponentInput,
  DesignRelationship,
  DesignRelationshipInput,
  DesignSpecification,
  DesignSpecificationInput,
  ExpectedBuildOutput,
  ExpectedBuildOutputInput
} from "./design-specification-types.js";
import { assertBuildOperation, assertBuildResult } from "./validators.js";
import type { BuildOperation, BuildOperationInput, BuildResult, BuildResultInput } from "./build-types.js";
import {
  assertSource,
  assertResearchEvidence,
  assertResearchRequest,
  assertResearchProviderDescriptor,
  assertResearchSearchRequest,
  assertResearchSourceCandidate,
  assertResearchSearchInvocationResult,
  assertResearchFetchRequest,
  assertResearchFetchContent,
  assertResearchFetchInvocationResult
} from "./validators.js";
import type {
  ResearchEvidence,
  ResearchEvidenceInput,
  ResearchFetchContent,
  ResearchFetchInvocationResult,
  ResearchFetchInvocationResultInput,
  ResearchFetchRequest,
  ResearchFetchRequestInput,
  ResearchProviderDescriptor,
  ResearchRequest,
  ResearchRequestInput,
  ResearchSearchInvocationResult,
  ResearchSearchInvocationResultInput,
  ResearchSearchRequest,
  ResearchSearchRequestInput,
  ResearchSourceCandidate,
  Source,
  SourceInput
} from "./research-types.js";
import type {
  Checkpoint,
  CheckpointArtifactRef,
  CheckpointArtifactRefInput,
  CheckpointEnvironmentSnapshot,
  CheckpointEnvironmentSnapshotInput,
  CheckpointInput
} from "./checkpoint-types.js";
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
    candidateId: input.candidateId ?? null,
    buildResultId: input.buildResultId ?? null,
    verificationResultIds: safeStructuredClone(input.verificationResultIds ?? [], "experiment.verificationResultIds"),
    checkpointBeforeId: input.checkpointBeforeId ?? null,
    checkpointAfterId: input.checkpointAfterId ?? null,
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

/** P21: mirrors `createDecision`'s exact shape -- `retrievedAt` defaults to
 * "now" (a source not yet marked retrieved is a contradiction: you cannot
 * record a source you don't have), `reliability` defaults to `"unknown"`
 * (never silently upgraded), `status` defaults to `"active"`. */
export function createSource(input: SourceInput): Source {
  const createdAt = input.createdAt ?? toIsoTimestamp();
  const source: Source = {
    id: input.id ?? createId("src"),
    locator: input.locator ?? null,
    title: input.title,
    publisher: input.publisher ?? null,
    sourceType: input.sourceType,
    reliability: input.reliability ?? "unknown",
    retrievedAt: input.retrievedAt ?? createdAt,
    publishedAt: input.publishedAt ?? null,
    contentHash: input.contentHash ?? null,
    status: input.status ?? "active",
    source: input.source ?? "research",
    createdAt,
    metadata: safeStructuredClone(input.metadata ?? {}, "source.metadata")
  };
  assertSource(source);
  return Object.freeze(source);
}

/** P21: named `createResearchEvidence`, not `createEvidence` -- that name is
 * already `verification-types.ts`'s P16 factory (see `research-types.ts`'s
 * own doc comment for why these are unrelated concepts that happen to
 * share an English word). */
export function createResearchEvidence(input: ResearchEvidenceInput): ResearchEvidence {
  const createdAt = input.createdAt ?? toIsoTimestamp();
  const evidence: ResearchEvidence = {
    id: input.id ?? createId("evid"),
    sourceId: input.sourceId,
    claim: input.claim,
    excerpt: input.excerpt ?? null,
    confidence: input.confidence ?? "medium",
    relevanceNote: input.relevanceNote ?? null,
    retrievedAt: input.retrievedAt ?? createdAt,
    status: input.status ?? "active",
    source: input.source ?? "research",
    createdAt,
    metadata: safeStructuredClone(input.metadata ?? {}, "researchEvidence.metadata")
  };
  assertResearchEvidence(evidence);
  return Object.freeze(evidence);
}

/** P21: mirrors `createPlan`'s "process/candidate record, own store" shape
 * -- NOT part of `Project`. `purpose` has no default (matching `query`):
 * both are required exactly because the P21 brief's Section 12 insists
 * research must explain WHY it's being performed, not just what to search
 * for. */
export function createResearchRequest(input: ResearchRequestInput): ResearchRequest {
  const createdAt = input.createdAt ?? toIsoTimestamp();
  const request: ResearchRequest = {
    id: input.id ?? createId("research"),
    projectId: input.projectId,
    projectVersion: input.projectVersion,
    query: input.query,
    purpose: input.purpose,
    relatedRequirementIds: safeStructuredClone(input.relatedRequirementIds ?? [], "researchRequest.relatedRequirementIds"),
    relatedConstraintIds: safeStructuredClone(input.relatedConstraintIds ?? [], "researchRequest.relatedConstraintIds"),
    relatedPlanId: input.relatedPlanId ?? null,
    relatedPlanStepId: input.relatedPlanStepId ?? null,
    preferredSourceTypes: safeStructuredClone(input.preferredSourceTypes ?? [], "researchRequest.preferredSourceTypes"),
    maxResults: input.maxResults ?? 5,
    freshnessRequirementDays: input.freshnessRequirementDays ?? null,
    status: input.status ?? "pending",
    source: input.source ?? "agent",
    createdAt,
    metadata: safeStructuredClone(input.metadata ?? {}, "researchRequest.metadata")
  };
  assertResearchRequest(request);
  return Object.freeze(request);
}

// ---------------------------------------------------------------------------
// P21: ResearchProvider wire contract factories -- mirror createModelRequest/
// createModelResponse/createModelInvocationResult's exact shape (P7).
// ---------------------------------------------------------------------------

export function createResearchProviderDescriptor(input: Omit<ResearchProviderDescriptor, "metadata"> & { metadata?: Record<string, unknown> }): ResearchProviderDescriptor {
  const descriptor: ResearchProviderDescriptor = {
    providerId: input.providerId,
    name: input.name,
    version: input.version,
    metadata: input.metadata ?? {}
  };
  assertResearchProviderDescriptor(descriptor);
  return Object.freeze(descriptor);
}

export function createResearchSearchRequest(input: ResearchSearchRequestInput): ResearchSearchRequest {
  const request: ResearchSearchRequest = {
    id: input.id ?? createId("researchsearch"),
    query: input.query,
    maxResults: input.maxResults ?? 5,
    preferredSourceTypes: safeStructuredClone(input.preferredSourceTypes ?? [], "researchSearchRequest.preferredSourceTypes"),
    createdAt: input.createdAt ?? toIsoTimestamp(),
    metadata: safeStructuredClone(input.metadata ?? {}, "researchSearchRequest.metadata")
  };
  assertResearchSearchRequest(request);
  return Object.freeze(request);
}

/** Untrusted provider output -- validated, never trusted, but not deep-frozen
 * against a store (candidates are never persisted as-is; see
 * `research-types.ts`'s own doc comment for why they are not `Source`). */
export function createResearchSourceCandidate(input: Partial<ResearchSourceCandidate> & Pick<ResearchSourceCandidate, "title" | "sourceType" | "snippet">): ResearchSourceCandidate {
  const candidate: ResearchSourceCandidate = {
    locator: input.locator ?? null,
    title: input.title,
    publisher: input.publisher ?? null,
    sourceType: input.sourceType,
    publishedAt: input.publishedAt ?? null,
    snippet: input.snippet
  };
  assertResearchSourceCandidate(candidate);
  return Object.freeze(candidate);
}

export function createResearchSearchInvocationResult(input: ResearchSearchInvocationResultInput): ResearchSearchInvocationResult {
  const result: ResearchSearchInvocationResult = {
    id: input.id ?? createId("researchsearchinv"),
    requestId: input.requestId,
    providerId: input.providerId,
    status: input.status,
    results: input.results ?? null,
    error: input.error ?? null,
    startedAt: input.startedAt,
    completedAt: input.completedAt ?? toIsoTimestamp(),
    metadata: input.metadata ?? {}
  };
  assertResearchSearchInvocationResult(result);
  return Object.freeze(result);
}

export function createResearchFetchRequest(input: ResearchFetchRequestInput): ResearchFetchRequest {
  const request: ResearchFetchRequest = {
    id: input.id ?? createId("researchfetch"),
    locator: input.locator,
    createdAt: input.createdAt ?? toIsoTimestamp(),
    metadata: safeStructuredClone(input.metadata ?? {}, "researchFetchRequest.metadata")
  };
  assertResearchFetchRequest(request);
  return Object.freeze(request);
}

/** Untrusted provider output, same discipline as `createResearchSourceCandidate`. */
export function createResearchFetchContent(input: Partial<ResearchFetchContent> & Pick<ResearchFetchContent, "locator" | "title" | "sourceType" | "excerpt">): ResearchFetchContent {
  const content: ResearchFetchContent = {
    locator: input.locator,
    title: input.title,
    publisher: input.publisher ?? null,
    sourceType: input.sourceType,
    publishedAt: input.publishedAt ?? null,
    retrievedAt: input.retrievedAt ?? toIsoTimestamp(),
    excerpt: input.excerpt,
    contentHash: input.contentHash ?? null
  };
  assertResearchFetchContent(content);
  return Object.freeze(content);
}

export function createResearchFetchInvocationResult(input: ResearchFetchInvocationResultInput): ResearchFetchInvocationResult {
  const result: ResearchFetchInvocationResult = {
    id: input.id ?? createId("researchfetchinv"),
    requestId: input.requestId,
    providerId: input.providerId,
    status: input.status,
    content: input.content ?? null,
    error: input.error ?? null,
    startedAt: input.startedAt,
    completedAt: input.completedAt ?? toIsoTimestamp(),
    metadata: input.metadata ?? {}
  };
  assertResearchFetchInvocationResult(result);
  return Object.freeze(result);
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
    sources: (input.sources ?? []).map((source) => createSource(source)),
    researchEvidence: (input.researchEvidence ?? []).map((evidence) => createResearchEvidence(evidence)),
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

export function createEnvironmentPropertyChange(input: EnvironmentPropertyChangeInput): EnvironmentPropertyChange {
  const change: EnvironmentPropertyChange = {
    key: input.key,
    before: input.before ?? null,
    requested: input.requested,
    after: input.after ?? null
  };
  assertEnvironmentPropertyChange(change);
  return Object.freeze(change);
}

export function createEnvironmentObjectGeometry(input: EnvironmentObjectGeometryInput = {}): EnvironmentObjectGeometry {
  const geometry: EnvironmentObjectGeometry = {
    available: input.available ?? false,
    reason: input.reason ?? null,
    valid: input.valid ?? null,
    boundingBox: input.boundingBox ?? null,
    volume: input.volume ?? null,
    surfaceArea: input.surfaceArea ?? null,
    centerOfMass: input.centerOfMass ?? null,
    solidCount: input.solidCount ?? null,
    faceCount: input.faceCount ?? null,
    edgeCount: input.edgeCount ?? null,
    vertexCount: input.vertexCount ?? null,
    shapeType: input.shapeType ?? null
  };
  assertEnvironmentObjectGeometry(geometry);
  return Object.freeze(geometry);
}

export function createEnvironmentObject(input: EnvironmentObjectInput): EnvironmentObject {
  const object: EnvironmentObject = {
    id: input.id ?? createId("envobj"),
    type: input.type,
    name: input.name,
    genericType: input.genericType ?? "unknown",
    parentId: input.parentId ?? null,
    visible: input.visible ?? null,
    geometry: input.geometry ? createEnvironmentObjectGeometry(input.geometry) : UNAVAILABLE_ENVIRONMENT_GEOMETRY,
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

export function createEnvironmentInspectionError(input: EnvironmentInspectionErrorInput): EnvironmentInspectionError {
  const error: EnvironmentInspectionError = {
    kind: input.kind,
    objectId: input.objectId ?? null,
    message: input.message
  };
  assertEnvironmentInspectionError(error);
  return Object.freeze(error);
}

export function createEnvironmentDocumentInspection(input: EnvironmentDocumentInspectionInput): EnvironmentDocumentInspection {
  const inspection: EnvironmentDocumentInspection = {
    environmentKind: input.environmentKind,
    documentId: input.documentId ?? null,
    documentName: input.documentName ?? null,
    filePath: input.filePath ?? null,
    objectCount: input.objectCount,
    objectIds: [...(input.objectIds ?? [])],
    rootObjectIds: [...(input.rootObjectIds ?? [])],
    inspectedAt: input.inspectedAt ?? toIsoTimestamp(),
    environmentVersion: input.environmentVersion ?? null,
    warnings: [...(input.warnings ?? [])],
    unsupportedFeatures: [...(input.unsupportedFeatures ?? [])],
    inspectionErrors: (input.inspectionErrors ?? []).map((error) => createEnvironmentInspectionError(error)),
    metadata: input.metadata ?? {}
  };
  assertEnvironmentDocumentInspection(inspection);
  return Object.freeze(inspection);
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

/** Builds a `Candidate` (P22) -- mirrors `createProposal`'s exact shape.
 * `status` defaults to `"proposed"` (a freshly created candidate is
 * exactly that -- not yet experimented on); nothing in this factory ever
 * produces `"tested"`/`"abandoned"` unless the caller explicitly asks for
 * it, matching `DesignSpecificationStatus`'s identical "only produce a
 * documented subset by default" discipline. */
export function createCandidate(input: CandidateInput): Candidate {
  const createdAt = input.createdAt ?? toIsoTimestamp();
  const candidate: Candidate = {
    id: input.id ?? createId("candidate"),
    projectId: input.projectId,
    projectVersion: input.projectVersion,
    planId: input.planId,
    planStepId: input.planStepId ?? null,
    designSpecificationId: input.designSpecificationId ?? null,
    proposalId: input.proposalId ?? null,
    relevantRequirementIds: safeStructuredClone(input.relevantRequirementIds ?? [], "candidate.relevantRequirementIds"),
    relevantConstraintIds: safeStructuredClone(input.relevantConstraintIds ?? [], "candidate.relevantConstraintIds"),
    relevantResearchEvidenceIds: safeStructuredClone(input.relevantResearchEvidenceIds ?? [], "candidate.relevantResearchEvidenceIds"),
    assumptionIds: safeStructuredClone(input.assumptionIds ?? [], "candidate.assumptionIds"),
    hypothesis: input.hypothesis,
    rationale: input.rationale,
    parentCandidateId: input.parentCandidateId ?? null,
    status: input.status ?? "proposed",
    source: input.source ?? "agent",
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    metadata: safeStructuredClone(input.metadata ?? {}, "candidate.metadata")
  };
  assertCandidate(candidate);
  return deepFreeze(candidate);
}

/** Builds an `OptimizationObjective` (P23). `weight` defaults to `null`
 * ("no weight assigned yet") -- never invented. */
export function createOptimizationObjective(input: OptimizationObjectiveInput): OptimizationObjective {
  const objective: OptimizationObjective = {
    id: input.id ?? createId("optobjective"),
    metricKey: input.metricKey,
    description: input.description,
    direction: input.direction,
    unit: input.unit ?? null,
    requirementId: input.requirementId ?? null,
    weight: input.weight ?? null,
    metadata: safeStructuredClone(input.metadata ?? {}, "optimizationObjective.metadata")
  };
  assertOptimizationObjective(objective);
  return deepFreeze(objective);
}

/** Builds an `OptimizationConstraint` (P23). Reuses `NumericComparisonOperator`
 * (P16) directly -- no second comparison vocabulary. */
export function createOptimizationConstraint(input: OptimizationConstraintInput): OptimizationConstraint {
  const constraint: OptimizationConstraint = {
    id: input.id ?? createId("optconstraint"),
    metricKey: input.metricKey,
    description: input.description,
    operator: input.operator,
    threshold: input.threshold,
    unit: input.unit ?? null,
    constraintId: input.constraintId ?? null,
    metadata: safeStructuredClone(input.metadata ?? {}, "optimizationConstraint.metadata")
  };
  assertOptimizationConstraint(constraint);
  return deepFreeze(constraint);
}

/** Builds a `CandidateMetricValue` (P23). `status` defaults to `"measured"`
 * ONLY as a type default -- the status/provenanceKind/value consistency
 * rule (`assertCandidateMetricValue`) means an unsupported combination is
 * rejected outright, so this default never silently produces an
 * unauthoritative "measured" claim; a caller recording an estimate MUST
 * pass `status: "estimated"` explicitly. */
export function createCandidateMetricValue(input: CandidateMetricValueInput): CandidateMetricValue {
  const metricValue: CandidateMetricValue = {
    id: input.id ?? createId("metricvalue"),
    candidateId: input.candidateId,
    metricKey: input.metricKey,
    status: input.status ?? "measured",
    value: input.value ?? null,
    unit: input.unit ?? null,
    provenanceKind: input.provenanceKind,
    verificationResultId: input.verificationResultId ?? null,
    researchEvidenceId: input.researchEvidenceId ?? null,
    experimentId: input.experimentId ?? null,
    source: input.source ?? "agent",
    measuredAt: input.measuredAt ?? toIsoTimestamp(),
    metadata: safeStructuredClone(input.metadata ?? {}, "candidateMetricValue.metadata")
  };
  assertCandidateMetricValue(metricValue);
  return deepFreeze(metricValue);
}

/** Builds an `OptimizationProblem` (P23) -- mirrors `createCandidate`'s
 * exact shape. `objectives`/`constraints` are built through their own
 * factories first (each independently validated), matching
 * `createDesignSpecification`'s identical "build nested entities through
 * their own factory, then validate the whole" precedent. */
export function createOptimizationProblem(input: OptimizationProblemInput): OptimizationProblem {
  const problem: OptimizationProblem = {
    id: input.id ?? createId("optproblem"),
    projectId: input.projectId,
    projectVersion: input.projectVersion,
    planId: input.planId ?? null,
    planStepId: input.planStepId ?? null,
    candidateIds: safeStructuredClone(input.candidateIds, "optimizationProblem.candidateIds"),
    objectives: input.objectives.map((objective) => createOptimizationObjective(objective)),
    constraints: (input.constraints ?? []).map((constraint) => createOptimizationConstraint(constraint)),
    normalizationMethod: input.normalizationMethod ?? "min_max",
    source: input.source ?? "agent",
    createdAt: input.createdAt ?? toIsoTimestamp(),
    metadata: safeStructuredClone(input.metadata ?? {}, "optimizationProblem.metadata")
  };
  assertOptimizationProblem(problem);
  return deepFreeze(problem);
}

/** Builds an `OptimizationResult` (P23) -- ALWAYS called from
 * `optimization-engine.ts`'s (core) pure `computeOptimizationResult`, never
 * hand-constructed by a tool (mirrors `createVerificationResult`'s
 * identical "no LLM verdict" precedent). `candidateEvaluations`/`dominance`
 * are accepted as already-shaped values (not their own "...Input" variant)
 * because they are ALWAYS produced by the deterministic engine itself, the
 * same convention `VerificationResultInput.evidence` already uses for a
 * fully-formed `Evidence` value. */
export function createOptimizationResult(input: OptimizationResultInput): OptimizationResult {
  const result: OptimizationResult = {
    id: input.id ?? createId("optresult"),
    problemId: input.problemId,
    projectId: input.projectId,
    projectVersion: input.projectVersion,
    candidateEvaluations: safeStructuredClone(input.candidateEvaluations, "optimizationResult.candidateEvaluations"),
    paretoOptimalCandidateIds: safeStructuredClone(input.paretoOptimalCandidateIds, "optimizationResult.paretoOptimalCandidateIds"),
    dominatedCandidateIds: safeStructuredClone(input.dominatedCandidateIds, "optimizationResult.dominatedCandidateIds"),
    infeasibleCandidateIds: safeStructuredClone(input.infeasibleCandidateIds, "optimizationResult.infeasibleCandidateIds"),
    unknownFeasibilityCandidateIds: safeStructuredClone(input.unknownFeasibilityCandidateIds, "optimizationResult.unknownFeasibilityCandidateIds"),
    incompleteDataCandidateIds: safeStructuredClone(input.incompleteDataCandidateIds, "optimizationResult.incompleteDataCandidateIds"),
    dominance: safeStructuredClone(input.dominance, "optimizationResult.dominance"),
    algorithm: input.algorithm ?? "pareto-dominance-v1",
    computedAt: input.computedAt ?? toIsoTimestamp(),
    source: input.source ?? "system",
    metadata: safeStructuredClone(input.metadata ?? {}, "optimizationResult.metadata")
  };
  assertOptimizationResult(result);
  return deepFreeze(result);
}

const EMPTY_MEMORY_REFERENCES: MemoryReferences = {
  requirementIds: [],
  constraintIds: [],
  decisionIds: [],
  preferenceIds: [],
  objectIds: [],
  experimentIds: [],
  candidateIds: [],
  verificationResultIds: [],
  optimizationResultIds: [],
  researchEvidenceIds: [],
  sourceIds: [],
  checkpointIds: [],
  changeIds: []
};

function buildMemoryReferences(input: MemoryReferencesInput | undefined): MemoryReferences {
  const merged: MemoryReferences = { ...EMPTY_MEMORY_REFERENCES, ...input };
  return {
    requirementIds: safeStructuredClone(merged.requirementIds, "memoryRecord.references.requirementIds"),
    constraintIds: safeStructuredClone(merged.constraintIds, "memoryRecord.references.constraintIds"),
    decisionIds: safeStructuredClone(merged.decisionIds, "memoryRecord.references.decisionIds"),
    preferenceIds: safeStructuredClone(merged.preferenceIds, "memoryRecord.references.preferenceIds"),
    objectIds: safeStructuredClone(merged.objectIds, "memoryRecord.references.objectIds"),
    experimentIds: safeStructuredClone(merged.experimentIds, "memoryRecord.references.experimentIds"),
    candidateIds: safeStructuredClone(merged.candidateIds, "memoryRecord.references.candidateIds"),
    verificationResultIds: safeStructuredClone(merged.verificationResultIds, "memoryRecord.references.verificationResultIds"),
    optimizationResultIds: safeStructuredClone(merged.optimizationResultIds, "memoryRecord.references.optimizationResultIds"),
    researchEvidenceIds: safeStructuredClone(merged.researchEvidenceIds, "memoryRecord.references.researchEvidenceIds"),
    sourceIds: safeStructuredClone(merged.sourceIds, "memoryRecord.references.sourceIds"),
    checkpointIds: safeStructuredClone(merged.checkpointIds, "memoryRecord.references.checkpointIds"),
    changeIds: safeStructuredClone(merged.changeIds, "memoryRecord.references.changeIds")
  };
}

/**
 * Builds a `MemoryRecord` (P24). `status` defaults to `"active"` -- the
 * initial/ongoing state every memory starts in (see `memory-types.ts`'s own
 * doc comment on `MemoryStatus`). `confidence`/`supersededByMemoryId` are
 * forced to their empty state (`null`) unless the input's own
 * `provenanceKind`/`status` actually calls for them -- mirrors
 * `createClarification`'s (P19) identical "status-driven field defaulting"
 * discipline, so a caller cannot accidentally smuggle a stray confidence
 * number or a dangling supersession pointer past the type's own invariants
 * (`assertMemoryRecord` would reject it anyway; defaulting it away here
 * means a well-behaved caller never has to think about it).
 */
export function createMemoryRecord(input: MemoryRecordInput): MemoryRecord {
  const createdAt = input.createdAt ?? toIsoTimestamp();
  const status = input.status ?? "active";
  const provenanceKind = input.provenanceKind;
  const record: MemoryRecord = {
    id: input.id ?? createId("memory"),
    projectId: input.projectId,
    projectVersion: input.projectVersion,
    kind: input.kind,
    title: input.title,
    content: input.content,
    provenanceKind,
    confidence: provenanceKind === "model_synthesis" && typeof input.confidence === "number" ? input.confidence : null,
    references: buildMemoryReferences(input.references),
    status,
    supersedesMemoryId: input.supersedesMemoryId ?? null,
    supersededByMemoryId: status === "superseded" ? (input.supersededByMemoryId ?? null) : null,
    source: input.source ?? "agent",
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    metadata: safeStructuredClone(input.metadata ?? {}, "memoryRecord.metadata")
  };
  assertMemoryRecord(record);
  return deepFreeze(record);
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

export function createCheckpointArtifactRef(input: CheckpointArtifactRefInput): CheckpointArtifactRef {
  const ref: CheckpointArtifactRef = {
    artifactId: input.artifactId,
    contentHash: input.contentHash,
    byteSize: input.byteSize,
    schemaVersion: input.schemaVersion ?? "1"
  };
  assertCheckpointArtifactRef(ref);
  return deepFreeze(ref);
}

export function createCheckpointEnvironmentSnapshot(input: CheckpointEnvironmentSnapshotInput): CheckpointEnvironmentSnapshot {
  const snapshot: CheckpointEnvironmentSnapshot = {
    environmentKind: input.environmentKind,
    environmentCheckpointId: input.environmentCheckpointId,
    documentName: input.documentName ?? null,
    objectIds: safeStructuredClone(input.objectIds ?? [], "checkpointEnvironmentSnapshot.objectIds"),
    contentHash: input.contentHash
  };
  assertCheckpointEnvironmentSnapshot(snapshot);
  return deepFreeze(snapshot);
}

/**
 * `worldModelSnapshot`/`environmentSnapshot` are ALREADY validated, frozen
 * values by the time they reach this factory (built by
 * `createCheckpointArtifactRef`/`createCheckpointEnvironmentSnapshot`
 * above) -- matching `createAgentLoopRun`'s identical "don't re-clone
 * already-immutable nested values" precedent. Only the plain
 * caller-supplied `metadata` bag needs `safeStructuredClone`'s defensive
 * copy.
 */
export function createCheckpoint(input: CheckpointInput): Checkpoint {
  const checkpoint: Checkpoint = {
    id: input.id ?? createId("chkpt"),
    projectId: input.projectId,
    sessionId: input.sessionId ?? null,
    status: input.status ?? "complete",
    reason: input.reason ?? "",
    source: input.source ?? "agent",
    createdAt: input.createdAt ?? toIsoTimestamp(),
    lastChangeId: input.lastChangeId ?? null,
    projectVersion: input.projectVersion,
    worldModelSnapshot: createCheckpointArtifactRef(input.worldModelSnapshot),
    environmentSnapshot: input.environmentSnapshot ? createCheckpointEnvironmentSnapshot(input.environmentSnapshot) : null,
    metadata: safeStructuredClone(input.metadata ?? {}, "checkpoint.metadata")
  };
  assertCheckpoint(checkpoint);
  return Object.freeze(checkpoint);
}

/**
 * Phase 16: builds a `Check` from a discriminated `CheckInput` -- one
 * factory covering every kind (mirroring `createCheckpoint`'s single-entry
 * shape), switching on `input.kind` to apply each kind's own defaults
 * before handing the fully-built object to `assertCheck` for validation.
 * `id`/`createdAt` follow the exact same generated-unless-supplied
 * convention as every other entity in this file.
 */
export function createCheck(input: CheckInput): Check {
  const base = {
    id: input.id ?? createId("check"),
    description: input.description,
    createdAt: input.createdAt ?? toIsoTimestamp(),
    metadata: safeStructuredClone(input.metadata ?? {}, "check.metadata")
  };
  let check: Check;
  switch (input.kind) {
    case "numeric_comparison":
      check = {
        ...base,
        kind: "numeric_comparison",
        objectId: input.objectId,
        property: input.property,
        operator: input.operator,
        expectedValue: input.expectedValue,
        expectedUnit: input.expectedUnit ?? null,
        tolerance: input.tolerance ?? null
      };
      break;
    case "bounds_check":
      check = {
        ...base,
        kind: "bounds_check",
        objectId: input.objectId,
        property: input.property,
        min: input.min ?? null,
        max: input.max ?? null,
        minInclusive: input.minInclusive ?? true,
        maxInclusive: input.maxInclusive ?? true,
        unit: input.unit ?? null
      };
      break;
    case "object_exists":
      check = { ...base, kind: "object_exists", objectId: input.objectId };
      break;
    case "object_type":
      check = { ...base, kind: "object_type", objectId: input.objectId, expectedGenericType: input.expectedGenericType };
      break;
    case "property_required":
      check = {
        ...base,
        kind: "property_required",
        objectId: input.objectId,
        property: input.property,
        requireNonNull: input.requireNonNull ?? true
      };
      break;
    default: {
      const exhaustiveCheck: never = input;
      throw new WorldModelValidationError("invalid_shape", `Unsupported check kind: ${JSON.stringify((exhaustiveCheck as { kind: unknown }).kind)}`);
    }
  }
  assertCheck(check);
  return Object.freeze(check);
}

/**
 * Builds `Evidence` -- see verification-types.ts's own doc comment for why
 * this is one flat shape rather than a union: an evaluator reads only the
 * fields its check kind cares about, and every other field defaults to
 * "not known" (`null`) rather than being fabricated.
 */
export function createEvidence(input: EvidenceInput): Evidence {
  const evidence: Evidence = {
    id: input.id ?? createId("evidence"),
    objectId: input.objectId ?? null,
    objectExists: input.objectExists ?? null,
    observedGenericType: input.observedGenericType ?? null,
    property: input.property ?? null,
    propertyExists: input.propertyExists ?? null,
    observedValue: input.observedValue ?? null,
    unit: input.unit ?? null,
    observationId: input.observationId ?? null,
    stateVersion: input.stateVersion ?? null,
    environmentKind: input.environmentKind ?? null,
    observedAt: input.observedAt ?? toIsoTimestamp(),
    source: input.source ?? "system",
    metadata: safeStructuredClone(input.metadata ?? {}, "evidence.metadata")
  };
  assertEvidence(evidence);
  return Object.freeze(evidence);
}

/**
 * Builds a `VerificationResult`. In practice this is only ever called by
 * @naqsh/core's `evaluateCheck` (the pure verifier) -- never hand-assembled
 * by a tool to fabricate a result, which is exactly why every field here is
 * independently validated by `assertVerificationResult` rather than trusted
 * because "only trusted code calls this."
 */
export function createVerificationResult(input: VerificationResultInput): VerificationResult {
  const result: VerificationResult = {
    id: input.id ?? createId("verif"),
    checkId: input.checkId,
    checkKind: input.checkKind,
    status: input.status,
    reasonKind: input.reasonKind,
    message: input.message,
    expected: safeStructuredClone(input.expected ?? null, "verificationResult.expected"),
    actual: safeStructuredClone(input.actual ?? null, "verificationResult.actual"),
    evidence: input.evidence ?? null,
    projectId: input.projectId,
    projectVersion: input.projectVersion,
    environmentKind: input.environmentKind ?? null,
    documentName: input.documentName ?? null,
    evaluatedAt: input.evaluatedAt ?? toIsoTimestamp(),
    metadata: safeStructuredClone(input.metadata ?? {}, "verificationResult.metadata")
  };
  assertVerificationResult(result);
  return Object.freeze(result);
}

/**
 * Builds ONE `ObjectiveConditionOutcome`. In practice only ever called by
 * @naqsh/core's `evaluateObjectiveSatisfaction` (the pure Phase 17
 * engine) while assembling the `conditions` array it hands to
 * `createObjectiveSatisfactionResult` below -- never hand-built by a tool
 * to fabricate an outcome.
 */
export function createObjectiveConditionOutcome(input: ObjectiveConditionOutcomeInput): ObjectiveConditionOutcome {
  const outcome: ObjectiveConditionOutcome = {
    checkId: input.checkId,
    checkKind: input.checkKind ?? null,
    requirementId: input.requirementId ?? null,
    constraintId: input.constraintId ?? null,
    required: input.required ?? true,
    verificationResultId: input.verificationResultId ?? null,
    effectiveStatus: input.effectiveStatus,
    reasonKind: input.reasonKind,
    message: input.message
  };
  assertObjectiveConditionOutcome(outcome);
  return Object.freeze(outcome);
}

/**
 * Builds an `ObjectiveSatisfactionResult`. Like `createVerificationResult`,
 * this is only ever called by the pure evaluator
 * (`evaluateObjectiveSatisfaction`) that computed `status`/`reason`/
 * `conditions` together -- every field is still independently validated by
 * `assertObjectiveSatisfactionResult` rather than trusted because "only
 * trusted code calls this."
 */
export function createObjectiveSatisfactionResult(input: ObjectiveSatisfactionResultInput): ObjectiveSatisfactionResult {
  const result: ObjectiveSatisfactionResult = {
    id: input.id ?? createId("objsat"),
    projectId: input.projectId,
    projectVersion: input.projectVersion,
    objectiveSummary: input.objectiveSummary ?? null,
    status: input.status,
    reason: input.reason,
    conditions: input.conditions.map((condition) => createObjectiveConditionOutcome(condition)),
    evaluatedAt: input.evaluatedAt ?? toIsoTimestamp(),
    metadata: safeStructuredClone(input.metadata ?? {}, "objectiveSatisfactionResult.metadata")
  };
  assertObjectiveSatisfactionResult(result);
  return Object.freeze(result);
}

/**
 * Builds a `RequirementCandidate` (P18). Note the defaulting behavior for
 * `interpretationStatus: "ambiguous"`: `operator`/`value`/`unit` are always
 * forced to `null` here regardless of what the caller passed, and
 * `ambiguityReason` is required -- the factory does not TRUST an
 * "ambiguous" candidate that also claims a numeric criterion, it
 * NORMALIZES away the criterion (Phase 18's "the validator is
 * authoritative over the model's output" requirement, applied at
 * construction time rather than merely rejected after the fact).
 */
export function createRequirementCandidate(input: RequirementCandidateInput): RequirementCandidate {
  const isAmbiguous = input.interpretationStatus === "ambiguous";
  const candidate: RequirementCandidate = {
    id: input.id ?? createId("reqcand"),
    projectId: input.projectId,
    projectVersion: input.projectVersion,
    statementText: input.statementText,
    description: input.description,
    category: input.category,
    operator: isAmbiguous ? null : (input.operator ?? null),
    value: isAmbiguous ? null : (input.value ?? null),
    unit: isAmbiguous ? null : (input.unit ?? null),
    interpretationStatus: input.interpretationStatus,
    ambiguityReason: isAmbiguous ? (input.ambiguityReason ?? "") : null,
    priority: input.priority ?? "medium",
    source: input.source ?? "agent",
    createdAt: input.createdAt ?? toIsoTimestamp(),
    metadata: safeStructuredClone(input.metadata ?? {}, "requirementCandidate.metadata")
  };
  assertRequirementCandidate(candidate);
  return Object.freeze(candidate);
}

/**
 * Builds a `Clarification` (P19). Note the defaulting behavior for
 * `status`: when NOT `"answered"`/`"superseded"`, `answerText`/`answeredAt`/
 * `supersededBy` are always forced to their empty state (`null`) here
 * regardless of what the caller passed -- the factory does not trust a
 * `"pending"` clarification that also claims an answer, it NORMALIZES the
 * inconsistency away at construction time, mirroring
 * `createRequirementCandidate`'s identical "ambiguous candidates never
 * carry a numeric criterion" discipline. `candidateSnapshot` is deep-
 * validated (via `assertRequirementCandidate`, inside `assertClarification`)
 * but NOT re-frozen/re-cloned here if it is already a real
 * `RequirementCandidate` produced by `createRequirementCandidate` --
 * mirrors `createCheckpoint`'s identical "don't re-clone an already-
 * immutable nested value" precedent.
 */
export function createClarification(input: ClarificationInput): Clarification {
  const status = input.status ?? "pending";
  const clarification: Clarification = {
    id: input.id ?? createId("clarify"),
    projectId: input.projectId,
    requirementCandidateId: input.requirementCandidateId,
    candidateSnapshot: input.candidateSnapshot,
    question: input.question,
    reason: input.reason,
    category: input.category,
    affectedFields: safeStructuredClone(input.affectedFields ?? [], "clarification.affectedFields"),
    status,
    answerText: status === "answered" ? (input.answerText ?? null) : null,
    answeredAt: status === "answered" ? (input.answeredAt ?? toIsoTimestamp()) : null,
    supersededBy: status === "superseded" ? (input.supersededBy ?? null) : null,
    source: input.source ?? "agent",
    createdAt: input.createdAt ?? toIsoTimestamp(),
    metadata: safeStructuredClone(input.metadata ?? {}, "clarification.metadata")
  };
  assertClarification(clarification);
  return Object.freeze(clarification);
}

export function createDesignComponent(input: DesignComponentInput): DesignComponent {
  const component: DesignComponent = {
    id: input.id ?? createId("designcomp"),
    name: input.name,
    type: input.type,
    geometryIntent: input.geometryIntent,
    dimensions: safeStructuredClone(input.dimensions ?? {}, "designComponent.dimensions"),
    parentComponentId: input.parentComponentId ?? null,
    metadata: safeStructuredClone(input.metadata ?? {}, "designComponent.metadata")
  };
  assertDesignComponent(component);
  return Object.freeze(component);
}

export function createDesignRelationship(input: DesignRelationshipInput): DesignRelationship {
  const relationship: DesignRelationship = {
    id: input.id ?? createId("designrel"),
    type: input.type,
    sourceComponentId: input.sourceComponentId,
    targetComponentId: input.targetComponentId,
    metadata: safeStructuredClone(input.metadata ?? {}, "designRelationship.metadata")
  };
  assertDesignRelationship(relationship);
  return Object.freeze(relationship);
}

export function createExpectedBuildOutput(input: ExpectedBuildOutputInput): ExpectedBuildOutput {
  const output: ExpectedBuildOutput = {
    id: input.id ?? createId("buildout"),
    componentId: input.componentId,
    environmentObjectType: input.environmentObjectType,
    environmentGenericType: input.environmentGenericType ?? null,
    properties: safeStructuredClone(input.properties ?? {}, "expectedBuildOutput.properties")
  };
  assertExpectedBuildOutput(output);
  return Object.freeze(output);
}

/**
 * Builds a `DesignSpecification` (P20) -- mirrors `createPlan`'s exact
 * shape: nested arrays are built via their own per-item factories (never
 * hand-assembled), `deepFreeze` (not a shallow `Object.freeze`) because
 * `components`/`relationships`/`expectedOutputs` are themselves nested
 * objects a caller must not be able to mutate after construction.
 */
export function createDesignSpecification(input: DesignSpecificationInput): DesignSpecification {
  const createdAt = input.createdAt ?? toIsoTimestamp();
  const design: DesignSpecification = {
    id: input.id ?? createId("design"),
    projectId: input.projectId,
    projectVersion: input.projectVersion,
    planId: input.planId,
    planStepId: input.planStepId,
    objectiveSummary: input.objectiveSummary,
    description: input.description,
    components: (input.components ?? []).map((component) => createDesignComponent(component)),
    relationships: (input.relationships ?? []).map((relationship) => createDesignRelationship(relationship)),
    parameters: safeStructuredClone(input.parameters ?? {}, "designSpecification.parameters"),
    material: input.material ?? null,
    manufacturingIntent: input.manufacturingIntent ?? null,
    relevantConstraintIds: safeStructuredClone(input.relevantConstraintIds ?? [], "designSpecification.relevantConstraintIds"),
    relevantRequirementIds: safeStructuredClone(input.relevantRequirementIds ?? [], "designSpecification.relevantRequirementIds"),
    expectedOutputs: (input.expectedOutputs ?? []).map((output) => createExpectedBuildOutput(output)),
    status: input.status ?? "proposed",
    supersedesDesignSpecificationId: input.supersedesDesignSpecificationId ?? null,
    version: input.version ?? 1,
    source: input.source ?? "agent",
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    metadata: safeStructuredClone(input.metadata ?? {}, "designSpecification.metadata")
  };
  assertDesignSpecification(design);
  return deepFreeze(design);
}

/**
 * Builds a `BuildOperation` (P20). Note the defaulting behavior for
 * `status`: for anything other than `"succeeded"`/`"failed"`,
 * `output`/`error`/`startedAt`/`completedAt` are always forced to their
 * empty state here regardless of what the caller passed -- the factory
 * does not trust a `"pending"` operation that also claims a result, it
 * NORMALIZES the inconsistency away at construction time, matching
 * `createClarification`'s identical discipline for its own lifecycle
 * fields.
 */
export function createBuildOperation(input: BuildOperationInput): BuildOperation {
  const status = input.status ?? "pending";
  const isSucceeded = status === "succeeded";
  const isFailed = status === "failed";
  const operation: BuildOperation = {
    id: input.id ?? createId("buildop"),
    expectedOutputId: input.expectedOutputId,
    toolName: input.toolName,
    input: safeStructuredClone(input.input ?? {}, "buildOperation.input"),
    status,
    output: isSucceeded ? safeStructuredClone(input.output ?? null, "buildOperation.output") : null,
    error: isFailed ? safeStructuredClone(input.error ?? { kind: "execution_failure", message: "unknown build failure" }, "buildOperation.error") : null,
    startedAt: isSucceeded || isFailed ? (input.startedAt ?? toIsoTimestamp()) : null,
    completedAt: isSucceeded || isFailed ? (input.completedAt ?? toIsoTimestamp()) : null
  };
  assertBuildOperation(operation);
  return deepFreeze(operation);
}

/**
 * Builds a `BuildResult` (P20). `buildSuccess` is ALWAYS derived from
 * `status` here (`status === "completed"`), never independently trusted
 * from the caller -- the same "the validator/factory is authoritative"
 * discipline that keeps these two fields from ever silently disagreeing
 * (Step 14's own explicit "do not collapse build_success with anything
 * else, and never let it lie" requirement).
 */
export function createBuildResult(input: BuildResultInput): BuildResult {
  const status = input.status ?? "pending";
  const result: BuildResult = {
    id: input.id ?? createId("build"),
    projectId: input.projectId,
    projectVersion: input.projectVersion,
    designSpecificationId: input.designSpecificationId,
    status,
    buildSuccess: status === "completed",
    operations: (input.operations ?? []).map((operation) => createBuildOperation(operation)),
    startedAt: input.startedAt ?? toIsoTimestamp(),
    completedAt: input.completedAt ?? null,
    source: input.source ?? "agent",
    metadata: safeStructuredClone(input.metadata ?? {}, "buildResult.metadata")
  };
  assertBuildResult(result);
  return deepFreeze(result);
}
