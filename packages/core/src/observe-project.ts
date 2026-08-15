import {
  createObservationResult,
  ObservationError,
  type Constraint,
  type Decision,
  type EngineeringObject,
  type EntityKind,
  type EntityRelationship,
  type Experiment,
  type ObservationResult,
  type Preference,
  type Requirement,
  type WorldModelState
} from "@naqsh/schemas";

/**
 * The Project Observation API (P8) — deterministic, read-only queries over
 * `WorldModelState`. Every function here is a PURE function of its
 * `WorldModelState` argument: no I/O, no id/timestamp generation except
 * inside `observeProject`'s own `createObservationResult` call, and
 * critically no path back INTO `WorldModelState` — nothing in this file
 * imports `updateWorldModel`, `ChangeHistory`, or `recordTransition`
 * (enforced as a repo-boundaries regression test, mirroring the
 * EnvironmentAdapter/ModelProvider World-Model-boundary guards).
 *
 * "Read-only" is enforced structurally, not by convention: every function
 * below returns a `snapshot()` — a `structuredClone`, then recursively
 * frozen — never a live reference into `state.project`/`state.session`.
 * This is load-bearing, not defensive polish: neither `Project`'s own
 * arrays nor P1's individual `createX` entity factories freeze their
 * output (confirmed while auditing this file — `Requirement`/`Constraint`/
 * etc. are plain mutable objects sitting in a plain mutable array), so
 * without `snapshot()` a caller doing `result.requirements.push(...)` or
 * `result.requirements[0].description = "x"` would silently mutate the
 * World Model itself. Every exported function here — not just
 * `observeProject` — carries this guarantee, since several
 * (`getRelationshipsForEntity`, `getFocusedObjects`, ...) are consumed
 * directly by callers outside `observeProject` (see
 * `apps/api/src/observation-service.ts`).
 */

function snapshot<T>(value: T): T {
  const clone = structuredClone(value);
  deepFreezeInPlace(clone);
  return clone;
}

function deepFreezeInPlace(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeInPlace(item);
    Object.freeze(value);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) deepFreezeInPlace(item);
    Object.freeze(value);
  }
}

// ---------------------------------------------------------------------------
// Direct lookups
// ---------------------------------------------------------------------------

export function getRequirementById(state: WorldModelState, id: string): Requirement | undefined {
  return snapshot(state.project.requirements.find((requirement) => requirement.id === id));
}

export function getConstraintById(state: WorldModelState, id: string): Constraint | undefined {
  return snapshot(state.project.constraints.find((constraint) => constraint.id === id));
}

export function getObjectById(state: WorldModelState, id: string): EngineeringObject | undefined {
  return snapshot(state.project.objects.find((object) => object.id === id));
}

export function getDecisionById(state: WorldModelState, id: string): Decision | undefined {
  return snapshot(state.project.decisions.find((decision) => decision.id === id));
}

export function getExperimentById(state: WorldModelState, id: string): Experiment | undefined {
  return snapshot(state.project.experiments.find((experiment) => experiment.id === id));
}

export function getPreferenceById(state: WorldModelState, id: string): Preference | undefined {
  return snapshot(state.project.preferences.find((preference) => preference.id === id));
}

type AnyEntity = Requirement | Constraint | EngineeringObject | Decision | Experiment | Preference;

function resolveEntity(state: WorldModelState, kind: EntityKind, id: string): AnyEntity | undefined {
  switch (kind) {
    case "requirement":
      return getRequirementById(state, id);
    case "constraint":
      return getConstraintById(state, id);
    case "object":
      return getObjectById(state, id);
    case "decision":
      return getDecisionById(state, id);
    case "experiment":
      return getExperimentById(state, id);
    case "preference":
      return getPreferenceById(state, id);
  }
}

// ---------------------------------------------------------------------------
// Project summary
// ---------------------------------------------------------------------------

/** A lightweight header, not a full observation — for callers that only
 * need identity/counts (e.g. a project list) without paying for the full
 * entity arrays `observeProject` returns. Kept as a core-local interface
 * rather than a schemas type: nothing outside `packages/core` needs to
 * name this shape, unlike `ObservationResult` (a real cross-package
 * contract). */
export interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  objectiveSummary: string | null;
  version: number;
  requirementCount: number;
  constraintCount: number;
  objectCount: number;
  decisionCount: number;
  experimentCount: number;
  preferenceCount: number;
  relationshipCount: number;
  createdAt: string;
  updatedAt: string;
}

export function getProjectSummary(state: WorldModelState): ProjectSummary {
  const { project } = state;
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    objectiveSummary: project.objective.summary.length > 0 ? project.objective.summary : null,
    version: project.version,
    requirementCount: project.requirements.length,
    constraintCount: project.constraints.length,
    objectCount: project.objects.length,
    decisionCount: project.decisions.length,
    experimentCount: project.experiments.length,
    preferenceCount: project.preferences.length,
    relationshipCount: project.relationships.length,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt
  };
}

// ---------------------------------------------------------------------------
// Relationship traversal
// ---------------------------------------------------------------------------

/** Every relationship touching this entity, whichever side it's on. */
export function getRelationshipsForEntity(state: WorldModelState, kind: EntityKind, id: string): EntityRelationship[] {
  return snapshot(
    state.project.relationships.filter(
      (relationship) =>
        (relationship.sourceType === kind && relationship.sourceId === id) ||
        (relationship.targetType === kind && relationship.targetId === id)
    )
  );
}

export interface EntityRef {
  kind: EntityKind;
  id: string;
}

/** What's directly connected to this entity — one hop, deduplicated,
 * self-references excluded. Returns bare references (not resolved
 * entities): the cheapest possible "what touches X" query, useful for
 * shape/graph-style questions that don't need full entity bodies. */
export function getRelatedEntityRefs(state: WorldModelState, kind: EntityKind, id: string): EntityRef[] {
  const relationships = getRelationshipsForEntity(state, kind, id);
  const seen = new Set<string>();
  const refs: EntityRef[] = [];
  for (const relationship of relationships) {
    const isSource = relationship.sourceType === kind && relationship.sourceId === id;
    const otherKind = isSource ? relationship.targetType : relationship.sourceType;
    const otherId = isSource ? relationship.targetId : relationship.sourceId;
    const key = `${otherKind}:${otherId}`;
    if (key === `${kind}:${id}` || seen.has(key)) continue;
    seen.add(key);
    refs.push({ kind: otherKind, id: otherId });
  }
  return refs;
}

/** Every entity of `targetKind` directly related to `(sourceKind, sourceId)`
 * — the generic primitive behind the named convenience functions below.
 * Silently skips a relationship whose referenced entity no longer exists
 * (a dangling reference is a read-time fact to tolerate, not a hard
 * failure — see `observeProject`'s doc comment for why). */
export function getRelatedEntitiesOfKind(
  state: WorldModelState,
  sourceKind: EntityKind,
  sourceId: string,
  targetKind: EntityKind
): AnyEntity[] {
  const results: AnyEntity[] = [];
  for (const ref of getRelatedEntityRefs(state, sourceKind, sourceId)) {
    if (ref.kind !== targetKind) continue;
    const entity = resolveEntity(state, ref.kind, ref.id);
    if (entity) results.push(entity);
  }
  return results;
}

export function getRequirementsForObject(state: WorldModelState, objectId: string): Requirement[] {
  return getRelatedEntitiesOfKind(state, "object", objectId, "requirement") as Requirement[];
}

export function getConstraintsForObject(state: WorldModelState, objectId: string): Constraint[] {
  return getRelatedEntitiesOfKind(state, "object", objectId, "constraint") as Constraint[];
}

export function getDecisionsForObject(state: WorldModelState, objectId: string): Decision[] {
  return getRelatedEntitiesOfKind(state, "object", objectId, "decision") as Decision[];
}

export function getExperimentsForRequirement(state: WorldModelState, requirementId: string): Experiment[] {
  return getRelatedEntitiesOfKind(state, "requirement", requirementId, "experiment") as Experiment[];
}

