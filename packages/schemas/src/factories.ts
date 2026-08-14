import { createId, toIsoTimestamp } from "./ids.js";
import type {
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
  WorldModelState
} from "./types.js";
import {
  assertConstraint,
  assertDecision,
  assertEngineeringObject,
  assertExperiment,
  assertObjective,
  assertPreference,
  assertProject,
  assertRequirement,
  assertSessionState,
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
