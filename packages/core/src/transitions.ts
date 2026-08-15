import {
  assertProject,
  assertWorldModelState,
  createConstraint,
  createDecision,
  createEngineeringObject,
  createEntityRelationship,
  createExperiment,
  createObjective,
  createPreference,
  createRequirement,
  createSessionState,
  toIsoTimestamp,
  WorldModelValidationError,
  type Project,
  type ProjectTransition,
  type SessionState,
  type SessionTransition,
  type TransitionKind,
  type WorldModelState,
  type WorldModelTransition
} from "@naqsh/schemas";

// Re-exported because @naqsh/core's own public API (updateWorldModel,
// recordTransition, getTransitionEntry) is typed in terms of these — a
// consumer calling core's functions shouldn't have to also import from
// @naqsh/schemas just to name the type it's passing in. The definitions
// themselves stay in schemas; this is a proxy, not a second copy.
export type {
  ProjectTransition,
  SessionTransition,
  TransitionKind,
  WorldModelTransition
} from "@naqsh/schemas";

/** What `describeChange` reports back to `recordTransition`: which entity
 * was touched and its before/after state. Deliberately NOT the schemas
 * `ChangeTarget` type — that's the narrower {entityType, entityId} shape
 * stored on `Change.target`; `before`/`after` live as separate top-level
 * fields on `Change` itself (see record-transition.ts). */
interface ChangeDescription {
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
}

interface ProjectTransitionEntry<T extends ProjectTransition> {
  target: "project";
  /** Whether applying this transition changes state (vs. read-only focus
   * tracking). P4 (Permissions) will gate on this without redesigning the
   * registry — no enforcement logic exists here, only the classification. */
  mutates: boolean;
  apply(project: Project, transition: T): Project;
  /** Describes, for the Change Model (P2), exactly which entity this
   * transition touched and its before/after state. Required on every
   * entry — same exhaustiveness guarantee as `apply` — so a Change record
   * is never missing the specific information needed to explain what
   * happened, only a vague field-name list. */
  describeChange(before: Project, after: Project, transition: T): ChangeDescription;
  /**
   * Returns the transition that `Change.transition` should actually store:
   * one that, replayed through `updateWorldModel` from the same prior
   * state, deterministically reproduces the SAME `after` again.
   *
   * This exists because `apply()` may call a createX factory that mints a
   * new random id via `createId` when the caller's transition didn't pin
   * one (e.g. `add_requirement` with no `requirement.id`). Naively storing
   * the caller's ORIGINAL transition would make replay non-deterministic —
   * a second application would create a requirement with a DIFFERENT id,
   * breaking reconciliation (and later, P15 checkpoints / P25 background
   * replay, both of which depend on replay being exact). Most kinds never
   * generate a new id and just return `transition` unchanged.
   */
  resolveForReplay(transition: T, after: unknown): T;
}

interface SessionTransitionEntry<T extends SessionTransition> {
  target: "session";
  mutates: boolean;
  apply(session: SessionState, transition: T): SessionState;
  describeChange(before: SessionState, after: SessionState, transition: T): ChangeDescription;
  resolveForReplay(transition: T, after: unknown): T;
}

type EntryFor<T extends WorldModelTransition> = T extends ProjectTransition
  ? ProjectTransitionEntry<T>
  : T extends SessionTransition
    ? SessionTransitionEntry<T>
    : never;

/**
 * Keying by every member of `TransitionKind` means adding a new transition
 * kind to the union (in @naqsh/schemas) without adding a matching entry
 * here is a COMPILE ERROR, not a runtime surprise discovered in Phase 12.
 * This is the concrete mechanism that keeps the reducer honest as it grows
 * through the remaining phases.
 */
type TransitionRegistry = {
  [K in TransitionKind]: EntryFor<Extract<WorldModelTransition, { kind: K }>>;
};

/** Shared shape for the six "append a new entity" transitions — before is
 * always null, after is always the newly created entity, found as the last
 * element of its array (apply() always appends, never inserts). */
