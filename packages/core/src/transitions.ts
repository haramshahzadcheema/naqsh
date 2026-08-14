import {
  assertProject,
  assertWorldModelState,
  createConstraint,
  createDecision,
  createEngineeringObject,
  createExperiment,
  createObjective,
  createPreference,
  createRequirement,
  createSessionState,
  toIsoTimestamp,
  WorldModelValidationError,
  type ConstraintInput,
  type DecisionInput,
  type EngineeringObjectInput,
  type ExperimentInput,
  type ObjectiveInput,
  type PreferenceInput,
  type Project,
  type RequirementInput,
  type SessionState,
  type SessionStateInput,
  type WorldModelState
} from "@naqsh/schemas";

/**
 * Every way the World Model's CURRENT STATE (@naqsh/schemas WorldModelState)
 * can change. This union — not conversation history, not a database row —
 * is the EVENT/HISTORY seam: `updateWorldModel` below is a pure reducer
 * `(state, transition) => state`, so a future Change Model (P2) can wrap it
 * to persist the transition stream (what changed, from what, why) without
 * touching this file. Do not read/write storage here — that's P2's job.
 *
 * Deliberately NOT included yet (would be premature for P1, added the same
 * way as everything below once a real producer exists): observation,
 * proposed-action, executed-action, and verification-result transitions.
 */
interface BaseTransition<Kind extends string> {
  kind: Kind;
}

export interface SetProjectMetadataTransition extends BaseTransition<"set_project_metadata"> {
  metadata: Record<string, unknown>;
}

export interface SetObjectiveTransition extends BaseTransition<"set_objective"> {
  objective: ObjectiveInput;
}

export interface AddRequirementTransition extends BaseTransition<"add_requirement"> {
  requirement: RequirementInput;
}

export interface UpdateRequirementTransition extends BaseTransition<"update_requirement"> {
  requirementId: string;
  patch: RequirementInput;
}

export interface RemoveRequirementTransition extends BaseTransition<"remove_requirement"> {
  requirementId: string;
}

export interface AddConstraintTransition extends BaseTransition<"add_constraint"> {
  constraint: ConstraintInput;
}

export interface AddObjectTransition extends BaseTransition<"add_object"> {
  object: EngineeringObjectInput;
}

export interface AddDecisionTransition extends BaseTransition<"add_decision"> {
  decision: DecisionInput;
}

export interface AddExperimentTransition extends BaseTransition<"add_experiment"> {
  experiment: ExperimentInput;
}

export interface AddPreferenceTransition extends BaseTransition<"add_preference"> {
  preference: PreferenceInput;
}

export type ProjectTransition =
  | SetProjectMetadataTransition
  | SetObjectiveTransition
  | AddRequirementTransition
  | UpdateRequirementTransition
  | RemoveRequirementTransition
  | AddConstraintTransition
  | AddObjectTransition
  | AddDecisionTransition
  | AddExperimentTransition
  | AddPreferenceTransition;

export interface ReplaceSessionTransition extends BaseTransition<"replace_session"> {
  session: SessionStateInput;
}

export interface FocusObjectsTransition extends BaseTransition<"focus_objects"> {
  focusObjectIds: string[];
}

export interface ObserveTransition extends BaseTransition<"observe"> {}

export type SessionTransition = ReplaceSessionTransition | FocusObjectsTransition | ObserveTransition;

export type WorldModelTransition = ProjectTransition | SessionTransition;
export type TransitionKind = WorldModelTransition["kind"];

interface ProjectTransitionEntry<T extends ProjectTransition> {
  target: "project";
  /** Whether applying this transition changes state (vs. read-only focus
   * tracking). P4 (Permissions) will gate on this without redesigning the
   * registry — no enforcement logic exists here, only the classification. */
  mutates: boolean;
  apply(project: Project, transition: T): Project;
}

interface SessionTransitionEntry<T extends SessionTransition> {
  target: "session";
  mutates: boolean;
  apply(session: SessionState, transition: T): SessionState;
}

type EntryFor<T extends WorldModelTransition> = T extends ProjectTransition
  ? ProjectTransitionEntry<T>
  : T extends SessionTransition
    ? SessionTransitionEntry<T>
    : never;

/**
 * Keying by every member of `TransitionKind` means adding a new transition
 * kind to the union above without adding a matching entry here is a
 * COMPILE ERROR, not a runtime surprise discovered in Phase 12. This is the
 * concrete mechanism that keeps the reducer honest as it grows through the
 * remaining 24 phases.
 */
type TransitionRegistry = {
  [K in TransitionKind]: EntryFor<Extract<WorldModelTransition, { kind: K }>>;
};

