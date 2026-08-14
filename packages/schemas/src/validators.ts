import { isIsoTimestamp } from "./ids.js";
import { assertValidToolValueSchema } from "./tool-schema.js";
import {
  APPROVAL_STATUSES,
  AUTHORIZATION_DENIAL_REASONS,
  AUTONOMY_GRANT_STATUSES,
  CHANGE_CAUSE_KINDS,
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
  type Experiment,
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
export { AuthorizationError, ToolError, WorldModelValidationError } from "./errors.js";

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new WorldModelValidationError(message);
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
  invariant(isPlainObject(value.metadata), "objective.metadata must be an object");
}

export function assertRequirement(value: unknown): asserts value is Requirement {
  invariant(isPlainObject(value), "requirement must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "requirement.id is required");
  invariant(typeof value.description === "string", "requirement.description must be a string");
  invariant(
    typeof value.category === "string" && value.category.length > 0,
    "requirement.category is required"
  );
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
  invariant(isPlainObject(value.metadata), "requirement.metadata must be an object");
}

export function assertConstraint(value: unknown): asserts value is Constraint {
  invariant(isPlainObject(value), "constraint must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "constraint.id is required");
  invariant(typeof value.description === "string", "constraint.description must be a string");
  invariant(
    typeof value.category === "string" && value.category.length > 0,
    "constraint.category is required"
  );
  invariant(value.severity === "hard" || value.severity === "soft", "invalid constraint severity");
  invariant(
    value.status === "active" ||
      value.status === "satisfied" ||
      value.status === "violated" ||
      value.status === "superseded",
    "invalid constraint status"
  );
  invariant(isEntitySource(value.source), "invalid constraint source");
  invariant(isPlainObject(value.metadata), "constraint.metadata must be an object");
}

export function assertEngineeringObject(value: unknown): asserts value is EngineeringObject {
  invariant(isPlainObject(value), "engineering object must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "object.id is required");
  invariant(typeof value.type === "string" && value.type.length > 0, "object.type is required");
  invariant(typeof value.name === "string", "object.name must be a string");
  invariant(isPlainObject(value.properties), "object.properties must be an object");
  invariant(Array.isArray(value.relationships), "object.relationships must be an array");
  invariant(isPlainObject(value.metadata), "object.metadata must be an object");
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
  invariant(isPlainObject(value.metadata), "decision.metadata must be an object");
}

export function assertExperiment(value: unknown): asserts value is Experiment {
  invariant(isPlainObject(value), "experiment must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "experiment.id is required");
  invariant(
    typeof value.objective === "string" && value.objective.trim().length > 0,
    "experiment.objective is required"
  );
  invariant(typeof value.hypothesis === "string", "experiment.hypothesis must be a string");
  invariant(Array.isArray(value.inputs), "experiment.inputs must be an array");
  invariant(
    value.status === "planned" ||
      value.status === "running" ||
      value.status === "complete" ||
      value.status === "failed" ||
      value.status === "cancelled",
    "invalid experiment status"
  );
  invariant(isEntitySource(value.source), "invalid experiment source");
  invariant(isIsoTimestamp(value.createdAt), "experiment.createdAt must be an ISO timestamp");
  invariant(isIsoTimestamp(value.updatedAt), "experiment.updatedAt must be an ISO timestamp");
  invariant(isPlainObject(value.metadata), "experiment.metadata must be an object");
}

export function assertPreference(value: unknown): asserts value is Preference {
  invariant(isPlainObject(value), "preference must be an object");
  invariant(typeof value.id === "string" && value.id.length > 0, "preference.id is required");
  invariant(typeof value.description === "string", "preference.description must be a string");
  invariant(
    typeof value.category === "string" && value.category.length > 0,
    "preference.category is required"
  );
  invariant(isEntitySource(value.source), "invalid preference source");
  invariant(value.status === "active" || value.status === "inactive", "invalid preference status");
  invariant(isPlainObject(value.metadata), "preference.metadata must be an object");
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
  invariant(
    typeof value.version === "number" && Number.isInteger(value.version) && value.version >= 1,
    "project.version must be a positive integer"
  );
  invariant(isIsoTimestamp(value.createdAt), "project.createdAt must be an ISO timestamp");
  invariant(isIsoTimestamp(value.updatedAt), "project.updatedAt must be an ISO timestamp");
  invariant(isPlainObject(value.metadata), "project.metadata must be an object");
  for (const requirement of value.requirements) assertRequirement(requirement);
  for (const constraint of value.constraints) assertConstraint(constraint);
  for (const object of value.objects) assertEngineeringObject(object);
  for (const decision of value.decisions) assertDecision(decision);
  for (const experiment of value.experiments) assertExperiment(experiment);
  for (const preference of value.preferences) assertPreference(preference);
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
  invariant(isPlainObject(value.metadata), "session.metadata must be an object");
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
