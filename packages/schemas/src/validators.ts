import { isIsoTimestamp } from "./ids.js";
import { assertValidToolValueSchema } from "./tool-schema.js";
import {
  ENVIRONMENT_CAPABILITIES,
  ENVIRONMENT_ERROR_KINDS,
  ENVIRONMENT_HEALTH_STATUSES,
  ENVIRONMENT_INSPECTION_ERROR_KINDS,
  ENVIRONMENT_OBJECT_GENERIC_TYPES,
  ENVIRONMENT_OPERATION_KINDS,
  ENVIRONMENT_SESSION_STATUSES,
  type EnvironmentBoundingBox,
  type EnvironmentDescriptor,
  type EnvironmentDocumentInspection,
  type EnvironmentHealth,
  type EnvironmentInspectionError,
  type EnvironmentObject,
  type EnvironmentObjectGeometry,
  type EnvironmentOperationError,
  type EnvironmentOperationResult,
  type EnvironmentProperty,
  type EnvironmentPropertyChange,
  type EnvironmentRelationship,
  type EnvironmentSession,
  type EnvironmentVector3
} from "./environment-types.js";
import {
  MODEL_ERROR_KINDS,
  MODEL_RESPONSE_KINDS,
  type ModelContext,
  type ModelInvocationError,
  type ModelInvocationResult,
  type ModelProviderDescriptor,
  type ModelRequest,
  type ModelRequestConfig,
  type ModelResponse,
  type ModelToolCallIntent,
  type ModelToolDeclaration
} from "./model-types.js";
import { OBSERVATION_SCOPES, type ObservationResult } from "./observation-types.js";
import { AGENT_LOOP_RUN_STATUSES, EXECUTION_OUTCOMES, type AgentLoopRun, type ExecutionResult } from "./agent-loop-types.js";
import {
  CHECKPOINT_STATUSES,
  type Checkpoint,
  type CheckpointArtifactRef,
  type CheckpointEnvironmentSnapshot
} from "./checkpoint-types.js";
import { CHECK_KINDS, NUMERIC_COMPARISON_OPERATORS, VERIFICATION_REASON_KINDS, VERIFICATION_STATUSES, type Check, type Evidence, type VerificationResult } from "./verification-types.js";
import {
  OBJECTIVE_CONDITION_REASON_KINDS,
  OBJECTIVE_SATISFACTION_STATUSES,
  type ObjectiveConditionOutcome,
  type ObjectiveSatisfactionResult
} from "./objective-satisfaction-types.js";
import { REQUIREMENT_INTERPRETATION_STATUSES, type RequirementCandidate } from "./requirement-candidate-types.js";
import { CLARIFICATION_CATEGORIES, CLARIFICATION_STATUSES, type Clarification } from "./clarification-types.js";
import {
  DESIGN_SPECIFICATION_STATUSES,
  type DesignComponent,
  type DesignRelationship,
  type DesignSpecification,
  type ExpectedBuildOutput
} from "./design-specification-types.js";
import { BUILD_OPERATION_STATUSES, BUILD_STATUSES, type BuildOperation, type BuildResult } from "./build-types.js";
import {
  MAX_RESEARCH_EVIDENCE_EXCERPT_LENGTH,
  RESEARCH_EVIDENCE_CONFIDENCES,
  RESEARCH_EVIDENCE_STATUSES,
  RESEARCH_PROVIDER_ERROR_KINDS,
  RESEARCH_REQUEST_STATUSES,
  SOURCE_RELIABILITIES,
  SOURCE_STATUSES,
  SOURCE_TYPES,
  type ResearchEvidence,
  type ResearchFetchContent,
  type ResearchFetchInvocationResult,
  type ResearchFetchRequest,
  type ResearchInvocationStatus,
  type ResearchProviderDescriptor,
  type ResearchProviderError,
  type ResearchRequest,
  type ResearchSearchInvocationResult,
  type ResearchSearchRequest,
  type ResearchSourceCandidate,
  type Source
} from "./research-types.js";
import {
  PLAN_RISK_SEVERITIES,
  PLAN_STATUSES,
  PLAN_STEP_STATUSES,
  type Plan,
  type PlanAssumption,
  type PlanQuestion,
  type PlanRisk,
  type PlanStep
} from "./plan-types.js";
import { PROPOSAL_STATUSES, type Proposal } from "./proposal-types.js";
import { CANDIDATE_STATUSES, type Candidate } from "./candidate-types.js";
import {
  CANDIDATE_FEASIBILITIES,
  CONSTRAINT_OUTCOME_REASON_KINDS,
  DATA_COMPLETENESS_VALUES,
  METRIC_VALUE_PROVENANCE_KINDS,
  METRIC_VALUE_STATUSES,
  NORMALIZATION_METHODS,
  OBJECTIVE_DIRECTIONS,
  type CandidateEvaluation,
  type CandidateMetricSnapshot,
  type CandidateMetricValue,
  type ConstraintEvaluationOutcome,
  type DominanceRelation,
  type ObjectiveComparisonEntry,
  type OptimizationConstraint,
  type OptimizationObjective,
  type OptimizationProblem,
  type OptimizationResult
} from "./optimization-types.js";
import {
  APPROVAL_STATUSES,
  AUTHORIZATION_DENIAL_REASONS,
  AUTONOMY_GRANT_STATUSES,
  CHANGE_CAUSE_KINDS,
  ENTITY_KINDS,
  EXPERIMENT_STATUSES,
  TOOL_ERROR_KINDS,
  TOOL_MUTATION_KINDS,
  TOOL_TARGETS,
  ENTITY_SOURCES,
  type Approval,
  type AuthorizationDecision,
  type AutonomyGrant,
  type Change,
  type ChangeCause,
  type ChangeTarget,
  type Constraint,
  type Decision,
  type EngineeringObject,
  type EntityRelationship,
  type Experiment,
  type ExperimentStatus,
  type Objective,
  type Preference,
  type Project,
  type Requirement,
  type SessionState,
  type Tool,
  type ToolRequest,
  type ToolResult,
  type ToolResultError,
  type WorldModelState
} from "./types.js";

import { WorldModelValidationError } from "./errors.js";

// Re-exported so every existing `import { WorldModelValidationError } from
// "@naqsh/schemas"` (or from "./validators.js") keeps working unchanged.
// The classes themselves live in errors.js, a dependency-free leaf module,
// specifically so this file and tool-schema.ts can both throw them without
// an import cycle between the two.
export { AuthorizationError, EnvironmentError, ModelError, ObservationError, ToolError, WorldModelValidationError } from "./errors.js";

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new WorldModelValidationError("invalid_shape", message);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEntitySource(value: unknown): value is (typeof ENTITY_SOURCES)[number] {
  return typeof value === "string" && (ENTITY_SOURCES as readonly string[]).includes(value);
}

function isChangeCauseKind(value: unknown): value is (typeof CHANGE_CAUSE_KINDS)[number] {
  return typeof value === "string" && (CHANGE_CAUSE_KINDS as readonly string[]).includes(value);
}

/**
 * Deep check that `value` survives a JSON.stringify/parse round-trip with
 * no semantic loss: no functions, symbols, bigints, `undefined`, `NaN`/
 * `Infinity`, or Date/Map/Set/RegExp instances (all of which either vanish
 * silently or silently change type under JSON). Used specifically for
 * Change's `before`/`after`/`metadata`/`transition` fields — a Change
 * claims to be first-class serializable data, so that claim is enforced
 * here rather than merely assumed of callers.
 */
function isJsonSafeValue(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonSafeValue(item));
  if (value instanceof Date || value instanceof Map || value instanceof Set || value instanceof RegExp) {
    return false;
  }
  if (isPlainObject(value)) return Object.values(value).every((item) => isJsonSafeValue(item));
  return false;
}

export function assertObjective(value: unknown): asserts value is Objective {
  invariant(isPlainObject(value), "objective must be an object");
  invariant(typeof value.summary === "string", "objective.summary must be a string");
  invariant(isEntitySource(value.source), "invalid objective source");
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "objective.metadata must be a JSON-serializable object"
  );
}

export function assertRequirement(value: unknown): asserts value is Requirement {
  invariant(isPlainObject(value), "requirement must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "requirement.id is required");
  invariant(typeof value.description === "string", "requirement.description must be a string");
  invariant(
    typeof value.category === "string" && value.category.length > 0,
    "requirement.category is required"
  );
  invariant(isJsonSafeValue(value.value), "requirement.value must be JSON-serializable");
  invariant(value.unit === null || typeof value.unit === "string", "requirement.unit must be a string or null");
  invariant(
    value.priority === "low" || value.priority === "medium" || value.priority === "high",
    "invalid requirement priority"
  );
  invariant(
    value.status === "active" ||
      value.status === "satisfied" ||
      value.status === "rejected" ||
      value.status === "superseded",
    "invalid requirement status"
  );
  invariant(isEntitySource(value.source), "invalid requirement source");
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "requirement.metadata must be a JSON-serializable object"
  );
}

export function assertConstraint(value: unknown): asserts value is Constraint {
  invariant(isPlainObject(value), "constraint must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "constraint.id is required");
  invariant(typeof value.description === "string", "constraint.description must be a string");
  invariant(
    typeof value.category === "string" && value.category.length > 0,
    "constraint.category is required"
  );
  invariant(isJsonSafeValue(value.value), "constraint.value must be JSON-serializable");
  invariant(value.unit === null || typeof value.unit === "string", "constraint.unit must be a string or null");
  invariant(value.severity === "hard" || value.severity === "soft", "invalid constraint severity");
  invariant(
    value.status === "active" ||
      value.status === "satisfied" ||
      value.status === "violated" ||
      value.status === "superseded",
    "invalid constraint status"
  );
  invariant(isEntitySource(value.source), "invalid constraint source");
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "constraint.metadata must be a JSON-serializable object"
  );
}

export function assertEngineeringObject(value: unknown): asserts value is EngineeringObject {
  invariant(isPlainObject(value), "engineering object must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "object.id is required");
  invariant(typeof value.type === "string" && value.type.length > 0, "object.type is required");
  invariant(typeof value.name === "string", "object.name must be a string");
  invariant(
    isPlainObject(value.properties) && isJsonSafeValue(value.properties),
    "object.properties must be a JSON-serializable object"
  );
  invariant(Array.isArray(value.relationships), "object.relationships must be an array");
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "object.metadata must be a JSON-serializable object"
  );
}

export function assertDecision(value: unknown): asserts value is Decision {
  invariant(isPlainObject(value), "decision must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "decision.id is required");
  invariant(
    typeof value.statement === "string" && value.statement.trim().length > 0,
    "decision.statement is required"
  );
  invariant(typeof value.reason === "string", "decision.reason must be a string");
  invariant(isEntitySource(value.source), "invalid decision source");
  invariant(isIsoTimestamp(value.createdAt), "decision.createdAt must be an ISO timestamp");
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "decision.metadata must be a JSON-serializable object"
  );
}

export function assertExperiment(value: unknown): asserts value is Experiment {
  invariant(isPlainObject(value), "experiment must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "experiment.id is required");
  invariant(
    typeof value.objective === "string" && value.objective.trim().length > 0,
    "experiment.objective is required"
  );
  invariant(typeof value.hypothesis === "string", "experiment.hypothesis must be a string");
  invariant(Array.isArray(value.inputs) && isJsonSafeValue(value.inputs), "experiment.inputs must be a JSON-serializable array");
  invariant(EXPERIMENT_STATUSES.includes(value.status as ExperimentStatus), "invalid experiment status");
  invariant(isJsonSafeValue(value.result), "experiment.result must be JSON-serializable");
  invariant(
    value.conclusion === null || typeof value.conclusion === "string",
    "experiment.conclusion must be a string or null"
  );
  invariant(
    value.candidateId === null || (typeof value.candidateId === "string" && value.candidateId.length > 0),
    "experiment.candidateId must be a non-empty string or null"
  );
  invariant(
    value.buildResultId === null || (typeof value.buildResultId === "string" && value.buildResultId.length > 0),
    "experiment.buildResultId must be a non-empty string or null"
  );
  invariant(isStringArray(value.verificationResultIds), "experiment.verificationResultIds must be an array of strings");
  invariant(
    value.checkpointBeforeId === null || (typeof value.checkpointBeforeId === "string" && value.checkpointBeforeId.length > 0),
    "experiment.checkpointBeforeId must be a non-empty string or null"
  );
  invariant(
    value.checkpointAfterId === null || (typeof value.checkpointAfterId === "string" && value.checkpointAfterId.length > 0),
    "experiment.checkpointAfterId must be a non-empty string or null"
  );
  invariant(isEntitySource(value.source), "invalid experiment source");
  invariant(isIsoTimestamp(value.createdAt), "experiment.createdAt must be an ISO timestamp");
  invariant(isIsoTimestamp(value.updatedAt), "experiment.updatedAt must be an ISO timestamp");
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "experiment.metadata must be a JSON-serializable object"
  );
}

export function assertPreference(value: unknown): asserts value is Preference {
  invariant(isPlainObject(value), "preference must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "preference.id is required");
  invariant(typeof value.description === "string", "preference.description must be a string");
  invariant(
    typeof value.category === "string" && value.category.length > 0,
    "preference.category is required"
  );
  invariant(isJsonSafeValue(value.value), "preference.value must be JSON-serializable");
  invariant(isEntitySource(value.source), "invalid preference source");
  invariant(value.status === "active" || value.status === "inactive", "invalid preference status");
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "preference.metadata must be a JSON-serializable object"
  );
}

function isEntityKind(value: unknown): value is (typeof ENTITY_KINDS)[number] {
  return typeof value === "string" && (ENTITY_KINDS as readonly string[]).includes(value);
}

export function assertEntityRelationship(value: unknown): asserts value is EntityRelationship {
  invariant(isPlainObject(value), "entity relationship must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "entityRelationship.id is required");
  invariant(typeof value.type === "string" && value.type.length > 0, "entityRelationship.type is required");
  invariant(isEntityKind(value.sourceType), "invalid entityRelationship.sourceType");
  invariant(
    typeof value.sourceId === "string" && value.sourceId.length > 0,
    "entityRelationship.sourceId is required"
  );
  invariant(isEntityKind(value.targetType), "invalid entityRelationship.targetType");
  invariant(
    typeof value.targetId === "string" && value.targetId.length > 0,
    "entityRelationship.targetId is required"
  );
  invariant(isEntitySource(value.source), "invalid entityRelationship.source");
  invariant(isIsoTimestamp(value.createdAt), "entityRelationship.createdAt must be an ISO timestamp");
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "entityRelationship.metadata must be a JSON-serializable object"
  );
}

function isSourceType(value: unknown): value is (typeof SOURCE_TYPES)[number] {
  return typeof value === "string" && (SOURCE_TYPES as readonly string[]).includes(value);
}

function isSourceReliability(value: unknown): value is (typeof SOURCE_RELIABILITIES)[number] {
  return typeof value === "string" && (SOURCE_RELIABILITIES as readonly string[]).includes(value);
}

function isSourceStatus(value: unknown): value is (typeof SOURCE_STATUSES)[number] {
  return typeof value === "string" && (SOURCE_STATUSES as readonly string[]).includes(value);
}

/** P21: validates a `Source` -- environment-independent, provider-independent
 * (nothing here knows about a specific search engine or `ResearchProvider`
 * implementation). `locator` is intentionally unvalidated as a URL (a
 * `Source` can be a verbally-cited standard with no fetchable address) --
 * see `research-provider.ts` (core) for where a real locator IS checked
 * before ever being fetched. */