function describeAdd<E extends { id: string }>(
  entityType: string,
  getArray: (project: Project) => E[]
): (before: Project, after: Project) => ChangeDescription {
  return (_before, after) => {
    const array = getArray(after);
    const entity = array[array.length - 1];
    if (!entity) {
      throw new WorldModelValidationError("invalid_transition", `Expected a newly added ${entityType} in the resulting project`);
    }
    return { entityType, entityId: entity.id, before: null, after: entity };
  };
}

const registry: TransitionRegistry = {
  set_project_metadata: {
    target: "project",
    mutates: true,
    apply: (project, transition) => ({
      ...project,
      metadata: { ...project.metadata, ...transition.metadata }
    }),
    describeChange: (before, after) => ({
      entityType: "project",
      entityId: after.id,
      before: before.metadata,
      after: after.metadata
    }),
    resolveForReplay: (transition) => transition
  },
  set_objective: {
    target: "project",
    mutates: true,
    apply: (project, transition) => ({
      ...project,
      objective: createObjective(transition.objective)
    }),
    describeChange: (before, after) => ({
      entityType: "objective",
      entityId: after.id,
      before: before.objective,
      after: after.objective
    }),
    // createObjective never generates an id (Objective has none) — always
    // deterministic as-is.
    resolveForReplay: (transition) => transition
  },
  add_requirement: {
    target: "project",
    mutates: true,
    apply: (project, transition) => ({
      ...project,
      requirements: [...project.requirements, createRequirement(transition.requirement)]
    }),
    describeChange: describeAdd("requirement", (project) => project.requirements),
    // Pin the id createRequirement generated so replay reproduces it
    // instead of minting a new one. Single contained cast: `after` is
    // `unknown` here (it flows through ChangeDescription), but the
    // registry guarantees it is the Requirement `add_requirement` just
    // created.
    resolveForReplay: (transition, after) => ({ ...transition, requirement: after as never })
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
    }),
    describeChange: (before, after, transition) => ({
      entityType: "requirement",
      entityId: transition.requirementId,
      before: before.requirements.find((requirement) => requirement.id === transition.requirementId) ?? null,
      after: after.requirements.find((requirement) => requirement.id === transition.requirementId) ?? null
    }),
    // `requirementId` is explicit and `patch` never generates a new id —
    // always deterministic as-is.
    resolveForReplay: (transition) => transition
  },
  remove_requirement: {
    target: "project",
    mutates: true,
    apply: (project, transition) => ({
      ...project,
      requirements: project.requirements.filter(
        (requirement) => requirement.id !== transition.requirementId
      )
    }),
    describeChange: (before, _after, transition) => ({
      entityType: "requirement",
      entityId: transition.requirementId,
      before: before.requirements.find((requirement) => requirement.id === transition.requirementId) ?? null,
      after: null
    }),
    resolveForReplay: (transition) => transition
  },
  add_constraint: {
    target: "project",
    mutates: true,
    apply: (project, transition) => ({
      ...project,
      constraints: [...project.constraints, createConstraint(transition.constraint)]
    }),
    describeChange: describeAdd("constraint", (project) => project.constraints),
    resolveForReplay: (transition, after) => ({ ...transition, constraint: after as never })
  },
  add_object: {
    target: "project",
    mutates: true,
    apply: (project, transition) => ({
      ...project,
      objects: [...project.objects, createEngineeringObject(transition.object)]
    }),
    describeChange: describeAdd("engineering_object", (project) => project.objects),
    resolveForReplay: (transition, after) => ({ ...transition, object: after as never })
  },
  add_decision: {
    target: "project",
    mutates: true,
    apply: (project, transition) => ({
      ...project,
      decisions: [...project.decisions, createDecision(transition.decision)]
    }),
    describeChange: describeAdd("decision", (project) => project.decisions),
    resolveForReplay: (transition, after) => ({ ...transition, decision: after as never })
  },
  add_experiment: {
    target: "project",
    mutates: true,
    apply: (project, transition) => ({
      ...project,
      experiments: [...project.experiments, createExperiment(transition.experiment)]
    }),
    describeChange: describeAdd("experiment", (project) => project.experiments),
    resolveForReplay: (transition, after) => ({ ...transition, experiment: after as never })
  },
  add_preference: {
    target: "project",
    mutates: true,
    apply: (project, transition) => ({
      ...project,
      preferences: [...project.preferences, createPreference(transition.preference)]
    }),
    describeChange: describeAdd("preference", (project) => project.preferences),
    resolveForReplay: (transition, after) => ({ ...transition, preference: after as never })
  },
  add_relationship: {
    target: "project",
    mutates: true,
    apply: (project, transition) => ({
      ...project,
      relationships: [...project.relationships, createEntityRelationship(transition.relationship)]
    }),
    describeChange: describeAdd("relationship", (project) => project.relationships),
    resolveForReplay: (transition, after) => ({ ...transition, relationship: after as never })
  },
  remove_relationship: {
    target: "project",
    mutates: true,
    apply: (project, transition) => ({
      ...project,
      relationships: project.relationships.filter(
        (relationship) => relationship.id !== transition.relationshipId
      )
    }),
    describeChange: (before, _after, transition) => ({
      entityType: "relationship",
      entityId: transition.relationshipId,
      before: before.relationships.find((relationship) => relationship.id === transition.relationshipId) ?? null,
      after: null
    }),
    resolveForReplay: (transition) => transition
  },
  replace_session: {
    target: "session",
    mutates: true,
    apply: (_session, transition) => createSessionState(transition.session),
    describeChange: (before, after) => ({
      entityType: "session",
      entityId: after.id,
      before,
      after
    }),
    // Same id-generation risk as the add_* project transitions: pin the
    // resolved session (with its final id) for deterministic replay.
    resolveForReplay: (transition, after) => ({ ...transition, session: after as never })
  },
  focus_objects: {
    target: "session",
    mutates: true,
    apply: (session, transition) =>
      createSessionState({
        ...session,
        focusObjectIds: transition.focusObjectIds,
        lastObservedAt: toIsoTimestamp()
      }),
    describeChange: (before, after) => ({
      entityType: "session",
      entityId: after.id,
      before: { focusObjectIds: before.focusObjectIds },
      after: { focusObjectIds: after.focusObjectIds }
    }),
    resolveForReplay: (transition) => transition
  },
  observe: {
    target: "session",
    mutates: false,
    apply: (session) => createSessionState({ ...session, lastObservedAt: toIsoTimestamp() }),
    describeChange: (before, after) => ({
      entityType: "session",
      entityId: after.id,
      before: { lastObservedAt: before.lastObservedAt },
      after: { lastObservedAt: after.lastObservedAt }
    }),
    resolveForReplay: (transition) => transition
  }
};