// ---------------------------------------------------------------------------
// Focus
// ---------------------------------------------------------------------------

function resolveFocusedObjects(state: WorldModelState): { objects: EngineeringObject[]; missingIds: string[] } {
  const objects: EngineeringObject[] = [];
  const missingIds: string[] = [];
  for (const id of state.session.focusObjectIds) {
    const object = getObjectById(state, id);
    if (object) objects.push(object);
    else missingIds.push(id);
  }
  return { objects, missingIds };
}

/** Resolves `SessionState.focusObjectIds` to real objects, silently
 * dropping any stale id. Use `observeProject({scope:"focus"})` instead of
 * this directly when the CALLER needs to know about a stale id — this
 * function is the "just give me what exists" convenience. */
export function getFocusedObjects(state: WorldModelState): EngineeringObject[] {
  return resolveFocusedObjects(state).objects;
}

// ---------------------------------------------------------------------------
// observeProject
// ---------------------------------------------------------------------------

interface OneHopContext {
  requirements: Requirement[];
  constraints: Constraint[];
  objects: EngineeringObject[];
  decisions: Decision[];
  experiments: Experiment[];
  preferences: Preference[];
  relationships: EntityRelationship[];
}

function emptyContext(): OneHopContext {
  return { requirements: [], constraints: [], objects: [], decisions: [], experiments: [], preferences: [], relationships: [] };
}

function pushIntoContext(context: OneHopContext, kind: EntityKind, entity: AnyEntity): void {
  switch (kind) {
    case "requirement":
      context.requirements.push(entity as Requirement);
      return;
    case "constraint":
      context.constraints.push(entity as Constraint);
      return;
    case "object":
      context.objects.push(entity as EngineeringObject);
      return;
    case "decision":
      context.decisions.push(entity as Decision);
      return;
    case "experiment":
      context.experiments.push(entity as Experiment);
      return;
    case "preference":
      context.preferences.push(entity as Preference);
      return;
  }
}

/** One-hop context for a SET of seed entities at once (used by `"focus"`
 * scope, which may seed from several focused objects), deduplicated
 * across both entities and relationships so a shared connection is never
 * listed twice. Deliberately reuses `getRelatedEntityRefs` for "which
 * entity is on the other side of this relationship" rather than
 * reimplementing that logic inline a second time — two independent
 * copies of the same source/target resolution is exactly the kind of
 * duplication that drifts silently if one is ever fixed without the
 * other. Traversal is always exactly one hop: a newly-discovered entity's
 * OWN relationships are never followed, so a relationship cycle (A -> B ->
 * C -> A) cannot cause unbounded/infinite traversal by construction — see
 * observe-project.test.ts's cycle regression test. */
function collectContextForSeeds(state: WorldModelState, seeds: EntityRef[]): OneHopContext {
  const context = emptyContext();
  const seedKeys = new Set(seeds.map((seed) => `${seed.kind}:${seed.id}`));
  const seenEntities = new Set<string>();
  const seenRelationships = new Set<string>();
  for (const seed of seeds) {
    for (const relationship of getRelationshipsForEntity(state, seed.kind, seed.id)) {
      if (!seenRelationships.has(relationship.id)) {
        seenRelationships.add(relationship.id);
        context.relationships.push(relationship);
      }
    }
    for (const ref of getRelatedEntityRefs(state, seed.kind, seed.id)) {
      const key = `${ref.kind}:${ref.id}`;
      if (seedKeys.has(key) || seenEntities.has(key)) continue;
      seenEntities.add(key);
      const entity = resolveEntity(state, ref.kind, ref.id);
      if (entity) pushIntoContext(context, ref.kind, entity);
    }
  }
  return context;
}

export type ObserveProjectOptions = { scope: "project" } | { scope: "focus" } | { scope: "object"; objectId: string };

