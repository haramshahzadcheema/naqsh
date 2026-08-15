import type {
  Constraint,
  Decision,
  EngineeringObject,
  EntityRelationship,
  EntitySource,
  Experiment,
  Preference,
  Requirement,
  SessionMode
} from "./types.js";

/**
 * The Project Observation contracts (P8).
 *
 * These types describe the DETERMINISTIC, read-only understanding NAQSH
 * builds from `WorldModelState` — never a second copy of project state,
 * never something Gemini constructs. `ObservationResult` is always
 * produced by `packages/core`'s `observeProject` from the CURRENT
 * `WorldModelState`; nothing in this file, and nothing that constructs an
 * `ObservationResult`, may import a model-provider package or touch
 * `@google/genai`. The intended flow is:
 *
 *   WorldModelState -> observeProject() -> ObservationResult -> (later,
 *   optionally) Gemini reasons OVER the result
 *
 * never the reverse. See README's Observation section for the full
 * boundary explanation.
 */

/**
 * What portion of the project an observation covers — the seam P8's brief
 * calls "focus-aware observation":
 *   "project" -> the entire project: every requirement, constraint,
 *                object, decision, experiment, preference, and
 *                relationship. No filtering.
 *   "focus"   -> only `SessionState.focusObjectIds` and whatever is
 *                directly connected to them via `EntityRelationship`
 *                (one hop). Lets a caller avoid loading the whole project
 *                into every prompt.
 *   "object"  -> exactly one named object plus its directly connected
 *                context (one hop) — the narrowest scope.
 */
export type ObservationScope = "project" | "focus" | "object";

export const OBSERVATION_SCOPES: readonly ObservationScope[] = ["project", "focus", "object"];

/**
 * A structured, inspectable understanding of (a scope of) the project —
 * what P9's eventual planner consumes instead of reconstructing state from
 * conversation history. Deliberately a FLAT snapshot, not a live view:
 * every array here is a plain copy of already-validated entities pulled
 * out of `WorldModelState` at `observedAt`, so holding an `ObservationResult`
 * can never let a caller mutate the World Model through it (there is
 * nothing "live" to mutate — see README for why this is what makes
 * observation read-only by construction, not merely by convention).
 *
 * `missingInformation` is populated by real, deterministic structural
 * checks (e.g. "no requirements defined yet", "focused object no longer
 * exists") — never fabricated, never guessed. `ambiguityIndicators` is
 * reserved, always empty in P8: genuine ambiguity DETECTION (does this
 * requirement conflict with that constraint, is the objective actually
 * clear) is P19's job, not this one's — the field exists now purely so
 * P19 has somewhere to write without a breaking schema change later.
 */
export interface ObservationResult {
  id: string;
  projectId: string;
  projectVersion: number;
  scope: ObservationScope;
  /** Non-null only when `scope` is `"object"`. */
  scopeObjectId: string | null;
  objectiveSummary: string | null;
  requirements: Requirement[];
  constraints: Constraint[];
  objects: EngineeringObject[];
  relationships: EntityRelationship[];
  decisions: Decision[];
  experiments: Experiment[];
  preferences: Preference[];
  focusObjectIds: string[];
  sessionMode: SessionMode;
  missingInformation: string[];
  ambiguityIndicators: string[];
  /** Who/what produced this observation. Always `"system"` in practice —
   * `observeProject` is deterministic application logic, never Gemini —
   * reusing `EntitySource` rather than inventing a parallel provenance
   * concept. */
  source: EntitySource;
  observedAt: string;
  metadata: Record<string, unknown>;
}

/**
 * Entity arrays are the REAL, already-validated entity types (not
 * `RequirementInput`-style partials): `createObservationResult` never
 * reconstructs entities pulled from `WorldModelState`, only validates that
 * what it was given is well-formed — reconstructing them would be
 * redundant work and a chance to silently normalize data that was already
 * correct.
 */
export interface ObservationResultInput {
  id?: string;
  projectId: string;
  projectVersion: number;
  scope: ObservationScope;
  scopeObjectId?: string | null;
  objectiveSummary?: string | null;
  requirements?: Requirement[];
  constraints?: Constraint[];
  objects?: EngineeringObject[];
  relationships?: EntityRelationship[];
  decisions?: Decision[];
  experiments?: Experiment[];
  preferences?: Preference[];
  focusObjectIds?: string[];
  sessionMode?: SessionMode;
  missingInformation?: string[];
  ambiguityIndicators?: string[];
  source?: EntitySource;
  observedAt?: string;
  metadata?: Record<string, unknown>;
}

/** Every distinct way an observation REQUEST can fail — never a bare
 * `Error("not found")`. Deliberately small: only kinds `observeProject`
 * (core) actually produces today. `entity_not_found` fires only for the
 * narrow `scope: "object"` request (a single, explicitly-named entity that
 * doesn't exist); a stale id inside a BROADER scope (`"focus"`) degrades
 * gracefully into `ObservationResult.missingInformation` instead of
 * failing the whole observation — see observe-project.ts for why that
 * distinction is deliberate. */
export type ObservationErrorKind = "entity_not_found" | "invalid_scope" | "invalid_focus";

export const OBSERVATION_ERROR_KINDS: readonly ObservationErrorKind[] = [
  "entity_not_found",
  "invalid_scope",
  "invalid_focus"
];