/** Read-only lookup for future phases (e.g. P4 permissions, P8 observation
 * planning) and for P2's `recordTransition`, which needs `describeChange`
 * without re-applying the transition itself. */
export function getTransitionEntry(kind: TransitionKind): TransitionRegistry[TransitionKind] {
  return registry[kind];
}

export function listTransitionKinds(): TransitionKind[] {
  return Object.keys(registry) as TransitionKind[];
}

/**
 * The single write path for World Model state. Pure function: same
 * (state, transition) in, same state out, no I/O, no history side effect.
 * Throws WorldModelValidationError for an unrecognized kind or invalid
 * resulting state — it never silently accepts malformed input, which is
 * what makes it safe to eventually sit downstream of agent-authored
 * transitions (§11). P2's `recordTransition` wraps this function to also
 * produce an auditable Change record; this function itself stays exactly
 * as pure as it was in P1 — it does not know ChangeHistory exists.
 */
export function updateWorldModel(state: WorldModelState, transition: WorldModelTransition): WorldModelState {
  assertWorldModelState(state);

  if (typeof transition !== "object" || transition === null || typeof transition.kind !== "string") {
    throw new WorldModelValidationError("invalid_transition", "transition.kind is required");
  }

  const entry = registry[transition.kind as TransitionKind] as
    | ProjectTransitionEntry<ProjectTransition>
    | SessionTransitionEntry<SessionTransition>
    | undefined;

  if (!entry) {
    throw new WorldModelValidationError("invalid_transition", `Unsupported transition kind: ${transition.kind}`);
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