export function assertSource(value: unknown): asserts value is Source {
  invariant(isPlainObject(value), "source must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "source.id is required");
  invariant(value.locator === null || (typeof value.locator === "string" && value.locator.length > 0), "source.locator must be a non-empty string or null");
  invariant(typeof value.title === "string" && value.title.trim().length > 0, "source.title is required");
  invariant(value.publisher === null || typeof value.publisher === "string", "source.publisher must be a string or null");
  invariant(isSourceType(value.sourceType), "invalid source.sourceType");
  invariant(isSourceReliability(value.reliability), "invalid source.reliability");
  invariant(isIsoTimestamp(value.retrievedAt), "source.retrievedAt must be an ISO timestamp");
  invariant(value.publishedAt === null || isIsoTimestamp(value.publishedAt), "source.publishedAt must be an ISO timestamp or null");
  invariant(value.contentHash === null || (typeof value.contentHash === "string" && value.contentHash.length > 0), "source.contentHash must be a non-empty string or null");
  invariant(isSourceStatus(value.status), "invalid source.status");
  invariant(isEntitySource(value.source), "invalid source.source");
  invariant(isIsoTimestamp(value.createdAt), "source.createdAt must be an ISO timestamp");
  invariant(isPlainObject(value.metadata) && isJsonSafeValue(value.metadata), "source.metadata must be a JSON-serializable object");
}

function isResearchEvidenceConfidence(value: unknown): value is (typeof RESEARCH_EVIDENCE_CONFIDENCES)[number] {
  return typeof value === "string" && (RESEARCH_EVIDENCE_CONFIDENCES as readonly string[]).includes(value);
}

function isResearchEvidenceStatus(value: unknown): value is (typeof RESEARCH_EVIDENCE_STATUSES)[number] {
  return typeof value === "string" && (RESEARCH_EVIDENCE_STATUSES as readonly string[]).includes(value);
}

/** P21: `claim` is required and non-empty (evidence with no claim is not
 * evidence of anything -- see `research-types.ts`'s own doc comment); the
 * `excerpt` length bound is enforced HERE, not merely hoped for from
 * whatever normalized it -- the "validator is authoritative" discipline
 * every prior phase's own invariant already uses. */
export function assertResearchEvidence(value: unknown): asserts value is ResearchEvidence {
  invariant(isPlainObject(value), "research evidence must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "researchEvidence.id is required");
  invariant(typeof value.sourceId === "string" && value.sourceId.length > 0, "researchEvidence.sourceId is required");
  invariant(typeof value.claim === "string" && value.claim.trim().length > 0, "researchEvidence.claim is required");
  invariant(
    value.excerpt === null || (typeof value.excerpt === "string" && value.excerpt.length <= MAX_RESEARCH_EVIDENCE_EXCERPT_LENGTH),
    `researchEvidence.excerpt must be a string of at most ${MAX_RESEARCH_EVIDENCE_EXCERPT_LENGTH} characters, or null`
  );
  invariant(isResearchEvidenceConfidence(value.confidence), "invalid researchEvidence.confidence");
  invariant(value.relevanceNote === null || typeof value.relevanceNote === "string", "researchEvidence.relevanceNote must be a string or null");
  invariant(isIsoTimestamp(value.retrievedAt), "researchEvidence.retrievedAt must be an ISO timestamp");
  invariant(isResearchEvidenceStatus(value.status), "invalid researchEvidence.status");
  invariant(isEntitySource(value.source), "invalid researchEvidence.source");
  invariant(isIsoTimestamp(value.createdAt), "researchEvidence.createdAt must be an ISO timestamp");
  invariant(isPlainObject(value.metadata) && isJsonSafeValue(value.metadata), "researchEvidence.metadata must be a JSON-serializable object");
}

function isResearchRequestStatus(value: unknown): value is (typeof RESEARCH_REQUEST_STATUSES)[number] {
  return typeof value === "string" && (RESEARCH_REQUEST_STATUSES as readonly string[]).includes(value);
}

/** P21: `query`/`purpose` both required and non-empty -- the P21 brief's
 * own Section 12 insists research must explain WHY, not just what, and
 * this is where that requirement is actually enforced, not merely
 * requested in a system instruction a model could ignore. */
export function assertResearchRequest(value: unknown): asserts value is ResearchRequest {
  invariant(isPlainObject(value), "research request must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "researchRequest.id is required");
  invariant(typeof value.projectId === "string" && value.projectId.length > 0, "researchRequest.projectId is required");
  invariant(
    typeof value.projectVersion === "number" && Number.isInteger(value.projectVersion) && value.projectVersion >= 1,
    "researchRequest.projectVersion must be a positive integer"
  );
  invariant(typeof value.query === "string" && value.query.trim().length > 0, "researchRequest.query is required");
  invariant(typeof value.purpose === "string" && value.purpose.trim().length > 0, "researchRequest.purpose is required");
  invariant(isStringArray(value.relatedRequirementIds), "researchRequest.relatedRequirementIds must be an array of strings");
  invariant(isStringArray(value.relatedConstraintIds), "researchRequest.relatedConstraintIds must be an array of strings");
  invariant(
    value.relatedPlanId === null || (typeof value.relatedPlanId === "string" && value.relatedPlanId.length > 0),
    "researchRequest.relatedPlanId must be a non-empty string or null"
  );
  invariant(
    value.relatedPlanStepId === null || (typeof value.relatedPlanStepId === "string" && value.relatedPlanStepId.length > 0),
    "researchRequest.relatedPlanStepId must be a non-empty string or null"
  );
  invariant(Array.isArray(value.preferredSourceTypes), "researchRequest.preferredSourceTypes must be an array");
  for (const sourceType of value.preferredSourceTypes) invariant(isSourceType(sourceType), "invalid entry in researchRequest.preferredSourceTypes");
  invariant(
    typeof value.maxResults === "number" && Number.isInteger(value.maxResults) && value.maxResults >= 1,
    "researchRequest.maxResults must be a positive integer"
  );
  invariant(
    value.freshnessRequirementDays === null || (typeof value.freshnessRequirementDays === "number" && Number.isFinite(value.freshnessRequirementDays) && value.freshnessRequirementDays >= 0),
    "researchRequest.freshnessRequirementDays must be a non-negative number or null"
  );
  invariant(isResearchRequestStatus(value.status), "invalid researchRequest.status");
  invariant(isEntitySource(value.source), "invalid researchRequest.source");
  invariant(isIsoTimestamp(value.createdAt), "researchRequest.createdAt must be an ISO timestamp");
  invariant(isPlainObject(value.metadata) && isJsonSafeValue(value.metadata), "researchRequest.metadata must be a JSON-serializable object");
}

// ---------------------------------------------------------------------------
// P21: ResearchProvider wire contract -- mirrors ModelRequest/ModelResponse/
// ModelInvocationResult's exact validation shape and discriminated-status
// discipline (see model-types.ts's identical family).
// ---------------------------------------------------------------------------

export function assertResearchProviderDescriptor(value: unknown): asserts value is ResearchProviderDescriptor {
  invariant(isPlainObject(value), "research provider descriptor must be an object");
  invariant(typeof value.providerId === "string" && value.providerId.length > 0, "researchProviderDescriptor.providerId is required");
  invariant(typeof value.name === "string" && value.name.length > 0, "researchProviderDescriptor.name is required");
  invariant(typeof value.version === "string" && value.version.length > 0, "researchProviderDescriptor.version is required");
  invariant(isPlainObject(value.metadata) && isJsonSafeValue(value.metadata), "researchProviderDescriptor.metadata must be a JSON-serializable object");
}

export function assertResearchSearchRequest(value: unknown): asserts value is ResearchSearchRequest {
  invariant(isPlainObject(value), "research search request must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "researchSearchRequest.id is required");
  invariant(typeof value.query === "string" && value.query.trim().length > 0, "researchSearchRequest.query is required");
  invariant(
    typeof value.maxResults === "number" && Number.isInteger(value.maxResults) && value.maxResults >= 1,
    "researchSearchRequest.maxResults must be a positive integer"
  );
  invariant(Array.isArray(value.preferredSourceTypes), "researchSearchRequest.preferredSourceTypes must be an array");
  for (const sourceType of value.preferredSourceTypes) invariant(isSourceType(sourceType), "invalid entry in researchSearchRequest.preferredSourceTypes");
  invariant(isIsoTimestamp(value.createdAt), "researchSearchRequest.createdAt must be an ISO timestamp");
  invariant(isPlainObject(value.metadata) && isJsonSafeValue(value.metadata), "researchSearchRequest.metadata must be a JSON-serializable object");
}

/** UNTRUSTED provider output -- bounded the same way `ResearchEvidence.excerpt`
 * is, so a hostile/oversized provider response is defused HERE, at the
 * boundary, before it can reach anywhere near an accepted `Source`/
 * `ResearchEvidence` (P21 brief Section 21: "oversized responses"). */
export function assertResearchSourceCandidate(value: unknown): asserts value is ResearchSourceCandidate {
  invariant(isPlainObject(value), "research source candidate must be an object");
  invariant(value.locator === null || typeof value.locator === "string", "researchSourceCandidate.locator must be a string or null");
  invariant(typeof value.title === "string" && value.title.trim().length > 0, "researchSourceCandidate.title is required");
  invariant(value.publisher === null || typeof value.publisher === "string", "researchSourceCandidate.publisher must be a string or null");
  invariant(isSourceType(value.sourceType), "invalid researchSourceCandidate.sourceType");
  invariant(value.publishedAt === null || typeof value.publishedAt === "string", "researchSourceCandidate.publishedAt must be a string or null");
  invariant(
    typeof value.snippet === "string" && value.snippet.length <= MAX_RESEARCH_EVIDENCE_EXCERPT_LENGTH,
    `researchSourceCandidate.snippet must be a string of at most ${MAX_RESEARCH_EVIDENCE_EXCERPT_LENGTH} characters`
  );
}

function isResearchProviderErrorKind(value: unknown): value is (typeof RESEARCH_PROVIDER_ERROR_KINDS)[number] {
  return typeof value === "string" && (RESEARCH_PROVIDER_ERROR_KINDS as readonly string[]).includes(value);
}

export function assertResearchProviderError(value: unknown): asserts value is ResearchProviderError {
  invariant(isPlainObject(value), "research provider error must be an object");
  invariant(isResearchProviderErrorKind(value.kind), "invalid researchProviderError.kind");
  invariant(typeof value.message === "string" && value.message.length > 0, "researchProviderError.message is required");
}

function isResearchInvocationStatus(value: unknown): value is ResearchInvocationStatus {
  return value === "success" || value === "error";
}

export function assertResearchSearchInvocationResult(value: unknown): asserts value is ResearchSearchInvocationResult {
  invariant(isPlainObject(value), "research search invocation result must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "researchSearchInvocationResult.id is required");
  invariant(typeof value.requestId === "string" && value.requestId.length > 0, "researchSearchInvocationResult.requestId is required");
  invariant(typeof value.providerId === "string" && value.providerId.length > 0, "researchSearchInvocationResult.providerId is required");
  invariant(isResearchInvocationStatus(value.status), "invalid researchSearchInvocationResult.status");
  if (value.status === "success") {
    invariant(value.error === null, "researchSearchInvocationResult.error must be null when status is success");
    invariant(Array.isArray(value.results), "researchSearchInvocationResult.results must be an array when status is success");
    for (const result of value.results) assertResearchSourceCandidate(result);
  } else {
    invariant(value.results === null, "researchSearchInvocationResult.results must be null when status is error");
    assertResearchProviderError(value.error);
  }
  invariant(isIsoTimestamp(value.startedAt), "researchSearchInvocationResult.startedAt must be an ISO timestamp");
  invariant(isIsoTimestamp(value.completedAt), "researchSearchInvocationResult.completedAt must be an ISO timestamp");
  invariant(isPlainObject(value.metadata) && isJsonSafeValue(value.metadata), "researchSearchInvocationResult.metadata must be a JSON-serializable object");
}

export function assertResearchFetchRequest(value: unknown): asserts value is ResearchFetchRequest {
  invariant(isPlainObject(value), "research fetch request must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "researchFetchRequest.id is required");
  invariant(typeof value.locator === "string" && value.locator.trim().length > 0, "researchFetchRequest.locator is required");
  invariant(isIsoTimestamp(value.createdAt), "researchFetchRequest.createdAt must be an ISO timestamp");
  invariant(isPlainObject(value.metadata) && isJsonSafeValue(value.metadata), "researchFetchRequest.metadata must be a JSON-serializable object");
}

/** UNTRUSTED provider output -- `excerpt` bounded exactly like
 * `ResearchSourceCandidate.snippet`. */
export function assertResearchFetchContent(value: unknown): asserts value is ResearchFetchContent {
  invariant(isPlainObject(value), "research fetch content must be an object");
  invariant(typeof value.locator === "string" && value.locator.length > 0, "researchFetchContent.locator is required");
  invariant(typeof value.title === "string" && value.title.trim().length > 0, "researchFetchContent.title is required");
  invariant(value.publisher === null || typeof value.publisher === "string", "researchFetchContent.publisher must be a string or null");
  invariant(isSourceType(value.sourceType), "invalid researchFetchContent.sourceType");
  invariant(value.publishedAt === null || typeof value.publishedAt === "string", "researchFetchContent.publishedAt must be a string or null");
  invariant(isIsoTimestamp(value.retrievedAt), "researchFetchContent.retrievedAt must be an ISO timestamp");
  invariant(
    typeof value.excerpt === "string" && value.excerpt.length <= MAX_RESEARCH_EVIDENCE_EXCERPT_LENGTH,
    `researchFetchContent.excerpt must be a string of at most ${MAX_RESEARCH_EVIDENCE_EXCERPT_LENGTH} characters`
  );
  invariant(value.contentHash === null || (typeof value.contentHash === "string" && value.contentHash.length > 0), "researchFetchContent.contentHash must be a non-empty string or null");
}

export function assertResearchFetchInvocationResult(value: unknown): asserts value is ResearchFetchInvocationResult {
  invariant(isPlainObject(value), "research fetch invocation result must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "researchFetchInvocationResult.id is required");
  invariant(typeof value.requestId === "string" && value.requestId.length > 0, "researchFetchInvocationResult.requestId is required");
  invariant(typeof value.providerId === "string" && value.providerId.length > 0, "researchFetchInvocationResult.providerId is required");
  invariant(isResearchInvocationStatus(value.status), "invalid researchFetchInvocationResult.status");
  if (value.status === "success") {
    invariant(value.error === null, "researchFetchInvocationResult.error must be null when status is success");
    assertResearchFetchContent(value.content);
  } else {
    invariant(value.content === null, "researchFetchInvocationResult.content must be null when status is error");
    assertResearchProviderError(value.error);
  }
  invariant(isIsoTimestamp(value.startedAt), "researchFetchInvocationResult.startedAt must be an ISO timestamp");
  invariant(isIsoTimestamp(value.completedAt), "researchFetchInvocationResult.completedAt must be an ISO timestamp");
  invariant(isPlainObject(value.metadata) && isJsonSafeValue(value.metadata), "researchFetchInvocationResult.metadata must be a JSON-serializable object");
}

export function assertProject(value: unknown): asserts value is Project {
  invariant(isPlainObject(value), "project must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "project.id is required");
  invariant(typeof value.name === "string" && value.name.length > 0, "project.name is required");
  invariant(typeof value.description === "string", "project.description must be a string");
  assertObjective(value.objective);
  invariant(Array.isArray(value.requirements), "project.requirements must be an array");
  invariant(Array.isArray(value.constraints), "project.constraints must be an array");
  invariant(Array.isArray(value.objects), "project.objects must be an array");
  invariant(Array.isArray(value.decisions), "project.decisions must be an array");
  invariant(Array.isArray(value.experiments), "project.experiments must be an array");
  invariant(Array.isArray(value.preferences), "project.preferences must be an array");
  invariant(Array.isArray(value.relationships), "project.relationships must be an array");
  invariant(Array.isArray(value.sources), "project.sources must be an array");
  invariant(Array.isArray(value.researchEvidence), "project.researchEvidence must be an array");
  invariant(
    typeof value.version === "number" && Number.isInteger(value.version) && value.version >= 1,
    "project.version must be a positive integer"
  );
  invariant(isIsoTimestamp(value.createdAt), "project.createdAt must be an ISO timestamp");
  invariant(isIsoTimestamp(value.updatedAt), "project.updatedAt must be an ISO timestamp");
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "project.metadata must be a JSON-serializable object"
  );
  for (const requirement of value.requirements) assertRequirement(requirement);
  for (const constraint of value.constraints) assertConstraint(constraint);
  for (const object of value.objects) assertEngineeringObject(object);
  for (const decision of value.decisions) assertDecision(decision);
  for (const experiment of value.experiments) assertExperiment(experiment);
  for (const preference of value.preferences) assertPreference(preference);
  for (const relationship of value.relationships) assertEntityRelationship(relationship);
  for (const source of value.sources) assertSource(source);
  for (const evidence of value.researchEvidence) assertResearchEvidence(evidence);
}

export function assertSessionState(value: unknown): asserts value is SessionState {
  invariant(isPlainObject(value), "session must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "session.id is required");
  invariant(
    value.projectId === null || typeof value.projectId === "string",
    "session.projectId must be a string or null"
  );
  invariant(
    value.mode === "idle" ||
      value.mode === "reviewing" ||
      value.mode === "designing" ||
      value.mode === "executing",
    "invalid session mode"
  );
  invariant(Array.isArray(value.focusObjectIds), "session.focusObjectIds must be an array");
  invariant(
    Array.isArray(value.selectedRequirementIds),
    "session.selectedRequirementIds must be an array"
  );
  invariant(
    Array.isArray(value.selectedConstraintIds),
    "session.selectedConstraintIds must be an array"
  );
  invariant(
    value.lastObservedAt === null || typeof value.lastObservedAt === "string",
    "session.lastObservedAt must be a string or null"
  );
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "session.metadata must be a JSON-serializable object"
  );
}

export function assertWorldModelState(value: unknown): asserts value is WorldModelState {
  invariant(isPlainObject(value), "world model state must be an object");
  assertProject(value.project);
  assertSessionState(value.session);
}

export function assertChangeCause(value: unknown): asserts value is ChangeCause {
  invariant(isPlainObject(value), "change cause must be an object");
  invariant(isChangeCauseKind(value.kind), "invalid change cause kind");
  invariant(typeof value.description === "string", "change cause description must be a string");
}

export function assertChangeTarget(value: unknown): asserts value is ChangeTarget {
  invariant(isPlainObject(value), "change target must be an object");
  invariant(
    typeof value.entityType === "string" && value.entityType.length > 0,
    "change target.entityType is required"
  );
  invariant(
    value.entityId === null || typeof value.entityId === "string",
    "change target.entityId must be a string or null"
  );
}

/**
 * Deliberately does NOT re-validate `transition` against the full
 * transition-interface shapes, and does NOT check `transitionKind` against
 * the current set of registered kinds. A Change is an immutable historical
 * record — it must stay valid even after a future phase removes or
 * reshapes a transition kind that a much older Change referenced. Checking
 * the outer shape (an object with a non-empty string `kind`) is enough;
 * whether a kind is currently supported is @naqsh/core's registry's
 * concern, not this validator's.
 */
export function assertChange(value: unknown): asserts value is Change {
  invariant(isPlainObject(value), "change must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "change.id is required");
  invariant(
    typeof value.sequence === "number" && Number.isInteger(value.sequence) && value.sequence >= 1,
    "change.sequence must be a positive integer"
  );
  invariant(
    value.parentChangeId === null || typeof value.parentChangeId === "string",
    "change.parentChangeId must be a string or null"
  );
  invariant(typeof value.projectId === "string" && value.projectId.length > 0, "change.projectId is required");
  invariant(
    value.sessionId === null || typeof value.sessionId === "string",
    "change.sessionId must be a string or null"
  );
  invariant(isEntitySource(value.source), "invalid change source");
  assertChangeCause(value.cause);
  invariant(
    typeof value.transitionKind === "string" && value.transitionKind.length > 0,
    "change.transitionKind is required"
  );
  invariant(
    isPlainObject(value.transition) &&
      typeof value.transition.kind === "string" &&
      value.transition.kind.length > 0,
    "change.transition must be an object with a non-empty kind"
  );
  invariant(isJsonSafeValue(value.transition), "change.transition must be JSON-serializable");
  assertChangeTarget(value.target);
  invariant(
    typeof value.resultingProjectVersion === "number" &&
      Number.isInteger(value.resultingProjectVersion) &&
      value.resultingProjectVersion >= 1,
    "change.resultingProjectVersion must be a positive integer"
  );
  invariant(isIsoTimestamp(value.createdAt), "change.createdAt must be an ISO timestamp");
  invariant(isJsonSafeValue(value.before), "change.before must be JSON-serializable");
  invariant(isJsonSafeValue(value.after), "change.after must be JSON-serializable");
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "change.metadata must be a JSON-serializable object"
  );
}

function isToolTarget(value: unknown): value is (typeof TOOL_TARGETS)[number] {
  return typeof value === "string" && (TOOL_TARGETS as readonly string[]).includes(value);
}

function isToolMutationKind(value: unknown): value is (typeof TOOL_MUTATION_KINDS)[number] {
  return typeof value === "string" && (TOOL_MUTATION_KINDS as readonly string[]).includes(value);
}

function isToolErrorKind(value: unknown): value is (typeof TOOL_ERROR_KINDS)[number] {
  return typeof value === "string" && (TOOL_ERROR_KINDS as readonly string[]).includes(value);
}

function isApprovalStatus(value: unknown): value is (typeof APPROVAL_STATUSES)[number] {
  return typeof value === "string" && (APPROVAL_STATUSES as readonly string[]).includes(value);
}

function isAutonomyGrantStatus(value: unknown): value is (typeof AUTONOMY_GRANT_STATUSES)[number] {
  return typeof value === "string" && (AUTONOMY_GRANT_STATUSES as readonly string[]).includes(value);
}

function isAuthorizationDenialReason(value: unknown): value is (typeof AUTHORIZATION_DENIAL_REASONS)[number] {
  return typeof value === "string" && (AUTHORIZATION_DENIAL_REASONS as readonly string[]).includes(value);
}

function assertNullableString(value: unknown, message: string): void {
  invariant(value === null || typeof value === "string", message);
}

function assertNullableTimestamp(value: unknown, message: string): void {
  invariant(value === null || isIsoTimestamp(value), message);
}

/**
 * Validates a Tool's own shape is well-formed, including recursively
 * validating that `inputSchema`/`outputSchema` are themselves well-formed
 * `ToolValueSchema` definitions (see tool-schema.ts) — so a malformed
 * schema is rejected at REGISTRATION time, not discovered later when a
 * tool call silently fails to validate against a broken schema.
 */
export function assertTool(value: unknown): asserts value is Tool {
  invariant(isPlainObject(value), "tool must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "tool.id is required");
  invariant(typeof value.name === "string" && value.name.length > 0, "tool.name is required");
  invariant(typeof value.description === "string", "tool.description must be a string");
  invariant(typeof value.version === "string" && value.version.length > 0, "tool.version is required");
  invariant(isToolTarget(value.target), "invalid tool target");
  invariant(isToolMutationKind(value.mutation), "invalid tool mutation kind");
  assertValidToolValueSchema(value.inputSchema, "tool.inputSchema");
  assertValidToolValueSchema(value.outputSchema, "tool.outputSchema");
  invariant(isEntitySource(value.source), "invalid tool source");
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "tool.metadata must be a JSON-serializable object"
  );
}

export function assertToolRequest(value: unknown): asserts value is ToolRequest {
  invariant(isPlainObject(value), "tool request must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "toolRequest.id is required");
  invariant(
    typeof value.toolName === "string" && value.toolName.length > 0,
    "toolRequest.toolName is required"
  );
  invariant(isEntitySource(value.source), "invalid tool request source");
  invariant(isIsoTimestamp(value.createdAt), "toolRequest.createdAt must be an ISO timestamp");
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "toolRequest.metadata must be a JSON-serializable object"
  );
  // `input` is intentionally EXEMPT from JSON-safety checking, unlike
  // every other field in this file. It's raw, pre-validation caller
  // input -- a ToolRequest must be constructible for it (so a bad call
  // can still be recorded as an error result) without executeTool's
  // request-construction step itself becoming a second, earlier place
  // that can throw for "invalid input" before executeTool's own try/catch
  // ever gets a chance to turn that into a structured ToolResult instead
  // of an uncaught exception. In practice this isn't a gap: a function or
  // other non-JSON-safe value fails ordinary type checks in
  // matchesToolValueSchema against ANY reasonably-declared inputSchema
  // (typeof/isPlainObject checks all reject it), so it's still caught,
  // just one layer later and gracefully rather than by throwing here.
}

function assertToolResultError(value: unknown): asserts value is ToolResultError {
  invariant(isPlainObject(value), "tool result error must be an object");
  invariant(isToolErrorKind(value.kind), "invalid tool result error kind");
  invariant(typeof value.message === "string", "tool result error message must be a string");
}

export function assertToolResult(value: unknown): asserts value is ToolResult {
  invariant(isPlainObject(value), "tool result must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "toolResult.id is required");
  invariant(
    typeof value.requestId === "string" && value.requestId.length > 0,
    "toolResult.requestId is required"
  );
  invariant(
    typeof value.toolName === "string" && value.toolName.length > 0,
    "toolResult.toolName is required"
  );
  invariant(value.status === "success" || value.status === "error", "invalid tool result status");
  invariant(isJsonSafeValue(value.output), "toolResult.output must be JSON-serializable");
  if (value.status === "success") {
    invariant(value.error === null, "toolResult.error must be null when status is success");
  } else {
    assertToolResultError(value.error);
  }
  invariant(isIsoTimestamp(value.startedAt), "toolResult.startedAt must be an ISO timestamp");
  invariant(isIsoTimestamp(value.completedAt), "toolResult.completedAt must be an ISO timestamp");
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "toolResult.metadata must be a JSON-serializable object"
  );
}

export function assertApproval(value: unknown): asserts value is Approval {
  invariant(isPlainObject(value), "approval must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "approval.id is required");
  invariant(
    typeof value.toolName === "string" && value.toolName.length > 0,
    "approval.toolName is required"
  );
  assertNullableString(value.targetType, "approval.targetType must be a string or null");
  assertNullableString(value.targetId, "approval.targetId must be a string or null");
  assertNullableString(value.proposalId, "approval.proposalId must be a string or null");
  invariant(isApprovalStatus(value.status), "invalid approval status");
  invariant(isEntitySource(value.requestedBy), "invalid approval requestedBy source");
  invariant(
    value.decidedBy === null || isEntitySource(value.decidedBy),
    "approval.decidedBy must be a valid source or null"
  );
  invariant(typeof value.reason === "string", "approval.reason must be a string");
  invariant(isIsoTimestamp(value.createdAt), "approval.createdAt must be an ISO timestamp");
  assertNullableTimestamp(value.respondedAt, "approval.respondedAt must be an ISO timestamp or null");
  assertNullableTimestamp(value.expiresAt, "approval.expiresAt must be an ISO timestamp or null");
  assertNullableTimestamp(value.consumedAt, "approval.consumedAt must be an ISO timestamp or null");
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "approval.metadata must be a JSON-serializable object"
  );
}

export function assertAutonomyGrant(value: unknown): asserts value is AutonomyGrant {
  invariant(isPlainObject(value), "autonomy grant must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "autonomyGrant.id is required");
  invariant(
    Array.isArray(value.toolNames) &&
      value.toolNames.length > 0 &&
      value.toolNames.every((name) => typeof name === "string" && name.length > 0),
    "autonomyGrant.toolNames must be a non-empty array of non-empty strings"
  );
  assertNullableString(value.targetType, "autonomyGrant.targetType must be a string or null");
  assertNullableString(value.targetId, "autonomyGrant.targetId must be a string or null");
  invariant(isAutonomyGrantStatus(value.status), "invalid autonomy grant status");
  invariant(isEntitySource(value.grantedBy), "invalid autonomy grant grantedBy source");
  invariant(typeof value.reason === "string", "autonomyGrant.reason must be a string");
  invariant(isIsoTimestamp(value.createdAt), "autonomyGrant.createdAt must be an ISO timestamp");
  assertNullableTimestamp(value.expiresAt, "autonomyGrant.expiresAt must be an ISO timestamp or null");
  assertNullableTimestamp(value.revokedAt, "autonomyGrant.revokedAt must be an ISO timestamp or null");
  invariant(
    value.revokedBy === null || isEntitySource(value.revokedBy),
    "autonomyGrant.revokedBy must be a valid source or null"
  );
  invariant(
    value.maxUses === null || (typeof value.maxUses === "number" && Number.isInteger(value.maxUses) && value.maxUses >= 1),
    "autonomyGrant.maxUses must be a positive integer or null"
  );
  invariant(
    typeof value.useCount === "number" && Number.isInteger(value.useCount) && value.useCount >= 0,
    "autonomyGrant.useCount must be a non-negative integer"
  );
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "autonomyGrant.metadata must be a JSON-serializable object"
  );
}

/**
 * Deliberately does NOT validate `autonomyLevel` against `AUTONOMY_LEVELS`:
 * an unrecognized level is itself one of the things a decision records
 * (`denialReason: "unknown_autonomy_level"`), so the raw string that was
 * evaluated must still be storable even when it wasn't a valid level.
 */
export function assertAuthorizationDecision(value: unknown): asserts value is AuthorizationDecision {
  invariant(isPlainObject(value), "authorization decision must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "authorizationDecision.id is required");
  invariant(
    typeof value.toolName === "string" && value.toolName.length > 0,
    "authorizationDecision.toolName is required"
  );
  if (value.target !== null) {
    assertChangeTarget(value.target);
  }
  invariant(typeof value.autonomyLevel === "string", "authorizationDecision.autonomyLevel must be a string");
  invariant(isEntitySource(value.source), "invalid authorization decision source");
  invariant(
    typeof value.requestId === "string" && value.requestId.length > 0,
    "authorizationDecision.requestId is required"
  );
  invariant(typeof value.allowed === "boolean", "authorizationDecision.allowed must be a boolean");
  if (value.allowed) {
    invariant(value.denialReason === null, "authorizationDecision.denialReason must be null when allowed");
  } else {
    invariant(isAuthorizationDenialReason(value.denialReason), "invalid authorization denial reason");
  }
  invariant(typeof value.message === "string", "authorizationDecision.message must be a string");
  assertNullableString(value.matchedApprovalId, "authorizationDecision.matchedApprovalId must be a string or null");
  assertNullableString(
    value.matchedAutonomyGrantId,
    "authorizationDecision.matchedAutonomyGrantId must be a string or null"
  );
  invariant(isIsoTimestamp(value.createdAt), "authorizationDecision.createdAt must be an ISO timestamp");
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "authorizationDecision.metadata must be a JSON-serializable object"
  );
}

function isEnvironmentCapability(value: unknown): value is (typeof ENVIRONMENT_CAPABILITIES)[number] {
  return typeof value === "string" && (ENVIRONMENT_CAPABILITIES as readonly string[]).includes(value);
}

function isEnvironmentSessionStatus(value: unknown): value is (typeof ENVIRONMENT_SESSION_STATUSES)[number] {
  return typeof value === "string" && (ENVIRONMENT_SESSION_STATUSES as readonly string[]).includes(value);
}

function isEnvironmentHealthStatus(value: unknown): value is (typeof ENVIRONMENT_HEALTH_STATUSES)[number] {
  return typeof value === "string" && (ENVIRONMENT_HEALTH_STATUSES as readonly string[]).includes(value);
}

function isEnvironmentOperationKind(value: unknown): value is (typeof ENVIRONMENT_OPERATION_KINDS)[number] {
  return typeof value === "string" && (ENVIRONMENT_OPERATION_KINDS as readonly string[]).includes(value);
}

function isEnvironmentErrorKind(value: unknown): value is (typeof ENVIRONMENT_ERROR_KINDS)[number] {
  return typeof value === "string" && (ENVIRONMENT_ERROR_KINDS as readonly string[]).includes(value);
}

function isEnvironmentObjectGenericType(value: unknown): value is (typeof ENVIRONMENT_OBJECT_GENERIC_TYPES)[number] {
  return typeof value === "string" && (ENVIRONMENT_OBJECT_GENERIC_TYPES as readonly string[]).includes(value);
}

function isEnvironmentInspectionErrorKind(value: unknown): value is (typeof ENVIRONMENT_INSPECTION_ERROR_KINDS)[number] {
  return typeof value === "string" && (ENVIRONMENT_INSPECTION_ERROR_KINDS as readonly string[]).includes(value);
}

function assertEnvironmentVector3(value: unknown, message: string): asserts value is EnvironmentVector3 {
  invariant(
    isPlainObject(value) && typeof value.x === "number" && typeof value.y === "number" && typeof value.z === "number",
    message
  );
}

function assertEnvironmentBoundingBox(value: unknown): asserts value is EnvironmentBoundingBox {
  invariant(isPlainObject(value), "environmentBoundingBox must be an object");
  assertEnvironmentVector3(value.min, "environmentBoundingBox.min must be an {x,y,z} vector of numbers");
  assertEnvironmentVector3(value.max, "environmentBoundingBox.max must be an {x,y,z} vector of numbers");
}

function assertNullableNumber(value: unknown, message: string): void {
  invariant(value === null || typeof value === "number", message);
}

export function assertEnvironmentObjectGeometry(value: unknown): asserts value is EnvironmentObjectGeometry {
  invariant(isPlainObject(value), "environment object geometry must be an object");
  invariant(typeof value.available === "boolean", "environmentObjectGeometry.available must be a boolean");
  assertNullableString(value.reason, "environmentObjectGeometry.reason must be a string or null");
  invariant(
    value.valid === null || typeof value.valid === "boolean",
    "environmentObjectGeometry.valid must be a boolean or null"
  );
  if (value.boundingBox !== null) assertEnvironmentBoundingBox(value.boundingBox);
  assertNullableNumber(value.volume, "environmentObjectGeometry.volume must be a number or null");
  assertNullableNumber(value.surfaceArea, "environmentObjectGeometry.surfaceArea must be a number or null");
  if (value.centerOfMass !== null) {
    assertEnvironmentVector3(value.centerOfMass, "environmentObjectGeometry.centerOfMass must be an {x,y,z} vector of numbers or null");
  }
  assertNullableNumber(value.solidCount, "environmentObjectGeometry.solidCount must be a number or null");
  assertNullableNumber(value.faceCount, "environmentObjectGeometry.faceCount must be a number or null");
  assertNullableNumber(value.edgeCount, "environmentObjectGeometry.edgeCount must be a number or null");
  assertNullableNumber(value.vertexCount, "environmentObjectGeometry.vertexCount must be a number or null");
  assertNullableString(value.shapeType, "environmentObjectGeometry.shapeType must be a string or null");
}

export function assertEnvironmentDescriptor(value: unknown): asserts value is EnvironmentDescriptor {
  invariant(isPlainObject(value), "environment descriptor must be an object");
  invariant(typeof value.kind === "string" && value.kind.length > 0, "environmentDescriptor.kind is required");
  invariant(typeof value.name === "string" && value.name.length > 0, "environmentDescriptor.name is required");
  invariant(
    typeof value.version === "string" && value.version.length > 0,
    "environmentDescriptor.version is required"
  );
  invariant(
    Array.isArray(value.capabilities) && value.capabilities.every((capability) => isEnvironmentCapability(capability)),
    "environmentDescriptor.capabilities must be an array of valid capabilities"
  );
  invariant(
    new Set(value.capabilities).size === value.capabilities.length,
    "environmentDescriptor.capabilities must not contain duplicates"
  );
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "environmentDescriptor.metadata must be a JSON-serializable object"
  );
}

export function assertEnvironmentSession(value: unknown): asserts value is EnvironmentSession {
  invariant(isPlainObject(value), "environment session must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "environmentSession.id is required");
  invariant(
    typeof value.environmentKind === "string" && value.environmentKind.length > 0,
    "environmentSession.environmentKind is required"
  );
  invariant(isEnvironmentSessionStatus(value.status), "invalid environment session status");
  assertNullableString(value.documentName, "environmentSession.documentName must be a string or null");
  invariant(isIsoTimestamp(value.openedAt), "environmentSession.openedAt must be an ISO timestamp");
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "environmentSession.metadata must be a JSON-serializable object"
  );
}

export function assertEnvironmentProperty(value: unknown): asserts value is EnvironmentProperty {
  invariant(isPlainObject(value), "environment property must be an object");
  invariant(
    typeof value.key === "string" && value.key.length > 0,
    "environmentProperty.key is required"
  );
  invariant(isJsonSafeValue(value.value), "environmentProperty.value must be JSON-serializable");
  invariant(typeof value.readOnly === "boolean", "environmentProperty.readOnly must be a boolean");
}

export function assertEnvironmentRelationship(value: unknown): asserts value is EnvironmentRelationship {
  invariant(isPlainObject(value), "environment relationship must be an object");
  invariant(typeof value.type === "string" && value.type.length > 0, "environmentRelationship.type is required");
  invariant(
    typeof value.targetId === "string" && value.targetId.length > 0,
    "environmentRelationship.targetId is required"
  );
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "environmentRelationship.metadata must be a JSON-serializable object"
  );
}

export function assertEnvironmentPropertyChange(value: unknown): asserts value is EnvironmentPropertyChange {
  invariant(isPlainObject(value), "environment property change must be an object");
  invariant(typeof value.key === "string" && value.key.length > 0, "environmentPropertyChange.key is required");
  invariant(isJsonSafeValue(value.before), "environmentPropertyChange.before must be JSON-serializable");
  invariant(isJsonSafeValue(value.requested), "environmentPropertyChange.requested must be JSON-serializable");
  invariant(isJsonSafeValue(value.after), "environmentPropertyChange.after must be JSON-serializable");
}

export function assertEnvironmentObject(value: unknown): asserts value is EnvironmentObject {
  invariant(isPlainObject(value), "environment object must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "environmentObject.id is required");
  invariant(typeof value.type === "string" && value.type.length > 0, "environmentObject.type is required");
  invariant(typeof value.name === "string", "environmentObject.name must be a string");
  invariant(isEnvironmentObjectGenericType(value.genericType), "invalid environmentObject.genericType");
  assertNullableString(value.parentId, "environmentObject.parentId must be a string or null");
  invariant(
    value.visible === null || typeof value.visible === "boolean",
    "environmentObject.visible must be a boolean or null"
  );
  assertEnvironmentObjectGeometry(value.geometry);
  invariant(Array.isArray(value.properties), "environmentObject.properties must be an array");
  for (const property of value.properties) assertEnvironmentProperty(property);
  invariant(Array.isArray(value.relationships), "environmentObject.relationships must be an array");
  for (const relationship of value.relationships) assertEnvironmentRelationship(relationship);
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "environmentObject.metadata must be a JSON-serializable object"
  );
}

export function assertEnvironmentHealth(value: unknown): asserts value is EnvironmentHealth {
  invariant(isPlainObject(value), "environment health must be an object");
  invariant(isEnvironmentHealthStatus(value.status), "invalid environment health status");
  invariant(typeof value.message === "string", "environmentHealth.message must be a string");
  invariant(isIsoTimestamp(value.checkedAt), "environmentHealth.checkedAt must be an ISO timestamp");
}

function assertEnvironmentOperationError(value: unknown): asserts value is EnvironmentOperationError {
  invariant(isPlainObject(value), "environment operation error must be an object");
  invariant(isEnvironmentErrorKind(value.kind), "invalid environment error kind");
  invariant(typeof value.message === "string", "environment operation error message must be a string");
}

/**
 * Deliberately does NOT validate `data` against any specific shape beyond
 * JSON-safety -- like `ToolResult.output`, what `data` should look like
 * depends on `operation` (an EnvironmentObject for inspect_object, an
 * EnvironmentSession for connect, null for disconnect/save, ...) and
 * enforcing that per-operation shape is the contract-test suite's job
 * (core's environment-adapter-contract.ts), not this generic validator's.
 */
export function assertEnvironmentOperationResult(value: unknown): asserts value is EnvironmentOperationResult {
  invariant(isPlainObject(value), "environment operation result must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "environmentOperationResult.id is required");
  invariant(isEnvironmentOperationKind(value.operation), "invalid environment operation kind");
  assertNullableString(value.sessionId, "environmentOperationResult.sessionId must be a string or null");
  assertNullableString(value.objectId, "environmentOperationResult.objectId must be a string or null");
  invariant(
    value.status === "success" || value.status === "error",
    "invalid environment operation result status"
  );
  invariant(isJsonSafeValue(value.data), "environmentOperationResult.data must be JSON-serializable");
  if (value.status === "success") {
    invariant(value.error === null, "environmentOperationResult.error must be null when status is success");
  } else {
    assertEnvironmentOperationError(value.error);
  }
  invariant(isIsoTimestamp(value.startedAt), "environmentOperationResult.startedAt must be an ISO timestamp");
  invariant(isIsoTimestamp(value.completedAt), "environmentOperationResult.completedAt must be an ISO timestamp");
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "environmentOperationResult.metadata must be a JSON-serializable object"
  );
}

export function assertEnvironmentInspectionError(value: unknown): asserts value is EnvironmentInspectionError {
  invariant(isPlainObject(value), "environment inspection error must be an object");
  invariant(isEnvironmentInspectionErrorKind(value.kind), "invalid environment inspection error kind");
  assertNullableString(value.objectId, "environmentInspectionError.objectId must be a string or null");
  invariant(typeof value.message === "string", "environmentInspectionError.message must be a string");
}

export function assertEnvironmentDocumentInspection(value: unknown): asserts value is EnvironmentDocumentInspection {
  invariant(isPlainObject(value), "environment document inspection must be an object");
  invariant(
    typeof value.environmentKind === "string" && value.environmentKind.length > 0,
    "environmentDocumentInspection.environmentKind is required"
  );
  assertNullableString(value.documentId, "environmentDocumentInspection.documentId must be a string or null");
  assertNullableString(value.documentName, "environmentDocumentInspection.documentName must be a string or null");
  assertNullableString(value.filePath, "environmentDocumentInspection.filePath must be a string or null");
  invariant(
    typeof value.objectCount === "number" && Number.isInteger(value.objectCount) && value.objectCount >= 0,
    "environmentDocumentInspection.objectCount must be a non-negative integer"
  );
  invariant(Array.isArray(value.objectIds), "environmentDocumentInspection.objectIds must be an array");
  invariant(
    value.objectIds.every((id: unknown) => typeof id === "string" && id.length > 0),
    "environmentDocumentInspection.objectIds must contain only non-empty strings"
  );
  invariant(
    value.objectIds.length === value.objectCount,
    "environmentDocumentInspection.objectIds length must match objectCount"
  );
  invariant(Array.isArray(value.rootObjectIds), "environmentDocumentInspection.rootObjectIds must be an array");
  invariant(
    value.rootObjectIds.every((id: unknown) => typeof id === "string" && id.length > 0),
    "environmentDocumentInspection.rootObjectIds must contain only non-empty strings"
  );
  const objectIdSet = new Set(value.objectIds as string[]);
  invariant(
    (value.rootObjectIds as string[]).every((id) => objectIdSet.has(id)),
    "environmentDocumentInspection.rootObjectIds must be a subset of objectIds"
  );
  invariant(isIsoTimestamp(value.inspectedAt), "environmentDocumentInspection.inspectedAt must be an ISO timestamp");
  assertNullableString(value.environmentVersion, "environmentDocumentInspection.environmentVersion must be a string or null");
  invariant(Array.isArray(value.warnings), "environmentDocumentInspection.warnings must be an array");
  invariant(
    value.warnings.every((warning: unknown) => typeof warning === "string"),
    "environmentDocumentInspection.warnings must contain only strings"
  );
  invariant(Array.isArray(value.unsupportedFeatures), "environmentDocumentInspection.unsupportedFeatures must be an array");
  invariant(
    value.unsupportedFeatures.every((feature: unknown) => typeof feature === "string"),
    "environmentDocumentInspection.unsupportedFeatures must contain only strings"
  );
  invariant(Array.isArray(value.inspectionErrors), "environmentDocumentInspection.inspectionErrors must be an array");
  for (const error of value.inspectionErrors) assertEnvironmentInspectionError(error);
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "environmentDocumentInspection.metadata must be a JSON-serializable object"
  );
}

function isModelResponseKind(value: unknown): value is (typeof MODEL_RESPONSE_KINDS)[number] {
  return typeof value === "string" && (MODEL_RESPONSE_KINDS as readonly string[]).includes(value);
}

function isModelErrorKind(value: unknown): value is (typeof MODEL_ERROR_KINDS)[number] {
  return typeof value === "string" && (MODEL_ERROR_KINDS as readonly string[]).includes(value);
}

export function assertModelRequestConfig(value: unknown): asserts value is ModelRequestConfig {
  invariant(isPlainObject(value), "model request config must be an object");
  invariant(typeof value.modelId === "string" && value.modelId.length > 0, "modelRequestConfig.modelId is required");
  invariant(
    value.temperature === null || typeof value.temperature === "number",
    "modelRequestConfig.temperature must be a number or null"
  );
  invariant(
    value.maxOutputTokens === null ||
      (typeof value.maxOutputTokens === "number" && Number.isInteger(value.maxOutputTokens) && value.maxOutputTokens > 0),
    "modelRequestConfig.maxOutputTokens must be a positive integer or null"
  );
  invariant(
    value.timeoutMs === null || (typeof value.timeoutMs === "number" && Number.isInteger(value.timeoutMs) && value.timeoutMs > 0),
    "modelRequestConfig.timeoutMs must be a positive integer or null"
  );
}

export function assertModelToolDeclaration(value: unknown): asserts value is ModelToolDeclaration {
  invariant(isPlainObject(value), "model tool declaration must be an object");
  invariant(typeof value.name === "string" && value.name.length > 0, "modelToolDeclaration.name is required");
  invariant(typeof value.description === "string", "modelToolDeclaration.description must be a string");
  assertValidToolValueSchema(value.inputSchema, "modelToolDeclaration.inputSchema");
  invariant(isToolMutationKind(value.mutation), "invalid model tool declaration mutation kind");
  invariant(isToolTarget(value.target), "invalid model tool declaration target");
}

export function assertModelContext(value: unknown): asserts value is ModelContext {
  invariant(isPlainObject(value), "model context must be an object");
  assertNullableString(value.projectId, "modelContext.projectId must be a string or null");
  assertNullableString(value.projectName, "modelContext.projectName must be a string or null");
  assertNullableString(value.projectSummary, "modelContext.projectSummary must be a string or null");
  assertNullableString(value.objectiveSummary, "modelContext.objectiveSummary must be a string or null");
  for (const [key, val] of [
    ["requirementCount", value.requirementCount],
    ["constraintCount", value.constraintCount],
    ["objectCount", value.objectCount],
    ["decisionCount", value.decisionCount]
  ] as const) {
    invariant(
      typeof val === "number" && Number.isInteger(val) && val >= 0,
      `modelContext.${key} must be a non-negative integer`
    );
  }
  invariant(
    value.sessionMode === null ||
      value.sessionMode === "idle" ||
      value.sessionMode === "reviewing" ||
      value.sessionMode === "designing" ||
      value.sessionMode === "executing",
    "modelContext.sessionMode must be a valid SessionMode or null"
  );
  invariant(
    Array.isArray(value.focusObjectIds) && value.focusObjectIds.every((id) => typeof id === "string"),
    "modelContext.focusObjectIds must be an array of strings"
  );
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "modelContext.metadata must be a JSON-serializable object"
  );
}

export function assertModelRequest(value: unknown): asserts value is ModelRequest {
  invariant(isPlainObject(value), "model request must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "modelRequest.id is required");
  assertNullableString(value.systemInstruction, "modelRequest.systemInstruction must be a string or null");
  assertModelContext(value.context);
  invariant(typeof value.instruction === "string" && value.instruction.length > 0, "modelRequest.instruction is required");
  invariant(Array.isArray(value.tools), "modelRequest.tools must be an array");
  for (const tool of value.tools) assertModelToolDeclaration(tool);
  invariant(
    new Set(value.tools.map((tool: ModelToolDeclaration) => tool.name)).size === value.tools.length,
    "modelRequest.tools must not declare the same tool name twice"
  );
  if (value.outputSchema !== null) {
    assertValidToolValueSchema(value.outputSchema, "modelRequest.outputSchema");
  }
  assertModelRequestConfig(value.config);
  assertNullableString(value.sessionId, "modelRequest.sessionId must be a string or null");
  invariant(isIsoTimestamp(value.createdAt), "modelRequest.createdAt must be an ISO timestamp");
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "modelRequest.metadata must be a JSON-serializable object"
  );
}

export function assertModelToolCallIntent(value: unknown): asserts value is ModelToolCallIntent {
  invariant(isPlainObject(value), "model tool call intent must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "modelToolCallIntent.id is required");
  invariant(
    typeof value.toolName === "string" && value.toolName.length > 0,
    "modelToolCallIntent.toolName is required"
  );
  invariant(
    isPlainObject(value.arguments) && isJsonSafeValue(value.arguments),
    "modelToolCallIntent.arguments must be a JSON-serializable object"
  );
}

/**
 * Enforces the "exactly the field matching `kind` is populated, every other
 * field is null" discipline described on `ModelResponse` itself -- a
 * response claiming `kind: "text"` with `text: null` (or with
 * `structuredResult` non-null) is malformed, not merely unconventional.
 */
export function assertModelResponse(value: unknown): asserts value is ModelResponse {
  invariant(isPlainObject(value), "model response must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "modelResponse.id is required");
  invariant(
    typeof value.requestId === "string" && value.requestId.length > 0,
    "modelResponse.requestId is required"
  );
  invariant(isModelResponseKind(value.kind), "invalid model response kind");

  assertNullableString(value.text, "modelResponse.text must be a string or null");
  invariant(
    value.structuredResult === null || (isPlainObject(value.structuredResult) && isJsonSafeValue(value.structuredResult)),
    "modelResponse.structuredResult must be a JSON-serializable object or null"
  );
  if (value.toolCall !== null) assertModelToolCallIntent(value.toolCall);
  assertNullableString(value.errorMessage, "modelResponse.errorMessage must be a string or null");

  // Exactly the field matching `kind` is populated; every other field is
  // null. `text` doubles as the clarification QUESTION for
  // "clarification_request", so both share the same field.
  const wantsText = value.kind === "text" || value.kind === "clarification_request";
  invariant(
    wantsText ? value.text !== null : value.text === null,
    `modelResponse.text must be non-null only when kind is "text" or "clarification_request"`
  );
  invariant(
    value.kind === "structured_result" ? value.structuredResult !== null : value.structuredResult === null,
    `modelResponse.structuredResult must be non-null only when kind is "structured_result"`
  );
  invariant(
    value.kind === "tool_call" ? value.toolCall !== null : value.toolCall === null,
    `modelResponse.toolCall must be non-null only when kind is "tool_call"`
  );
  invariant(
    value.kind === "error" ? value.errorMessage !== null : value.errorMessage === null,
    `modelResponse.errorMessage must be non-null only when kind is "error"`
  );

  invariant(isIsoTimestamp(value.createdAt), "modelResponse.createdAt must be an ISO timestamp");
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "modelResponse.metadata must be a JSON-serializable object"
  );
}

function assertModelInvocationError(value: unknown): asserts value is ModelInvocationError {
  invariant(isPlainObject(value), "model invocation error must be an object");
  invariant(isModelErrorKind(value.kind), "invalid model error kind");
  invariant(typeof value.message === "string", "model invocation error message must be a string");
}

export function assertModelInvocationResult(value: unknown): asserts value is ModelInvocationResult {
  invariant(isPlainObject(value), "model invocation result must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "modelInvocationResult.id is required");
  invariant(
    typeof value.requestId === "string" && value.requestId.length > 0,
    "modelInvocationResult.requestId is required"
  );
  invariant(
    typeof value.providerId === "string" && value.providerId.length > 0,
    "modelInvocationResult.providerId is required"
  );
  invariant(typeof value.modelId === "string" && value.modelId.length > 0, "modelInvocationResult.modelId is required");
  assertNullableString(value.sessionId, "modelInvocationResult.sessionId must be a string or null");
  invariant(
    value.status === "success" || value.status === "error",
    "invalid model invocation result status"
  );
  if (value.status === "success") {
    invariant(value.error === null, "modelInvocationResult.error must be null when status is success");
    assertModelResponse(value.response);
  } else {
    invariant(value.response === null, "modelInvocationResult.response must be null when status is error");
    assertModelInvocationError(value.error);
  }
  invariant(isIsoTimestamp(value.startedAt), "modelInvocationResult.startedAt must be an ISO timestamp");
  invariant(isIsoTimestamp(value.completedAt), "modelInvocationResult.completedAt must be an ISO timestamp");
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "modelInvocationResult.metadata must be a JSON-serializable object"
  );
}

export function assertModelProviderDescriptor(value: unknown): asserts value is ModelProviderDescriptor {
  invariant(isPlainObject(value), "model provider descriptor must be an object");
  invariant(
    typeof value.providerId === "string" && value.providerId.length > 0,
    "modelProviderDescriptor.providerId is required"
  );
  invariant(typeof value.modelId === "string" && value.modelId.length > 0, "modelProviderDescriptor.modelId is required");
  invariant(typeof value.supportsToolCalling === "boolean", "modelProviderDescriptor.supportsToolCalling must be a boolean");
  invariant(
    typeof value.supportsStructuredOutput === "boolean",
    "modelProviderDescriptor.supportsStructuredOutput must be a boolean"
  );
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "modelProviderDescriptor.metadata must be a JSON-serializable object"
  );
}

function isObservationScope(value: unknown): value is (typeof OBSERVATION_SCOPES)[number] {
  return typeof value === "string" && (OBSERVATION_SCOPES as readonly string[]).includes(value);
}

export function assertObservationResult(value: unknown): asserts value is ObservationResult {
  invariant(isPlainObject(value), "observation result must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "observationResult.id is required");
  invariant(
    typeof value.projectId === "string" && value.projectId.length > 0,
    "observationResult.projectId is required"
  );
  invariant(
    typeof value.projectVersion === "number" && Number.isInteger(value.projectVersion) && value.projectVersion >= 1,
    "observationResult.projectVersion must be a positive integer"
  );
  invariant(isObservationScope(value.scope), "invalid observationResult.scope");
  invariant(
    value.scopeObjectId === null || typeof value.scopeObjectId === "string",
    "observationResult.scopeObjectId must be a string or null"
  );
  invariant(
    value.scope === "object" ? typeof value.scopeObjectId === "string" && value.scopeObjectId.length > 0 : true,
    'observationResult.scopeObjectId is required when scope is "object"'
  );
  invariant(
    value.objectiveSummary === null || typeof value.objectiveSummary === "string",
    "observationResult.objectiveSummary must be a string or null"
  );

  invariant(Array.isArray(value.requirements), "observationResult.requirements must be an array");
  for (const requirement of value.requirements) assertRequirement(requirement);
  invariant(Array.isArray(value.constraints), "observationResult.constraints must be an array");
  for (const constraint of value.constraints) assertConstraint(constraint);
  invariant(Array.isArray(value.objects), "observationResult.objects must be an array");
  for (const object of value.objects) assertEngineeringObject(object);
  invariant(Array.isArray(value.relationships), "observationResult.relationships must be an array");
  for (const relationship of value.relationships) assertEntityRelationship(relationship);
  invariant(Array.isArray(value.decisions), "observationResult.decisions must be an array");
  for (const decision of value.decisions) assertDecision(decision);
  invariant(Array.isArray(value.experiments), "observationResult.experiments must be an array");
  for (const experiment of value.experiments) assertExperiment(experiment);
  invariant(Array.isArray(value.preferences), "observationResult.preferences must be an array");
  for (const preference of value.preferences) assertPreference(preference);

  invariant(
    Array.isArray(value.focusObjectIds) && value.focusObjectIds.every((id) => typeof id === "string"),
    "observationResult.focusObjectIds must be an array of strings"
  );
  invariant(
    value.sessionMode === "idle" ||
      value.sessionMode === "reviewing" ||
      value.sessionMode === "designing" ||
      value.sessionMode === "executing",
    "invalid observationResult.sessionMode"
  );
  invariant(
    Array.isArray(value.missingInformation) && value.missingInformation.every((entry) => typeof entry === "string"),
    "observationResult.missingInformation must be an array of strings"
  );
  invariant(
    Array.isArray(value.ambiguityIndicators) && value.ambiguityIndicators.every((entry) => typeof entry === "string"),
    "observationResult.ambiguityIndicators must be an array of strings"
  );
  invariant(isEntitySource(value.source), "invalid observationResult.source");
  invariant(isIsoTimestamp(value.observedAt), "observationResult.observedAt must be an ISO timestamp");
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "observationResult.metadata must be a JSON-serializable object"
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPlanStatus(value: unknown): value is (typeof PLAN_STATUSES)[number] {
  return typeof value === "string" && (PLAN_STATUSES as readonly string[]).includes(value);
}

function isPlanStepStatus(value: unknown): value is (typeof PLAN_STEP_STATUSES)[number] {
  return typeof value === "string" && (PLAN_STEP_STATUSES as readonly string[]).includes(value);
}

function isPlanRiskSeverity(value: unknown): value is (typeof PLAN_RISK_SEVERITIES)[number] {
  return typeof value === "string" && (PLAN_RISK_SEVERITIES as readonly string[]).includes(value);
}

export function assertPlanAssumption(value: unknown): asserts value is PlanAssumption {
  invariant(isPlainObject(value), "plan assumption must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "planAssumption.id is required");
  invariant(typeof value.description === "string" && value.description.trim().length > 0, "planAssumption.description is required");
  invariant(typeof value.rationale === "string", "planAssumption.rationale must be a string");
}

export function assertPlanQuestion(value: unknown): asserts value is PlanQuestion {
  invariant(isPlainObject(value), "plan question must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "planQuestion.id is required");
  invariant(typeof value.question === "string" && value.question.trim().length > 0, "planQuestion.question is required");
  invariant(typeof value.reason === "string", "planQuestion.reason must be a string");
}

export function assertPlanRisk(value: unknown): asserts value is PlanRisk {
  invariant(isPlainObject(value), "plan risk must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "planRisk.id is required");
  invariant(typeof value.description === "string" && value.description.trim().length > 0, "planRisk.description is required");
  invariant(typeof value.impact === "string", "planRisk.impact must be a string");
  invariant(isPlanRiskSeverity(value.severity), "invalid planRisk.severity");
}

export function assertPlanStep(value: unknown): asserts value is PlanStep {
  invariant(isPlainObject(value), "plan step must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "planStep.id is required");
  invariant(typeof value.order === "number" && Number.isInteger(value.order) && value.order >= 0, "planStep.order must be a non-negative integer");
  invariant(typeof value.title === "string" && value.title.trim().length > 0, "planStep.title is required");
  invariant(typeof value.description === "string" && value.description.trim().length > 0, "planStep.description is required");
  invariant(
    typeof value.purpose === "string" && value.purpose.trim().length > 0,
    "planStep.purpose is required -- an opaque step with no stated reason defeats P9's traceability requirement"
  );
  invariant(isStringArray(value.dependsOn), "planStep.dependsOn must be an array of strings");
  invariant(isStringArray(value.inputs), "planStep.inputs must be an array of strings");
  invariant(isStringArray(value.expectedOutputs), "planStep.expectedOutputs must be an array of strings");
  invariant(isStringArray(value.relevantRequirementIds), "planStep.relevantRequirementIds must be an array of strings");
  invariant(isStringArray(value.relevantConstraintIds), "planStep.relevantConstraintIds must be an array of strings");
  invariant(isStringArray(value.relevantObjectIds), "planStep.relevantObjectIds must be an array of strings");
  invariant(isStringArray(value.relevantDecisionIds), "planStep.relevantDecisionIds must be an array of strings");
  invariant(
    value.verificationIntent === null || typeof value.verificationIntent === "string",
    "planStep.verificationIntent must be a string or null"
  );
  invariant(isStringArray(value.assumptionIds), "planStep.assumptionIds must be an array of strings");
  invariant(isPlanStepStatus(value.status), "invalid planStep.status");
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "planStep.metadata must be a JSON-serializable object"
  );
}

export function assertPlan(value: unknown): asserts value is Plan {
  invariant(isPlainObject(value), "plan must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "plan.id is required");
  invariant(typeof value.projectId === "string" && value.projectId.length > 0, "plan.projectId is required");
  invariant(
    typeof value.projectVersion === "number" && Number.isInteger(value.projectVersion) && value.projectVersion >= 1,
    "plan.projectVersion must be a positive integer"
  );
  invariant(typeof value.observationId === "string" && value.observationId.length > 0, "plan.observationId is required");
  invariant(typeof value.objectiveSummary === "string", "plan.objectiveSummary must be a string");
  invariant(isPlanStatus(value.status), "invalid plan.status");

  invariant(Array.isArray(value.steps), "plan.steps must be an array");
  for (const step of value.steps) assertPlanStep(step);
  invariant(Array.isArray(value.assumptions), "plan.assumptions must be an array");
  for (const assumption of value.assumptions) assertPlanAssumption(assumption);
  invariant(Array.isArray(value.unresolvedQuestions), "plan.unresolvedQuestions must be an array");
  for (const question of value.unresolvedQuestions) assertPlanQuestion(question);
  invariant(Array.isArray(value.risks), "plan.risks must be an array");
  for (const risk of value.risks) assertPlanRisk(risk);
  invariant(isStringArray(value.missingInformation), "plan.missingInformation must be an array of strings");

  invariant(
    value.supersedesPlanId === null || (typeof value.supersedesPlanId === "string" && value.supersedesPlanId.length > 0),
    "plan.supersedesPlanId must be a non-empty string or null"
  );
  invariant(
    typeof value.version === "number" && Number.isInteger(value.version) && value.version >= 1,
    "plan.version must be a positive integer"
  );
  invariant(isEntitySource(value.source), "invalid plan.source");
  invariant(isIsoTimestamp(value.createdAt), "plan.createdAt must be an ISO timestamp");
  invariant(isIsoTimestamp(value.updatedAt), "plan.updatedAt must be an ISO timestamp");
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "plan.metadata must be a JSON-serializable object"
  );
}

function isProposalStatus(value: unknown): value is (typeof PROPOSAL_STATUSES)[number] {
  return typeof value === "string" && (PROPOSAL_STATUSES as readonly string[]).includes(value);
}

export function assertProposal(value: unknown): asserts value is Proposal {
  invariant(isPlainObject(value), "proposal must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "proposal.id is required");
  invariant(typeof value.projectId === "string" && value.projectId.length > 0, "proposal.projectId is required");
  invariant(
    typeof value.projectVersion === "number" && Number.isInteger(value.projectVersion) && value.projectVersion >= 1,
    "proposal.projectVersion must be a positive integer"
  );
  invariant(typeof value.planId === "string" && value.planId.length > 0, "proposal.planId is required");
  invariant(typeof value.planStepId === "string" && value.planStepId.length > 0, "proposal.planStepId is required");
  invariant(typeof value.objectiveSummary === "string", "proposal.objectiveSummary must be a string");
  invariant(typeof value.toolName === "string" && value.toolName.length > 0, "proposal.toolName is required");
  invariant(isToolTarget(value.toolTarget), "invalid proposal.toolTarget");
  invariant(isJsonSafeValue(value.input), "proposal.input must be JSON-serializable");
  if (value.target !== null) assertChangeTarget(value.target);
  invariant(
    typeof value.rationale === "string" && value.rationale.trim().length > 0,
    "proposal.rationale is required -- a proposal with no stated reason cannot be meaningfully reviewed"
  );
  invariant(
    typeof value.expectedEffect === "string" && value.expectedEffect.trim().length > 0,
    "proposal.expectedEffect is required"
  );
  invariant(isStringArray(value.relevantRequirementIds), "proposal.relevantRequirementIds must be an array of strings");
  invariant(isStringArray(value.relevantConstraintIds), "proposal.relevantConstraintIds must be an array of strings");
  invariant(isProposalStatus(value.status), "invalid proposal.status");
  invariant(
    value.supersedesProposalId === null ||
      (typeof value.supersedesProposalId === "string" && value.supersedesProposalId.length > 0),
    "proposal.supersedesProposalId must be a non-empty string or null"
  );
  invariant(
    typeof value.version === "number" && Number.isInteger(value.version) && value.version >= 1,
    "proposal.version must be a positive integer"
  );
  invariant(isEntitySource(value.source), "invalid proposal.source");
  invariant(isIsoTimestamp(value.createdAt), "proposal.createdAt must be an ISO timestamp");
  invariant(isIsoTimestamp(value.updatedAt), "proposal.updatedAt must be an ISO timestamp");
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "proposal.metadata must be a JSON-serializable object"
  );
}

function isCandidateStatus(value: unknown): value is (typeof CANDIDATE_STATUSES)[number] {
  return typeof value === "string" && (CANDIDATE_STATUSES as readonly string[]).includes(value);
}

/**
 * Validates a `Candidate` (P22) -- shape only, environment-independent,
 * knows nothing about `DesignSpecification`'s own internal fields (only
 * that `designSpecificationId`, when set, is a non-empty string
 * reference). Cross-references (does `planId` resolve? does
 * `designSpecificationId` actually belong to the same plan step? do
 * `relevantRequirementIds` resolve?) are `candidate-semantics.ts`'s job
 * (core), matching `assertProposal`/`assertDesignSpecification`'s
 * identical "shape here, semantics in a separate pure function" split.
 */
export function assertCandidate(value: unknown): asserts value is Candidate {
  invariant(isPlainObject(value), "candidate must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "candidate.id is required");
  invariant(typeof value.projectId === "string" && value.projectId.length > 0, "candidate.projectId is required");
  invariant(
    typeof value.projectVersion === "number" && Number.isInteger(value.projectVersion) && value.projectVersion >= 1,
    "candidate.projectVersion must be a positive integer"
  );
  invariant(typeof value.planId === "string" && value.planId.length > 0, "candidate.planId is required");
  invariant(
    value.planStepId === null || (typeof value.planStepId === "string" && value.planStepId.length > 0),
    "candidate.planStepId must be a non-empty string or null"
  );
  invariant(
    value.designSpecificationId === null || (typeof value.designSpecificationId === "string" && value.designSpecificationId.length > 0),
    "candidate.designSpecificationId must be a non-empty string or null"
  );
  invariant(
    value.proposalId === null || (typeof value.proposalId === "string" && value.proposalId.length > 0),
    "candidate.proposalId must be a non-empty string or null"
  );
  invariant(isStringArray(value.relevantRequirementIds), "candidate.relevantRequirementIds must be an array of strings");
  invariant(isStringArray(value.relevantConstraintIds), "candidate.relevantConstraintIds must be an array of strings");
  invariant(isStringArray(value.relevantResearchEvidenceIds), "candidate.relevantResearchEvidenceIds must be an array of strings");
  invariant(isStringArray(value.assumptionIds), "candidate.assumptionIds must be an array of strings");
  invariant(typeof value.hypothesis === "string" && value.hypothesis.trim().length > 0, "candidate.hypothesis is required");
  invariant(typeof value.rationale === "string" && value.rationale.trim().length > 0, "candidate.rationale is required");
  invariant(
    value.parentCandidateId === null || (typeof value.parentCandidateId === "string" && value.parentCandidateId.length > 0),
    "candidate.parentCandidateId must be a non-empty string or null"
  );
  invariant(isCandidateStatus(value.status), "invalid candidate.status");
  invariant(isEntitySource(value.source), "invalid candidate.source");
  invariant(isIsoTimestamp(value.createdAt), "candidate.createdAt must be an ISO timestamp");
  invariant(isIsoTimestamp(value.updatedAt), "candidate.updatedAt must be an ISO timestamp");
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "candidate.metadata must be a JSON-serializable object"
  );
}

function isExecutionOutcome(value: unknown): value is (typeof EXECUTION_OUTCOMES)[number] {
  return typeof value === "string" && (EXECUTION_OUTCOMES as readonly string[]).includes(value);
}

export function assertExecutionResult(value: unknown): asserts value is ExecutionResult {
  invariant(isPlainObject(value), "execution result must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "executionResult.id is required");
  invariant(
    typeof value.proposalId === "string" && value.proposalId.length > 0,
    "executionResult.proposalId is required"
  );
  assertNullableString(value.approvalId, "executionResult.approvalId must be a string or null");
  assertNullableString(value.toolRequestId, "executionResult.toolRequestId must be a string or null");
  invariant(isExecutionOutcome(value.outcome), "invalid executionResult.outcome");
  if (value.outcome === "rejected" || value.outcome === "stale") {
    invariant(value.toolResult === null, "executionResult.toolResult must be null when outcome is 'rejected' or 'stale'");
  } else {
    invariant(
      value.toolResult !== null,
      "executionResult.toolResult must be present unless outcome is 'rejected' or 'stale'"
    );
    assertToolResult(value.toolResult);
  }
  invariant(isIsoTimestamp(value.startedAt), "executionResult.startedAt must be an ISO timestamp");
  invariant(isIsoTimestamp(value.completedAt), "executionResult.completedAt must be an ISO timestamp");
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "executionResult.metadata must be a JSON-serializable object"
  );
}

function isAgentLoopRunStatus(value: unknown): value is (typeof AGENT_LOOP_RUN_STATUSES)[number] {
  return typeof value === "string" && (AGENT_LOOP_RUN_STATUSES as readonly string[]).includes(value);
}

function assertLoopDiscrepancy(value: unknown, message: string): void {
  invariant(value === null || isPlainObject(value), message);
  if (value === null) return;
  const record = value as Record<string, unknown>;
  invariant(typeof record.detected === "boolean", `${message} (detected must be a boolean)`);
  invariant(typeof record.description === "string", `${message} (description must be a string)`);
}

export function assertAgentLoopRun(value: unknown): asserts value is AgentLoopRun {
  invariant(isPlainObject(value), "agent loop run must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "agentLoopRun.id is required");
  invariant(
    typeof value.projectId === "string" && value.projectId.length > 0,
    "agentLoopRun.projectId is required"
  );
  assertObservationResult(value.observationBefore);
  assertPlan(value.plan);
  invariant(
    typeof value.planStepId === "string" && value.planStepId.length > 0,
    "agentLoopRun.planStepId is required"
  );
  assertProposal(value.proposal);
  if (value.approval !== null) assertApproval(value.approval);
  if (value.executionResult !== null) assertExecutionResult(value.executionResult);
  if (value.observationAfter !== null) assertObservationResult(value.observationAfter);
  assertLoopDiscrepancy(value.discrepancy, "agentLoopRun.discrepancy must be a LoopDiscrepancy or null");
  invariant(isAgentLoopRunStatus(value.status), "invalid agentLoopRun.status");
  invariant(isEntitySource(value.source), "invalid agentLoopRun.source");
  invariant(isIsoTimestamp(value.createdAt), "agentLoopRun.createdAt must be an ISO timestamp");
  invariant(isIsoTimestamp(value.updatedAt), "agentLoopRun.updatedAt must be an ISO timestamp");
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "agentLoopRun.metadata must be a JSON-serializable object"
  );
}

function isCheckpointStatus(value: unknown): value is (typeof CHECKPOINT_STATUSES)[number] {
  return typeof value === "string" && (CHECKPOINT_STATUSES as readonly string[]).includes(value);
}

export function assertCheckpointArtifactRef(value: unknown): asserts value is CheckpointArtifactRef {
  invariant(isPlainObject(value), "checkpoint artifact ref must be an object");
  invariant(typeof value.artifactId === "string" && value.artifactId.length > 0, "checkpointArtifactRef.artifactId is required");
  invariant(
    typeof value.contentHash === "string" && /^[0-9a-f]{64}$/.test(value.contentHash),
    "checkpointArtifactRef.contentHash must be a 64-character lowercase hex SHA-256 digest"
  );
  invariant(
    typeof value.byteSize === "number" && Number.isInteger(value.byteSize) && value.byteSize >= 0,
    "checkpointArtifactRef.byteSize must be a non-negative integer"
  );
  invariant(typeof value.schemaVersion === "string" && value.schemaVersion.length > 0, "checkpointArtifactRef.schemaVersion is required");
}

export function assertCheckpointEnvironmentSnapshot(value: unknown): asserts value is CheckpointEnvironmentSnapshot {
  invariant(isPlainObject(value), "checkpoint environment snapshot must be an object");
  invariant(
    typeof value.environmentKind === "string" && value.environmentKind.length > 0,
    "checkpointEnvironmentSnapshot.environmentKind is required"
  );
  invariant(
    typeof value.environmentCheckpointId === "string" && value.environmentCheckpointId.length > 0,
    "checkpointEnvironmentSnapshot.environmentCheckpointId is required"
  );
  assertNullableString(value.documentName, "checkpointEnvironmentSnapshot.documentName must be a string or null");
  invariant(Array.isArray(value.objectIds) && value.objectIds.every((id) => typeof id === "string"), "checkpointEnvironmentSnapshot.objectIds must be an array of strings");
  invariant(
    typeof value.contentHash === "string" && /^[0-9a-f]{64}$/.test(value.contentHash),
    "checkpointEnvironmentSnapshot.contentHash must be a 64-character lowercase hex SHA-256 digest"
  );
}

export function assertCheckpoint(value: unknown): asserts value is Checkpoint {
  invariant(isPlainObject(value), "checkpoint must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "checkpoint.id is required");
  invariant(typeof value.projectId === "string" && value.projectId.length > 0, "checkpoint.projectId is required");
  assertNullableString(value.sessionId, "checkpoint.sessionId must be a string or null");
  invariant(isCheckpointStatus(value.status), "invalid checkpoint.status");
  invariant(typeof value.reason === "string", "checkpoint.reason must be a string");
  invariant(isEntitySource(value.source), "invalid checkpoint.source");
  invariant(isIsoTimestamp(value.createdAt), "checkpoint.createdAt must be an ISO timestamp");
  assertNullableString(value.lastChangeId, "checkpoint.lastChangeId must be a string or null");
  invariant(
    typeof value.projectVersion === "number" && Number.isInteger(value.projectVersion) && value.projectVersion >= 1,
    "checkpoint.projectVersion must be a positive integer"
  );
  assertCheckpointArtifactRef(value.worldModelSnapshot);
  if (value.environmentSnapshot !== null) assertCheckpointEnvironmentSnapshot(value.environmentSnapshot);
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "checkpoint.metadata must be a JSON-serializable object"
  );
}

function isCheckKind(value: unknown): value is (typeof CHECK_KINDS)[number] {
  return typeof value === "string" && (CHECK_KINDS as readonly string[]).includes(value);
}

function isNumericComparisonOperator(value: unknown): value is (typeof NUMERIC_COMPARISON_OPERATORS)[number] {
  return typeof value === "string" && (NUMERIC_COMPARISON_OPERATORS as readonly string[]).includes(value);
}

function isVerificationStatus(value: unknown): value is (typeof VERIFICATION_STATUSES)[number] {
  return typeof value === "string" && (VERIFICATION_STATUSES as readonly string[]).includes(value);
}

function isVerificationReasonKind(value: unknown): value is (typeof VERIFICATION_REASON_KINDS)[number] {
  return typeof value === "string" && (VERIFICATION_REASON_KINDS as readonly string[]).includes(value);
}

function assertBaseCheckFields(value: Record<string, unknown>): void {
  invariant(typeof value.id === "string" && value.id.length > 0, "check.id is required");
  invariant(isCheckKind(value.kind), "invalid check.kind");
  invariant(typeof value.description === "string" && value.description.trim().length > 0, "check.description is required");
  invariant(isIsoTimestamp(value.createdAt), "check.createdAt must be an ISO timestamp");
  invariant(isPlainObject(value.metadata) && isJsonSafeValue(value.metadata), "check.metadata must be a JSON-serializable object");
}

function assertCheckObjectId(value: Record<string, unknown>): void {
  invariant(typeof value.objectId === "string" && value.objectId.length > 0, "check.objectId is required");
}

function assertCheckProperty(value: Record<string, unknown>): void {
  invariant(typeof value.property === "string" && value.property.length > 0, "check.property is required");
}

function assertNumericComparisonCheck(value: Record<string, unknown>): void {
  assertCheckObjectId(value);
  assertCheckProperty(value);
  invariant(isNumericComparisonOperator(value.operator), "invalid check.operator");
  invariant(typeof value.expectedValue === "number" && Number.isFinite(value.expectedValue), "check.expectedValue must be a finite number");
  assertNullableString(value.expectedUnit, "check.expectedUnit must be a string or null");
  invariant(
    value.tolerance === null || (typeof value.tolerance === "number" && Number.isFinite(value.tolerance) && value.tolerance >= 0),
    "check.tolerance must be a non-negative finite number or null"
  );
}

function assertBoundsCheck(value: Record<string, unknown>): void {
  assertCheckObjectId(value);
  assertCheckProperty(value);
  invariant(value.min === null || (typeof value.min === "number" && Number.isFinite(value.min)), "check.min must be a finite number or null");
  invariant(value.max === null || (typeof value.max === "number" && Number.isFinite(value.max)), "check.max must be a finite number or null");
  invariant(value.min !== null || value.max !== null, "check must set at least one of min/max");
  if (typeof value.min === "number" && typeof value.max === "number") {
    invariant(value.min <= value.max, "check.min must not be greater than check.max");
  }
  invariant(typeof value.minInclusive === "boolean", "check.minInclusive must be a boolean");
  invariant(typeof value.maxInclusive === "boolean", "check.maxInclusive must be a boolean");
  assertNullableString(value.unit, "check.unit must be a string or null");
}

function assertObjectExistsCheck(value: Record<string, unknown>): void {
  assertCheckObjectId(value);
}

function assertObjectTypeCheck(value: Record<string, unknown>): void {
  assertCheckObjectId(value);
  invariant(isEnvironmentObjectGenericType(value.expectedGenericType), "invalid check.expectedGenericType");
}

function assertPropertyRequiredCheck(value: Record<string, unknown>): void {
  assertCheckObjectId(value);
  assertCheckProperty(value);
  invariant(typeof value.requireNonNull === "boolean", "check.requireNonNull must be a boolean");
}

/**
 * Validates a `Check` -- a discriminated union keyed by `kind`, mirroring
 * `WorldModelTransition`'s own established discriminated-union validation
 * pattern (each kind gets its own field checks; the shared identity fields
 * are checked once via `assertBaseCheckFields`). This is the ONE place
 * every check kind's shape is enforced -- Phase 16's "no arbitrary
 * expressions" requirement starts here: `kind` must be one of the
 * allowlisted `CHECK_KINDS`, never an open string.
 */
export function assertCheck(value: unknown): asserts value is Check {
  invariant(isPlainObject(value), "check must be an object");
  assertBaseCheckFields(value);
  switch (value.kind) {
    case "numeric_comparison":
      assertNumericComparisonCheck(value);
      return;
    case "bounds_check":
      assertBoundsCheck(value);
      return;
    case "object_exists":
      assertObjectExistsCheck(value);
      return;
    case "object_type":
      assertObjectTypeCheck(value);
      return;
    case "property_required":
      assertPropertyRequiredCheck(value);
      return;
    default:
      throw new WorldModelValidationError("invalid_shape", `Unsupported check kind: ${JSON.stringify((value as { kind: unknown }).kind)}`);
  }
}

export function assertEvidence(value: unknown): asserts value is Evidence {
  invariant(isPlainObject(value), "evidence must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "evidence.id is required");
  assertNullableString(value.objectId, "evidence.objectId must be a string or null");
  invariant(value.objectExists === null || typeof value.objectExists === "boolean", "evidence.objectExists must be a boolean or null");
  invariant(
    value.observedGenericType === null || isEnvironmentObjectGenericType(value.observedGenericType),
    "evidence.observedGenericType must be a valid generic type or null"
  );
  assertNullableString(value.property, "evidence.property must be a string or null");
  invariant(value.propertyExists === null || typeof value.propertyExists === "boolean", "evidence.propertyExists must be a boolean or null");
  invariant(isJsonSafeValue(value.observedValue ?? null), "evidence.observedValue must be JSON-serializable");
  assertNullableString(value.unit, "evidence.unit must be a string or null");
  assertNullableString(value.observationId, "evidence.observationId must be a string or null");
  invariant(
    value.stateVersion === null || (typeof value.stateVersion === "number" && Number.isInteger(value.stateVersion) && value.stateVersion >= 1),
    "evidence.stateVersion must be a positive integer or null"
  );
  assertNullableString(value.environmentKind, "evidence.environmentKind must be a string or null");
  invariant(isIsoTimestamp(value.observedAt), "evidence.observedAt must be an ISO timestamp");
  invariant(isEntitySource(value.source), "invalid evidence.source");
  invariant(isPlainObject(value.metadata) && isJsonSafeValue(value.metadata), "evidence.metadata must be a JSON-serializable object");
}

export function assertVerificationResult(value: unknown): asserts value is VerificationResult {
  invariant(isPlainObject(value), "verification result must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "verificationResult.id is required");
  invariant(typeof value.checkId === "string" && value.checkId.length > 0, "verificationResult.checkId is required");
  invariant(isCheckKind(value.checkKind), "invalid verificationResult.checkKind");
  invariant(isVerificationStatus(value.status), "invalid verificationResult.status");
  invariant(isVerificationReasonKind(value.reasonKind), "invalid verificationResult.reasonKind");
  invariant(typeof value.message === "string" && value.message.length > 0, "verificationResult.message is required");
  invariant(isJsonSafeValue(value.expected ?? null), "verificationResult.expected must be JSON-serializable");
  invariant(isJsonSafeValue(value.actual ?? null), "verificationResult.actual must be JSON-serializable");
  if (value.evidence !== null) assertEvidence(value.evidence);
  invariant(typeof value.projectId === "string" && value.projectId.length > 0, "verificationResult.projectId is required");
  invariant(
    typeof value.projectVersion === "number" && Number.isInteger(value.projectVersion) && value.projectVersion >= 1,
    "verificationResult.projectVersion must be a positive integer"
  );
  assertNullableString(value.environmentKind, "verificationResult.environmentKind must be a string or null");
  assertNullableString(value.documentName, "verificationResult.documentName must be a string or null");
  invariant(isIsoTimestamp(value.evaluatedAt), "verificationResult.evaluatedAt must be an ISO timestamp");
  invariant(isPlainObject(value.metadata) && isJsonSafeValue(value.metadata), "verificationResult.metadata must be a JSON-serializable object");
}

function isObjectiveSatisfactionStatus(value: unknown): value is (typeof OBJECTIVE_SATISFACTION_STATUSES)[number] {
  return typeof value === "string" && (OBJECTIVE_SATISFACTION_STATUSES as readonly string[]).includes(value);
}

function isObjectiveConditionReasonKind(value: unknown): value is (typeof OBJECTIVE_CONDITION_REASON_KINDS)[number] {
  return typeof value === "string" && (OBJECTIVE_CONDITION_REASON_KINDS as readonly string[]).includes(value);
}

export function assertObjectiveConditionOutcome(value: unknown): asserts value is ObjectiveConditionOutcome {
  invariant(isPlainObject(value), "objective condition outcome must be an object");
  invariant(typeof value.checkId === "string" && value.checkId.length > 0, "objectiveConditionOutcome.checkId is required");
  invariant(value.checkKind === null || isCheckKind(value.checkKind), "objectiveConditionOutcome.checkKind must be a valid check kind or null");
  assertNullableString(value.requirementId, "objectiveConditionOutcome.requirementId must be a string or null");
  assertNullableString(value.constraintId, "objectiveConditionOutcome.constraintId must be a string or null");
  invariant(typeof value.required === "boolean", "objectiveConditionOutcome.required must be a boolean");
  assertNullableString(value.verificationResultId, "objectiveConditionOutcome.verificationResultId must be a string or null");
  invariant(isVerificationStatus(value.effectiveStatus), "invalid objectiveConditionOutcome.effectiveStatus");
  invariant(isObjectiveConditionReasonKind(value.reasonKind), "invalid objectiveConditionOutcome.reasonKind");
  invariant(typeof value.message === "string" && value.message.length > 0, "objectiveConditionOutcome.message is required");
}

export function assertObjectiveSatisfactionResult(value: unknown): asserts value is ObjectiveSatisfactionResult {
  invariant(isPlainObject(value), "objective satisfaction result must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "objectiveSatisfactionResult.id is required");
  invariant(typeof value.projectId === "string" && value.projectId.length > 0, "objectiveSatisfactionResult.projectId is required");
  invariant(
    typeof value.projectVersion === "number" && Number.isInteger(value.projectVersion) && value.projectVersion >= 1,
    "objectiveSatisfactionResult.projectVersion must be a positive integer"
  );
  assertNullableString(value.objectiveSummary, "objectiveSatisfactionResult.objectiveSummary must be a string or null");
  invariant(isObjectiveSatisfactionStatus(value.status), "invalid objectiveSatisfactionResult.status");
  invariant(typeof value.reason === "string" && value.reason.length > 0, "objectiveSatisfactionResult.reason is required");
  invariant(Array.isArray(value.conditions), "objectiveSatisfactionResult.conditions must be an array");
  for (const condition of value.conditions) {
    assertObjectiveConditionOutcome(condition);
  }
  invariant(isIsoTimestamp(value.evaluatedAt), "objectiveSatisfactionResult.evaluatedAt must be an ISO timestamp");
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "objectiveSatisfactionResult.metadata must be a JSON-serializable object"
  );
}

function isRequirementInterpretationStatus(value: unknown): value is (typeof REQUIREMENT_INTERPRETATION_STATUSES)[number] {
  return typeof value === "string" && (REQUIREMENT_INTERPRETATION_STATUSES as readonly string[]).includes(value);
}

/**
 * Validates a `RequirementCandidate` -- including the self-contained
 * invariant Phase 18 exists to enforce: an `"ambiguous"` candidate can
 * NEVER carry a numeric criterion. This is checked HERE (schema layer),
 * not merely hoped for from the model's own output, matching this
 * codebase's "the validator is authoritative, not the caller's good
 * behavior" discipline (e.g. `assertBoundsCheck`'s identical
 * self-contained min/max invariant, P16).
 */
export function assertRequirementCandidate(value: unknown): asserts value is RequirementCandidate {
  invariant(isPlainObject(value), "requirement candidate must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "requirementCandidate.id is required");
  invariant(typeof value.projectId === "string" && value.projectId.length > 0, "requirementCandidate.projectId is required");
  invariant(
    typeof value.projectVersion === "number" && Number.isInteger(value.projectVersion) && value.projectVersion >= 1,
    "requirementCandidate.projectVersion must be a positive integer"
  );
  invariant(typeof value.statementText === "string" && value.statementText.trim().length > 0, "requirementCandidate.statementText is required");
  invariant(typeof value.description === "string" && value.description.trim().length > 0, "requirementCandidate.description is required");
  invariant(typeof value.category === "string" && value.category.trim().length > 0, "requirementCandidate.category is required");
  invariant(isRequirementInterpretationStatus(value.interpretationStatus), "invalid requirementCandidate.interpretationStatus");
  invariant(
    value.operator === null || isNumericComparisonOperator(value.operator),
    "requirementCandidate.operator must be a valid numeric comparison operator or null"
  );
  invariant(
    value.value === null || (typeof value.value === "number" && Number.isFinite(value.value)),
    "requirementCandidate.value must be a finite number or null"
  );
  assertNullableString(value.unit, "requirementCandidate.unit must be a string or null");
  if (value.interpretationStatus === "ambiguous") {
    invariant(value.operator === null, "an ambiguous requirementCandidate must not carry an operator");
    invariant(value.value === null, "an ambiguous requirementCandidate must not carry a value");
    invariant(value.unit === null, "an ambiguous requirementCandidate must not carry a unit");
    invariant(
      typeof value.ambiguityReason === "string" && value.ambiguityReason.trim().length > 0,
      "an ambiguous requirementCandidate must carry a non-empty ambiguityReason"
    );
  } else {
    invariant(value.ambiguityReason === null, "a specific requirementCandidate must not carry an ambiguityReason");
    invariant(
      value.operator === null || (typeof value.value === "number" && Number.isFinite(value.value)),
      "a requirementCandidate with an operator must also carry a finite numeric value"
    );
    // Symmetric to the check above: a bare number with no operator has no
    // defined comparison semantics (what does "value: 500" mean without
    // knowing at-least/at-most/exactly?) and is exactly the kind of
    // half-structured, unusable "fact" Phase 18 must not let through --
    // reject it here rather than silently carrying an unexplained number.
    invariant(
      value.value === null || value.operator !== null,
      "a requirementCandidate with a numeric value must also carry an operator"
    );
  }
  invariant(
    value.priority === "low" || value.priority === "medium" || value.priority === "high",
    "invalid requirementCandidate.priority"
  );
  invariant(isEntitySource(value.source), "invalid requirementCandidate.source");
  invariant(isIsoTimestamp(value.createdAt), "requirementCandidate.createdAt must be an ISO timestamp");
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "requirementCandidate.metadata must be a JSON-serializable object"
  );
}

function isClarificationCategory(value: unknown): value is (typeof CLARIFICATION_CATEGORIES)[number] {
  return typeof value === "string" && (CLARIFICATION_CATEGORIES as readonly string[]).includes(value);
}

function isClarificationStatus(value: unknown): value is (typeof CLARIFICATION_STATUSES)[number] {
  return typeof value === "string" && (CLARIFICATION_STATUSES as readonly string[]).includes(value);
}

/**
 * Validates a `Clarification` (P19) -- including the self-contained
 * lifecycle invariants that keep "asked" / "answered" / "dismissed" /
 * "superseded" from ever being ambiguous with each other:
 *   - `answerText`/`answeredAt` are BOTH set or BOTH `null`, and can only
 *     be set when `status === "answered"` -- an answer can never be
 *     recorded without the status reflecting it (or vice versa).
 *   - `supersededBy` is set if and only if `status === "superseded"`.
 *   - `affectedFields` must be a non-empty array of non-empty strings --
 *     a clarification with no named affected field is a clarification
 *     about nothing.
 *   - `requirementCandidateId` must equal `candidateSnapshot.id`, and
 *     `projectId` must equal `candidateSnapshot.projectId` -- a
 *     `Clarification` can never claim to be about a candidate it doesn't
 *     actually embed, and can never cross a project boundary. This is the
 *     same class of gap the P17 audit found and fixed (a caller-supplied
 *     id resolving to a DIFFERENT project's record) closed here
 *     proactively, at construction time, rather than after the fact.
 * Matches `assertRequirementCandidate`'s identical "the validator is
 * authoritative, not the caller's good behavior" discipline.
 */
export function assertClarification(value: unknown): asserts value is Clarification {
  invariant(isPlainObject(value), "clarification must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "clarification.id is required");
  invariant(typeof value.projectId === "string" && value.projectId.length > 0, "clarification.projectId is required");
  invariant(
    typeof value.requirementCandidateId === "string" && value.requirementCandidateId.length > 0,
    "clarification.requirementCandidateId is required"
  );
  assertRequirementCandidate(value.candidateSnapshot);
  invariant(
    value.requirementCandidateId === value.candidateSnapshot.id,
    "clarification.requirementCandidateId must match candidateSnapshot.id"
  );
  invariant(value.projectId === value.candidateSnapshot.projectId, "clarification.projectId must match candidateSnapshot.projectId");
  invariant(typeof value.question === "string" && value.question.trim().length > 0, "clarification.question is required");
  invariant(typeof value.reason === "string" && value.reason.trim().length > 0, "clarification.reason is required");
  invariant(isClarificationCategory(value.category), "invalid clarification.category");
  invariant(
    Array.isArray(value.affectedFields) &&
      value.affectedFields.length > 0 &&
      value.affectedFields.every((field) => typeof field === "string" && field.length > 0),
    "clarification.affectedFields must be a non-empty array of non-empty strings"
  );
  invariant(isClarificationStatus(value.status), "invalid clarification.status");
  assertNullableString(value.answerText, "clarification.answerText must be a string or null");
  if (value.status === "answered") {
    invariant(typeof value.answerText === "string" && value.answerText.trim().length > 0, "an answered clarification must carry a non-empty answerText");
    invariant(typeof value.answeredAt === "string" && isIsoTimestamp(value.answeredAt), "an answered clarification must carry a valid answeredAt timestamp");
  } else {
    invariant(value.answerText === null, "a non-answered clarification must not carry an answerText");
    invariant(value.answeredAt === null, "a non-answered clarification must not carry an answeredAt");
  }
  if (value.status === "superseded") {
    invariant(typeof value.supersededBy === "string" && value.supersededBy.length > 0, "a superseded clarification must carry supersededBy");
  } else {
    invariant(value.supersededBy === null, "a non-superseded clarification must not carry supersededBy");
  }
  invariant(isEntitySource(value.source), "invalid clarification.source");
  invariant(isIsoTimestamp(value.createdAt), "clarification.createdAt must be an ISO timestamp");
  invariant(isPlainObject(value.metadata) && isJsonSafeValue(value.metadata), "clarification.metadata must be a JSON-serializable object");
}

function isDesignSpecificationStatus(value: unknown): value is (typeof DESIGN_SPECIFICATION_STATUSES)[number] {
  return typeof value === "string" && (DESIGN_SPECIFICATION_STATUSES as readonly string[]).includes(value);
}

/** Validates one `DesignComponent` -- structural only (numeric dimensions,
 * required fields); cross-component references (`parentComponentId`
 * resolving, no cycles) are a SEMANTIC concern checked by
 * `design-semantics.ts`, not here, matching `assertPlanStep`'s identical
 * "shape here, cross-reference elsewhere" split. */
export function assertDesignComponent(value: unknown): asserts value is DesignComponent {
  invariant(isPlainObject(value), "design component must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "designComponent.id is required");
  invariant(typeof value.name === "string" && value.name.trim().length > 0, "designComponent.name is required");
  invariant(typeof value.type === "string" && value.type.trim().length > 0, "designComponent.type is required");
  invariant(typeof value.geometryIntent === "string" && value.geometryIntent.trim().length > 0, "designComponent.geometryIntent is required");
  invariant(isPlainObject(value.dimensions), "designComponent.dimensions must be an object");
  for (const [key, dimension] of Object.entries(value.dimensions)) {
    invariant(typeof dimension === "number" && Number.isFinite(dimension), `designComponent.dimensions.${key} must be a finite number`);
  }
  invariant(
    value.parentComponentId === null || (typeof value.parentComponentId === "string" && value.parentComponentId.length > 0),
    "designComponent.parentComponentId must be a non-empty string or null"
  );
  invariant(isPlainObject(value.metadata) && isJsonSafeValue(value.metadata), "designComponent.metadata must be a JSON-serializable object");
}

export function assertDesignRelationship(value: unknown): asserts value is DesignRelationship {
  invariant(isPlainObject(value), "design relationship must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "designRelationship.id is required");
  invariant(typeof value.type === "string" && value.type.trim().length > 0, "designRelationship.type is required");
  invariant(typeof value.sourceComponentId === "string" && value.sourceComponentId.length > 0, "designRelationship.sourceComponentId is required");
  invariant(typeof value.targetComponentId === "string" && value.targetComponentId.length > 0, "designRelationship.targetComponentId is required");
  invariant(isPlainObject(value.metadata) && isJsonSafeValue(value.metadata), "designRelationship.metadata must be a JSON-serializable object");
}

export function assertExpectedBuildOutput(value: unknown): asserts value is ExpectedBuildOutput {
  invariant(isPlainObject(value), "expected build output must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "expectedBuildOutput.id is required");
  invariant(typeof value.componentId === "string" && value.componentId.length > 0, "expectedBuildOutput.componentId is required");
  invariant(
    typeof value.environmentObjectType === "string" && value.environmentObjectType.trim().length > 0,
    "expectedBuildOutput.environmentObjectType is required"
  );
  invariant(
    value.environmentGenericType === null || isEnvironmentObjectGenericType(value.environmentGenericType),
    "invalid expectedBuildOutput.environmentGenericType"
  );
  invariant(isPlainObject(value.properties) && isJsonSafeValue(value.properties), "expectedBuildOutput.properties must be a JSON-serializable object");
}

/**
 * Validates a `DesignSpecification` (P20) -- environment-independent by
 * construction: nothing here checks for (or knows about) a FreeCAD
 * concept. Cross-references among `components`/`expectedOutputs` (does
 * `componentId` resolve? is `parentComponentId` cycle-free?) are
 * `design-semantics.ts`'s job, matching `assertProposal`'s identical
 * "shape here, semantics in a separate pure function" split -- see that
 * file's own doc comment for why the split matters (a caller who only
 * needs shape validation shouldn't have to construct a `Plan`/`ToolRegistry`
 * just to call `assertDesignSpecification`).
 */
export function assertDesignSpecification(value: unknown): asserts value is DesignSpecification {
  invariant(isPlainObject(value), "design specification must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "designSpecification.id is required");
  invariant(typeof value.projectId === "string" && value.projectId.length > 0, "designSpecification.projectId is required");
  invariant(
    typeof value.projectVersion === "number" && Number.isInteger(value.projectVersion) && value.projectVersion >= 1,
    "designSpecification.projectVersion must be a positive integer"
  );
  invariant(typeof value.planId === "string" && value.planId.length > 0, "designSpecification.planId is required");
  invariant(typeof value.planStepId === "string" && value.planStepId.length > 0, "designSpecification.planStepId is required");
  invariant(typeof value.objectiveSummary === "string", "designSpecification.objectiveSummary must be a string");
  invariant(typeof value.description === "string" && value.description.trim().length > 0, "designSpecification.description is required");

  invariant(Array.isArray(value.components), "designSpecification.components must be an array");
  for (const component of value.components) assertDesignComponent(component);
  invariant(Array.isArray(value.relationships), "designSpecification.relationships must be an array");
  for (const relationship of value.relationships) assertDesignRelationship(relationship);

  invariant(isPlainObject(value.parameters) && isJsonSafeValue(value.parameters), "designSpecification.parameters must be a JSON-serializable object");
  invariant(value.material === null || typeof value.material === "string", "designSpecification.material must be a string or null");
  invariant(
    value.manufacturingIntent === null || typeof value.manufacturingIntent === "string",
    "designSpecification.manufacturingIntent must be a string or null"
  );
  invariant(isStringArray(value.relevantConstraintIds), "designSpecification.relevantConstraintIds must be an array of strings");
  invariant(isStringArray(value.relevantRequirementIds), "designSpecification.relevantRequirementIds must be an array of strings");

  invariant(Array.isArray(value.expectedOutputs), "designSpecification.expectedOutputs must be an array");
  for (const output of value.expectedOutputs) assertExpectedBuildOutput(output);

  invariant(isDesignSpecificationStatus(value.status), "invalid designSpecification.status");
  invariant(
    value.supersedesDesignSpecificationId === null ||
      (typeof value.supersedesDesignSpecificationId === "string" && value.supersedesDesignSpecificationId.length > 0),
    "designSpecification.supersedesDesignSpecificationId must be a non-empty string or null"
  );
  invariant(
    typeof value.version === "number" && Number.isInteger(value.version) && value.version >= 1,
    "designSpecification.version must be a positive integer"
  );
  invariant(isEntitySource(value.source), "invalid designSpecification.source");
  invariant(isIsoTimestamp(value.createdAt), "designSpecification.createdAt must be an ISO timestamp");
  invariant(isIsoTimestamp(value.updatedAt), "designSpecification.updatedAt must be an ISO timestamp");
  invariant(
    isPlainObject(value.metadata) && isJsonSafeValue(value.metadata),
    "designSpecification.metadata must be a JSON-serializable object"
  );
}

function isBuildOperationStatus(value: unknown): value is (typeof BUILD_OPERATION_STATUSES)[number] {
  return typeof value === "string" && (BUILD_OPERATION_STATUSES as readonly string[]).includes(value);
}

/**
 * Validates a `BuildOperation` (P20) -- including the self-contained
 * lifecycle invariant that keeps `output`/`error`/timestamps from ever
 * contradicting `status`, the same "the validator is authoritative"
 * discipline `assertClarification` already applies to its own lifecycle:
 *   - `"pending"`  -> output/error/startedAt/completedAt all null.
 *   - `"succeeded"` -> startedAt/completedAt set, error null (output may
 *      legitimately be any JSON-safe value, including null).
 *   - `"failed"`   -> startedAt/completedAt set, error set, output null.
 *   - `"skipped"`  -> never attempted -- output/error/startedAt/completedAt
 *      all null, exactly like `"pending"` (the only difference is WHY it
 *      never ran, which `build-executor.ts` records elsewhere).
 */
export function assertBuildOperation(value: unknown): asserts value is BuildOperation {
  invariant(isPlainObject(value), "build operation must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "buildOperation.id is required");
  invariant(typeof value.expectedOutputId === "string" && value.expectedOutputId.length > 0, "buildOperation.expectedOutputId is required");
  invariant(typeof value.toolName === "string" && value.toolName.trim().length > 0, "buildOperation.toolName is required");
  invariant(isJsonSafeValue(value.input), "buildOperation.input must be JSON-serializable");
  invariant(isBuildOperationStatus(value.status), "invalid buildOperation.status");
  invariant(isJsonSafeValue(value.output), "buildOperation.output must be JSON-serializable");

  if (value.status === "succeeded") {
    invariant(value.error === null, "a succeeded buildOperation must not carry an error");
    invariant(typeof value.startedAt === "string" && isIsoTimestamp(value.startedAt), "a succeeded buildOperation must carry a valid startedAt");
    invariant(typeof value.completedAt === "string" && isIsoTimestamp(value.completedAt), "a succeeded buildOperation must carry a valid completedAt");
  } else if (value.status === "failed") {
    invariant(value.output === null, "a failed buildOperation must not carry an output");
    invariant(isPlainObject(value.error), "a failed buildOperation must carry an error");
    invariant(typeof value.error.kind === "string" && value.error.kind.length > 0, "buildOperation.error.kind is required");
    invariant(typeof value.error.message === "string" && value.error.message.length > 0, "buildOperation.error.message is required");
    invariant(typeof value.startedAt === "string" && isIsoTimestamp(value.startedAt), "a failed buildOperation must carry a valid startedAt");
    invariant(typeof value.completedAt === "string" && isIsoTimestamp(value.completedAt), "a failed buildOperation must carry a valid completedAt");
  } else {
    invariant(value.output === null, "a pending/skipped buildOperation must not carry an output");
    invariant(value.error === null, "a pending/skipped buildOperation must not carry an error");
    invariant(value.startedAt === null, "a pending/skipped buildOperation must not carry a startedAt");
    invariant(value.completedAt === null, "a pending/skipped buildOperation must not carry a completedAt");
  }
}

function isBuildStatus(value: unknown): value is (typeof BUILD_STATUSES)[number] {
  return typeof value === "string" && (BUILD_STATUSES as readonly string[]).includes(value);
}

/** Validates a `BuildResult` (P20) -- including the invariant Step 14 of
 * the brief exists to enforce: `buildSuccess` can never disagree with
 * `status` (never a build that says `status: "failed"` but `buildSuccess:
 * true`, or vice versa) -- checked here, not merely hoped for from the
 * caller's good behavior. */
export function assertBuildResult(value: unknown): asserts value is BuildResult {
  invariant(isPlainObject(value), "build result must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "buildResult.id is required");
  invariant(typeof value.projectId === "string" && value.projectId.length > 0, "buildResult.projectId is required");
  invariant(
    typeof value.projectVersion === "number" && Number.isInteger(value.projectVersion) && value.projectVersion >= 1,
    "buildResult.projectVersion must be a positive integer"
  );
  invariant(typeof value.designSpecificationId === "string" && value.designSpecificationId.length > 0, "buildResult.designSpecificationId is required");
  invariant(isBuildStatus(value.status), "invalid buildResult.status");
  invariant(typeof value.buildSuccess === "boolean", "buildResult.buildSuccess must be a boolean");
  invariant(value.buildSuccess === (value.status === "completed"), "buildResult.buildSuccess must be true if and only if status is \"completed\"");
  invariant(Array.isArray(value.operations), "buildResult.operations must be an array");
  for (const operation of value.operations) assertBuildOperation(operation);
  invariant(isIsoTimestamp(value.startedAt), "buildResult.startedAt must be an ISO timestamp");
  invariant(
    value.completedAt === null || (typeof value.completedAt === "string" && isIsoTimestamp(value.completedAt)),
    "buildResult.completedAt must be an ISO timestamp or null"
  );
  invariant(isEntitySource(value.source), "invalid buildResult.source");
  invariant(isPlainObject(value.metadata) && isJsonSafeValue(value.metadata), "buildResult.metadata must be a JSON-serializable object");
}

function isObjectiveDirection(value: unknown): value is (typeof OBJECTIVE_DIRECTIONS)[number] {
  return typeof value === "string" && (OBJECTIVE_DIRECTIONS as readonly string[]).includes(value);
}

function isMetricValueStatus(value: unknown): value is (typeof METRIC_VALUE_STATUSES)[number] {
  return typeof value === "string" && (METRIC_VALUE_STATUSES as readonly string[]).includes(value);
}

function isMetricValueProvenanceKind(value: unknown): value is (typeof METRIC_VALUE_PROVENANCE_KINDS)[number] {
  return typeof value === "string" && (METRIC_VALUE_PROVENANCE_KINDS as readonly string[]).includes(value);
}

function isNormalizationMethod(value: unknown): value is (typeof NORMALIZATION_METHODS)[number] {
  return typeof value === "string" && (NORMALIZATION_METHODS as readonly string[]).includes(value);
}

function isCandidateFeasibility(value: unknown): value is (typeof CANDIDATE_FEASIBILITIES)[number] {
  return typeof value === "string" && (CANDIDATE_FEASIBILITIES as readonly string[]).includes(value);
}

function isDataCompleteness(value: unknown): value is (typeof DATA_COMPLETENESS_VALUES)[number] {
  return typeof value === "string" && (DATA_COMPLETENESS_VALUES as readonly string[]).includes(value);
}

function isConstraintOutcomeReasonKind(value: unknown): value is (typeof CONSTRAINT_OUTCOME_REASON_KINDS)[number] {
  return typeof value === "string" && (CONSTRAINT_OUTCOME_REASON_KINDS as readonly string[]).includes(value);
}

export function assertOptimizationObjective(value: unknown): asserts value is OptimizationObjective {
  invariant(isPlainObject(value), "optimizationObjective must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "optimizationObjective.id is required");
  invariant(typeof value.metricKey === "string" && value.metricKey.trim().length > 0, "optimizationObjective.metricKey is required");
  invariant(typeof value.description === "string" && value.description.trim().length > 0, "optimizationObjective.description is required");
  invariant(isObjectiveDirection(value.direction), "invalid optimizationObjective.direction");
  invariant(value.unit === null || typeof value.unit === "string", "optimizationObjective.unit must be a string or null");
  invariant(
    value.requirementId === null || (typeof value.requirementId === "string" && value.requirementId.length > 0),
    "optimizationObjective.requirementId must be a non-empty string or null"
  );
  invariant(
    value.weight === null || (typeof value.weight === "number" && Number.isFinite(value.weight) && value.weight >= 0),
    "optimizationObjective.weight must be a non-negative finite number or null"
  );
  invariant(isPlainObject(value.metadata) && isJsonSafeValue(value.metadata), "optimizationObjective.metadata must be a JSON-serializable object");
}

export function assertOptimizationConstraint(value: unknown): asserts value is OptimizationConstraint {
  invariant(isPlainObject(value), "optimizationConstraint must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "optimizationConstraint.id is required");
  invariant(typeof value.metricKey === "string" && value.metricKey.trim().length > 0, "optimizationConstraint.metricKey is required");
  invariant(typeof value.description === "string" && value.description.trim().length > 0, "optimizationConstraint.description is required");
  invariant(isNumericComparisonOperator(value.operator), "invalid optimizationConstraint.operator");
  invariant(typeof value.threshold === "number" && Number.isFinite(value.threshold), "optimizationConstraint.threshold must be a finite number");
  invariant(value.unit === null || typeof value.unit === "string", "optimizationConstraint.unit must be a string or null");
  invariant(
    value.constraintId === null || (typeof value.constraintId === "string" && value.constraintId.length > 0),
    "optimizationConstraint.constraintId must be a non-empty string or null"
  );
  invariant(isPlainObject(value.metadata) && isJsonSafeValue(value.metadata), "optimizationConstraint.metadata must be a JSON-serializable object");
}

/**
 * Enforces the status/provenanceKind consistency rule `CandidateMetricValue`'s
 * own doc comment documents -- "measured" can only ever be backed by a real
 * verification result, "estimated" only ever by a declared/research figure,
 * "unavailable" only ever carries a null value. This is what keeps a
 * model-generated number from masquerading as a measured engineering result
 * a structural, unconditional fact of the TYPE, not a convention a caller
 * has to remember.
 */
export function assertCandidateMetricValue(value: unknown): asserts value is CandidateMetricValue {
  invariant(isPlainObject(value), "candidateMetricValue must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "candidateMetricValue.id is required");
  invariant(typeof value.candidateId === "string" && value.candidateId.length > 0, "candidateMetricValue.candidateId is required");
  invariant(typeof value.metricKey === "string" && value.metricKey.trim().length > 0, "candidateMetricValue.metricKey is required");
  invariant(isMetricValueStatus(value.status), "invalid candidateMetricValue.status");
  invariant(
    value.value === null || (typeof value.value === "number" && Number.isFinite(value.value)),
    "candidateMetricValue.value must be a finite number or null"
  );
  invariant(value.unit === null || typeof value.unit === "string", "candidateMetricValue.unit must be a string or null");
  invariant(isMetricValueProvenanceKind(value.provenanceKind), "invalid candidateMetricValue.provenanceKind");
  invariant(
    value.verificationResultId === null || (typeof value.verificationResultId === "string" && value.verificationResultId.length > 0),
    "candidateMetricValue.verificationResultId must be a non-empty string or null"
  );
  invariant(
    value.researchEvidenceId === null || (typeof value.researchEvidenceId === "string" && value.researchEvidenceId.length > 0),
    "candidateMetricValue.researchEvidenceId must be a non-empty string or null"
  );
  invariant(
    value.experimentId === null || (typeof value.experimentId === "string" && value.experimentId.length > 0),
    "candidateMetricValue.experimentId must be a non-empty string or null"
  );
  invariant(isEntitySource(value.source), "invalid candidateMetricValue.source");
  invariant(isIsoTimestamp(value.measuredAt), "candidateMetricValue.measuredAt must be an ISO timestamp");
  invariant(isPlainObject(value.metadata) && isJsonSafeValue(value.metadata), "candidateMetricValue.metadata must be a JSON-serializable object");

  // status <-> provenanceKind <-> value consistency (see this function's own doc comment).
  if (value.status === "measured") {
    invariant(value.provenanceKind === "verification_result", 'candidateMetricValue.status "measured" requires provenanceKind "verification_result"');
    invariant(value.verificationResultId !== null, 'candidateMetricValue.status "measured" requires a non-null verificationResultId');
    invariant(value.value !== null, 'candidateMetricValue.status "measured" requires a non-null value');
  } else if (value.status === "estimated") {
    invariant(
      value.provenanceKind === "declared" || value.provenanceKind === "research_evidence",
      'candidateMetricValue.status "estimated" requires provenanceKind "declared" or "research_evidence"'
    );
    invariant(value.value !== null, 'candidateMetricValue.status "estimated" requires a non-null value');
  } else {
    invariant(value.value === null, 'candidateMetricValue.status "unavailable" requires a null value');
  }
  if (value.provenanceKind === "verification_result") {
    invariant(value.verificationResultId !== null, 'candidateMetricValue.provenanceKind "verification_result" requires a non-null verificationResultId');
  }
  if (value.provenanceKind === "research_evidence") {
    invariant(value.researchEvidenceId !== null, 'candidateMetricValue.provenanceKind "research_evidence" requires a non-null researchEvidenceId');
  }
  if (value.provenanceKind === "declared") {
    invariant(value.verificationResultId === null, 'candidateMetricValue.provenanceKind "declared" must not carry a verificationResultId');
    invariant(value.researchEvidenceId === null, 'candidateMetricValue.provenanceKind "declared" must not carry a researchEvidenceId');
  }
}

export function assertOptimizationProblem(value: unknown): asserts value is OptimizationProblem {
  invariant(isPlainObject(value), "optimizationProblem must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "optimizationProblem.id is required");
  invariant(typeof value.projectId === "string" && value.projectId.length > 0, "optimizationProblem.projectId is required");
  invariant(
    typeof value.projectVersion === "number" && Number.isInteger(value.projectVersion) && value.projectVersion >= 1,
    "optimizationProblem.projectVersion must be a positive integer"
  );
  invariant(
    value.planId === null || (typeof value.planId === "string" && value.planId.length > 0),
    "optimizationProblem.planId must be a non-empty string or null"
  );
  invariant(
    value.planStepId === null || (typeof value.planStepId === "string" && value.planStepId.length > 0),
    "optimizationProblem.planStepId must be a non-empty string or null"
  );
  invariant(isStringArray(value.candidateIds) && value.candidateIds.length > 0, "optimizationProblem.candidateIds must be a non-empty array of strings");
  invariant(Array.isArray(value.objectives) && value.objectives.length > 0, "optimizationProblem.objectives must be a non-empty array");
  for (const objective of value.objectives) assertOptimizationObjective(objective);
  invariant(Array.isArray(value.constraints), "optimizationProblem.constraints must be an array");
  for (const constraint of value.constraints) assertOptimizationConstraint(constraint);
  invariant(isNormalizationMethod(value.normalizationMethod), "invalid optimizationProblem.normalizationMethod");
  invariant(isEntitySource(value.source), "invalid optimizationProblem.source");
  invariant(isIsoTimestamp(value.createdAt), "optimizationProblem.createdAt must be an ISO timestamp");
  invariant(isPlainObject(value.metadata) && isJsonSafeValue(value.metadata), "optimizationProblem.metadata must be a JSON-serializable object");
}

function assertCandidateMetricSnapshot(value: unknown): asserts value is CandidateMetricSnapshot {
  invariant(isPlainObject(value), "candidateMetricSnapshot must be an object");
  invariant(typeof value.metricKey === "string" && value.metricKey.trim().length > 0, "candidateMetricSnapshot.metricKey is required");
  invariant(isMetricValueStatus(value.status), "invalid candidateMetricSnapshot.status");
  invariant(
    value.value === null || (typeof value.value === "number" && Number.isFinite(value.value)),
    "candidateMetricSnapshot.value must be a finite number or null"
  );
  invariant(value.unit === null || typeof value.unit === "string", "candidateMetricSnapshot.unit must be a string or null");
  invariant(
    value.provenanceKind === null || isMetricValueProvenanceKind(value.provenanceKind),
    "invalid candidateMetricSnapshot.provenanceKind"
  );
  invariant(
    value.metricValueId === null || (typeof value.metricValueId === "string" && value.metricValueId.length > 0),
    "candidateMetricSnapshot.metricValueId must be a non-empty string or null"
  );
}

function assertConstraintEvaluationOutcome(value: unknown): asserts value is ConstraintEvaluationOutcome {
  invariant(isPlainObject(value), "constraintEvaluationOutcome must be an object");
  invariant(
    typeof value.optimizationConstraintId === "string" && value.optimizationConstraintId.length > 0,
    "constraintEvaluationOutcome.optimizationConstraintId is required"
  );
  invariant(typeof value.metricKey === "string" && value.metricKey.trim().length > 0, "constraintEvaluationOutcome.metricKey is required");
  invariant(isNumericComparisonOperator(value.operator), "invalid constraintEvaluationOutcome.operator");
  invariant(typeof value.threshold === "number" && Number.isFinite(value.threshold), "constraintEvaluationOutcome.threshold must be a finite number");
  invariant(value.unit === null || typeof value.unit === "string", "constraintEvaluationOutcome.unit must be a string or null");
  invariant(
    value.actualValue === null || (typeof value.actualValue === "number" && Number.isFinite(value.actualValue)),
    "constraintEvaluationOutcome.actualValue must be a finite number or null"
  );
  invariant(value.satisfied === null || typeof value.satisfied === "boolean", "constraintEvaluationOutcome.satisfied must be a boolean or null");
  invariant(isConstraintOutcomeReasonKind(value.reasonKind), "invalid constraintEvaluationOutcome.reasonKind");
}

function assertObjectiveComparisonEntry(value: unknown): asserts value is ObjectiveComparisonEntry {
  invariant(isPlainObject(value), "objectiveComparisonEntry must be an object");
  invariant(typeof value.metricKey === "string" && value.metricKey.trim().length > 0, "objectiveComparisonEntry.metricKey is required");
  invariant(isObjectiveDirection(value.direction), "invalid objectiveComparisonEntry.direction");
  invariant(
    typeof value.dominatorValue === "number" && Number.isFinite(value.dominatorValue),
    "objectiveComparisonEntry.dominatorValue must be a finite number"
  );
  invariant(
    typeof value.dominatedValue === "number" && Number.isFinite(value.dominatedValue),
    "objectiveComparisonEntry.dominatedValue must be a finite number"
  );
  invariant(typeof value.dominatorAtLeastAsGood === "boolean", "objectiveComparisonEntry.dominatorAtLeastAsGood must be a boolean");
  invariant(typeof value.dominatorStrictlyBetter === "boolean", "objectiveComparisonEntry.dominatorStrictlyBetter must be a boolean");
}

function assertDominanceRelation(value: unknown): asserts value is DominanceRelation {
  invariant(isPlainObject(value), "dominanceRelation must be an object");
  invariant(
    typeof value.dominatorCandidateId === "string" && value.dominatorCandidateId.length > 0,
    "dominanceRelation.dominatorCandidateId is required"
  );
  invariant(
    typeof value.dominatedCandidateId === "string" && value.dominatedCandidateId.length > 0,
    "dominanceRelation.dominatedCandidateId is required"
  );
  invariant(Array.isArray(value.comparisons) && value.comparisons.length > 0, "dominanceRelation.comparisons must be a non-empty array");
  for (const comparison of value.comparisons) assertObjectiveComparisonEntry(comparison);
  invariant(
    value.comparisons.some((comparison: ObjectiveComparisonEntry) => comparison.dominatorStrictlyBetter),
    "dominanceRelation must have at least one comparison where the dominator is strictly better"
  );
  invariant(
    value.comparisons.every((comparison: ObjectiveComparisonEntry) => comparison.dominatorAtLeastAsGood),
    "dominanceRelation must have the dominator at least as good on every comparison"
  );
}

function assertCandidateEvaluation(value: unknown): asserts value is CandidateEvaluation {
  invariant(isPlainObject(value), "candidateEvaluation must be an object");
  invariant(typeof value.candidateId === "string" && value.candidateId.length > 0, "candidateEvaluation.candidateId is required");
  invariant(isCandidateFeasibility(value.feasibility), "invalid candidateEvaluation.feasibility");
  invariant(isDataCompleteness(value.dataCompleteness), "invalid candidateEvaluation.dataCompleteness");
  invariant(Array.isArray(value.metrics), "candidateEvaluation.metrics must be an array");
  for (const metric of value.metrics) assertCandidateMetricSnapshot(metric);
  invariant(Array.isArray(value.constraintResults), "candidateEvaluation.constraintResults must be an array");
  for (const constraintResult of value.constraintResults) assertConstraintEvaluationOutcome(constraintResult);
  invariant(typeof value.paretoEligible === "boolean", "candidateEvaluation.paretoEligible must be a boolean");
  invariant(
    value.weightedScore === null || (typeof value.weightedScore === "number" && Number.isFinite(value.weightedScore)),
    "candidateEvaluation.weightedScore must be a finite number or null"
  );
}

export function assertOptimizationResult(value: unknown): asserts value is OptimizationResult {
  invariant(isPlainObject(value), "optimizationResult must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "optimizationResult.id is required");
  invariant(typeof value.problemId === "string" && value.problemId.length > 0, "optimizationResult.problemId is required");
  invariant(typeof value.projectId === "string" && value.projectId.length > 0, "optimizationResult.projectId is required");
  invariant(
    typeof value.projectVersion === "number" && Number.isInteger(value.projectVersion) && value.projectVersion >= 1,
    "optimizationResult.projectVersion must be a positive integer"
  );
  invariant(Array.isArray(value.candidateEvaluations), "optimizationResult.candidateEvaluations must be an array");
  for (const evaluation of value.candidateEvaluations) assertCandidateEvaluation(evaluation);
  invariant(isStringArray(value.paretoOptimalCandidateIds), "optimizationResult.paretoOptimalCandidateIds must be an array of strings");
  invariant(isStringArray(value.dominatedCandidateIds), "optimizationResult.dominatedCandidateIds must be an array of strings");
  invariant(isStringArray(value.infeasibleCandidateIds), "optimizationResult.infeasibleCandidateIds must be an array of strings");
  invariant(isStringArray(value.unknownFeasibilityCandidateIds), "optimizationResult.unknownFeasibilityCandidateIds must be an array of strings");
  invariant(isStringArray(value.incompleteDataCandidateIds), "optimizationResult.incompleteDataCandidateIds must be an array of strings");
  invariant(Array.isArray(value.dominance), "optimizationResult.dominance must be an array");
  for (const relation of value.dominance) assertDominanceRelation(relation);
  invariant(typeof value.algorithm === "string" && value.algorithm.trim().length > 0, "optimizationResult.algorithm is required");
  invariant(isIsoTimestamp(value.computedAt), "optimizationResult.computedAt must be an ISO timestamp");
  invariant(isEntitySource(value.source), "invalid optimizationResult.source");
  invariant(isPlainObject(value.metadata) && isJsonSafeValue(value.metadata), "optimizationResult.metadata must be a JSON-serializable object");
}

/**
 * Wraps an assert* function as a non-throwing type guard. Useful anywhere a
 * boolean gate is more natural than a try/catch — e.g. a future boundary
 * that checks agent- or LLM-authored data before it's allowed anywhere near
 * `updateWorldModel` (see NAQSH briefing §11: verification must be able to
 * reject the agent's assumptions, which starts with rejecting malformed
 * output outright).
 */
export function isValid<T>(assertFn: (value: unknown) => asserts value is T, value: unknown): value is T {
  try {
    assertFn(value);
    return true;
  } catch (error) {
    if (error instanceof WorldModelValidationError) {
      return false;
    }
    throw error;
  }
}
