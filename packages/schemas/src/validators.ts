import { isIsoTimestamp } from "./ids.js";
import {
  ENTITY_SOURCES,
  type Constraint,
  type Decision,
  type EngineeringObject,
  type Experiment,
  type Objective,
  type Preference,
  type Project,
  type Requirement,
  type SessionState,
  type WorldModelState
} from "./types.js";

/** Thrown by every assert* function below. A dedicated class lets callers
 * (e.g. a future P16 verification layer, or a P7 gate on agent-authored
 * state) distinguish "this violates the World Model contract" from any
 * other kind of failure without string-matching a message. */
export class WorldModelValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorldModelValidationError";
  }
}

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