/**
 * THE deterministic construction point for `ObservationResult` — the ONLY
 * function in this repository allowed to build one. Never Gemini, never a
 * planner: see README's Observation section for why that boundary matters.
 *
 * Error policy is deliberately asymmetric between scopes:
 *   - `scope: "object"` names exactly ONE entity explicitly. If it
 *     doesn't exist, this THROWS `ObservationError("entity_not_found")` —
 *     the same "an explicit, single-target lookup that misses is a hard
 *     failure" precedent `EnvironmentAdapter.inspectObject` already set
 *     for `object_not_found`.
 *   - `scope: "focus"` aggregates POTENTIALLY MANY objects from
 *     `SessionState.focusObjectIds`. A single stale id there does not fail
 *     the whole observation (a project can legitimately have some stale
 *     focus references without being "broken") — it is recorded in
 *     `missingInformation` instead, and the rest of the observation still
 *     succeeds.
 *   - `scope: "project"` never fails: every entity is already known to
 *     exist (they ARE the arrays being read).
 */
export function observeProject(state: WorldModelState, options: ObserveProjectOptions = { scope: "project" }): ObservationResult {
  const { project, session } = state;
  const missingInformation: string[] = [];

  if (project.objective.summary.trim().length === 0) {
    missingInformation.push("Project objective is not yet defined.");
  }
  if (project.requirements.length === 0) {
    missingInformation.push("No requirements have been defined yet.");
  }

  let requirements: Requirement[];
  let constraints: Constraint[];
  let objects: EngineeringObject[];
  let decisions: Decision[];
  let experiments: Experiment[];
  let preferences: Preference[];
  let relationships: EntityRelationship[];
  let scopeObjectId: string | null = null;

  if (options.scope === "project") {
    requirements = project.requirements;
    constraints = project.constraints;
    objects = project.objects;
    decisions = project.decisions;
    experiments = project.experiments;
    preferences = project.preferences;
    relationships = project.relationships;
  } else if (options.scope === "object") {
    if (typeof options.objectId !== "string" || options.objectId.trim().length === 0) {
      throw new ObservationError("invalid_focus", 'scope "object" requires a non-empty objectId');
    }
    const target = getObjectById(state, options.objectId);
    if (!target) {
      throw new ObservationError("entity_not_found", `No object with id "${options.objectId}" exists in this project`);
    }
    scopeObjectId = target.id;
    const context = collectContextForSeeds(state, [{ kind: "object", id: target.id }]);
    objects = [target, ...context.objects];
    requirements = context.requirements;
    constraints = context.constraints;
    decisions = context.decisions;
    experiments = context.experiments;
    preferences = context.preferences;
    relationships = context.relationships;
  } else if (options.scope === "focus") {
    const { objects: focusedObjects, missingIds } = resolveFocusedObjects(state);
    for (const id of missingIds) {
      missingInformation.push(`Focused object "${id}" no longer exists in the project.`);
    }
    const context = collectContextForSeeds(
      state,
      focusedObjects.map((object) => ({ kind: "object" as const, id: object.id }))
    );
    objects = [...focusedObjects, ...context.objects];
    requirements = context.requirements;
    constraints = context.constraints;
    decisions = context.decisions;
    experiments = context.experiments;
    preferences = context.preferences;
    relationships = context.relationships;
  } else {
    // Exhaustiveness guard: `options.scope` is typed as the closed
    // ObserveProjectOptions union, but this function is also reachable
    // from untyped tool input (see observation-tool.ts), which validates
    // scope itself BEFORE calling here -- this branch defends the core
    // function too, independent of that caller.
    throw new ObservationError("invalid_scope", `Unsupported observation scope: ${String((options as { scope: unknown }).scope)}`);
  }

  return createObservationResult({
    projectId: project.id,
    projectVersion: project.version,
    scope: options.scope,
    scopeObjectId,
    objectiveSummary: project.objective.summary.length > 0 ? project.objective.summary : null,
    requirements,
    constraints,
    objects,
    relationships,
    decisions,
    experiments,
    preferences,
    focusObjectIds: session.focusObjectIds,
    sessionMode: session.mode,
    missingInformation,
    source: "system"
  });
}
