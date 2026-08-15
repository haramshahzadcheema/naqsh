import {
  getRelatedEntityRefs,
  getRelationshipsForEntity,
  observeProject,
  type EntityRef
} from "@naqsh/core";
import type { EntityKind, EntityRelationship, ObservationResult, WorldModelState } from "@naqsh/schemas";

/**
 * The application/API-surface seam Phase 8 requires (§8): "expose the
 * necessary API/service boundary so the future UI can request: project
 * observation, focused observation, object observation, relationship/
 * context observation." This is deliberately NOT an HTTP server — there is
 * no route table, no framework choice, no port binding here, because
 * standing one up is not a P8 concern and no later-numbered phase has
 * claimed that work yet either. What this file IS: the exact functions a
 * future HTTP handler (`POST /projects/:id/observe`, or similar) would
 * call directly, already typed against `@naqsh/core`'s real observation
 * API, so wiring an actual server later is pure plumbing — no business
 * logic would need to move here or be invented at that point.
 *
 * Every function is a thin, literal pass-through to `@naqsh/core` — this
 * file adds naming for the four request SHAPES the brief names, nothing
 * else. All actual behavior (scoping rules, error handling, the
 * project-vs-focus not-found asymmetry) stays exactly where P8 put it:
 * `packages/core/src/observe-project.ts`. Duplicating any of that logic
 * here would be exactly the kind of "move core business logic into the
 * frontend/API layer" the brief explicitly forbids.
 */

export function observeWholeProject(state: WorldModelState): ObservationResult {
  return observeProject(state, { scope: "project" });
}

export function observeFocusedProject(state: WorldModelState): ObservationResult {
  return observeProject(state, { scope: "focus" });
}

export function observeObject(state: WorldModelState, objectId: string): ObservationResult {
  return observeProject(state, { scope: "object", objectId });
}

export interface EntityRelationshipContext {
  relationships: EntityRelationship[];
  relatedEntities: EntityRef[];
}

export function observeEntityRelationships(state: WorldModelState, kind: EntityKind, id: string): EntityRelationshipContext {
  return {
    relationships: getRelationshipsForEntity(state, kind, id),
    relatedEntities: getRelatedEntityRefs(state, kind, id)
  };
}