const registry: TransitionRegistry = {
  set_project_metadata: {
    target: "project",
    mutates: true,
    apply: (project, transition) => ({
      ...project,
      metadata: { ...project.metadata, ...transition.metadata }
    })
  },
  set_objective: {
    target: "project",
    mutates: true,
    apply: (project, transition) => ({
      ...project,
      objective: createObjective(transition.objective)
    })
  },
  add_requirement: {
    target: "project",
    mutates: true,
    apply: (project, transition) => ({
      ...project,
      requirements: [...project.requirements, createRequirement(transition.requirement)]
    })
  },
  update_requirement: {
    target: "project",
    mutates: true,
    apply: (project, transition) => ({
      ...project,
      requirements: project.requirements.map((requirement) =>
        requirement.id === transition.requirementId
          ? createRequirement({ ...requirement, ...transition.patch, id: requirement.id })
          : requirement
      )
    })
  },
  remove_requirement: {
    target: "project",
    mutates: true,
    apply: (project, transition) => ({
      ...project,
      requirements: project.requirements.filter(
        (requirement) => requirement.id !== transition.requirementId
      )
    })
  },
  add_constraint: {
    target: "project",
    mutates: true,
    apply: (project, transition) => ({
      ...project,
      constraints: [...project.constraints, createConstraint(transition.constraint)]
    })
  },
  add_object: {
    target: "project",
    mutates: true,
    apply: (project, transition) => ({
      ...project,
      objects: [...project.objects, createEngineeringObject(transition.object)]
    })
  },
  add_decision: {
    target: "project",
    mutates: true,
    apply: (project, transition) => ({
      ...project,
      decisions: [...project.decisions, createDecision(transition.decision)]
    })
  },
  add_experiment: {
    target: "project",
    mutates: true,
    apply: (project, transition) => ({
      ...project,
      experiments: [...project.experiments, createExperiment(transition.experiment)]
    })
  },
  add_preference: {
    target: "project",
    mutates: true,
    apply: (project, transition) => ({
      ...project,
      preferences: [...project.preferences, createPreference(transition.preference)]
    })
  },
  replace_session: {
    target: "session",
    mutates: true,
    apply: (_session, transition) => createSessionState(transition.session)
  },
  focus_objects: {
    target: "session",
    mutates: true,
    apply: (session, transition) =>
      createSessionState({
        ...session,
        focusObjectIds: transition.focusObjectIds,
        lastObservedAt: toIsoTimestamp()
      })
  },
  observe: {
    target: "session",
    mutates: false,
    apply: (session) => createSessionState({ ...session, lastObservedAt: toIsoTimestamp() })
  }
};

/** Read-only lookup for future phases (e.g. P4 permissions, P8 observation
 * planning) that need to know a transition's shape/classification without
 * applying it. */
export function getTransitionEntry(kind: TransitionKind): TransitionRegistry[TransitionKind] {
  return registry[kind];
}

export function listTransitionKinds(): TransitionKind[] {
  return Object.keys(registry) as TransitionKind[];
}

/**
 * The single write path for World Model state. Pure function: same
 * (state, transition) in, same state out, no I/O. Throws
 * WorldModelValidationError for an unrecognized kind or invalid resulting
 * state — it never silently accepts malformed input, which is what makes it
 * safe to eventually sit downstream of agent-authored transitions (§11).
 */
export function updateWorldModel(state: WorldModelState, transition: WorldModelTransition): WorldModelState {
  assertWorldModelState(state);

  if (typeof transition !== "object" || transition === null || typeof transition.kind !== "string") {
    throw new WorldModelValidationError("transition.kind is required");
  }

  const entry = registry[transition.kind as TransitionKind] as
    | ProjectTransitionEntry<ProjectTransition>
    | SessionTransitionEntry<SessionTransition>
    | undefined;

  if (!entry) {
    throw new WorldModelValidationError(`Unsupported transition kind: ${transition.kind}`);
  }

  if (entry.target === "project") {
    // A single, contained cast: the registry guarantees `entry.apply` was
    // written against the transition shape matching this `kind` (checked
    // when `registry` was built above), but TS cannot re-derive that link
    // through a runtime keyed lookup without a manual switch per kind.
    const patchedProject = entry.apply(state.project, transition as ProjectTransition);
    const nextProject: Project = {
      ...patchedProject,
      version: state.project.version + 1,
      updatedAt: toIsoTimestamp()
    };
    assertProject(nextProject);
    return { project: nextProject, session: state.session };
  }

  const nextSession = entry.apply(state.session, transition as SessionTransition);
  const nextState: WorldModelState = { project: state.project, session: nextSession };
  assertWorldModelState(nextState);
  return nextState;
}
