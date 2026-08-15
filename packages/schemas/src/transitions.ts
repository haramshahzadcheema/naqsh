import type {
  ConstraintInput,
  DecisionInput,
  EngineeringObjectInput,
  EntityRelationshipInput,
  ExperimentInput,
  ObjectiveInput,
  PreferenceInput,
  RequirementInput,
  SessionStateInput
} from "./types.js";

/**
 * Every way the World Model's CURRENT STATE (WorldModelState) can change.
 *
 * This union lives in @naqsh/schemas, not @naqsh/core, because it is a
 * plain DATA CONTRACT — a typed description of a possible mutation — not
 * behavior. @naqsh/core's transition registry and `updateWorldModel`
 * reducer apply these; @naqsh/schemas' `Change` (see change types below)
 * records the fact that one was applied. It was moved here from core
 * during P2 specifically so `Change` could reference `WorldModelTransition`
 * without forcing schemas to depend on core — see the P2 report for the
 * full reasoning; this is the one P1 correction P2 required.
 *
 * Deliberately NOT included yet (added the same way as everything below
 * once a real producer exists): observation, proposed-action,
 * executed-action, and verification-result transitions.
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

/** P8: links two existing entities (e.g. "requirement req_1 is
 * satisfied_by object envobj_2"). Deliberately does not validate that
 * `sourceId`/`targetId` reference entities that currently exist — the
 * reducer stays a pure function of its own input, exactly like every other
 * `add_*` transition never checks cross-entity referential integrity (e.g.
 * `add_decision` doesn't verify anything either). Dangling references are
 * a read-time (observation) concern, not a write-time one. */
export interface AddRelationshipTransition extends BaseTransition<"add_relationship"> {
  relationship: EntityRelationshipInput;
}

export interface RemoveRelationshipTransition extends BaseTransition<"remove_relationship"> {
  relationshipId: string;
}

/**
 * P11: patches a single property on an existing `EngineeringObject` --
 * closes the one write-path gap P1-P10 left open despite `EngineeringObject`
 * already being creatable (`add_object`) and every OTHER core entity having
 * an `update_*` transition (`update_requirement`). Without this, Phase 11's
 * controlled agent loop would have nothing to actually EXECUTE against the
 * World Model once a proposal is approved.
 *
 * `propertyKey`/`value` (not a generic `patch`) deliberately mirrors
 * `update_requirement`'s shape while matching the exact `modify_object` tool
 * contract P10's own test fixtures already established
 * (`registryWithModifyObject` in proposal-generator.test.ts /
 * proposal-tool.test.ts: `input: { objectId, propertyKey, value }`) -- this
 * is not a new vocabulary, it is completing one already implied.
 */
export interface UpdateObjectTransition extends BaseTransition<"update_object"> {
  objectId: string;
  propertyKey: string;
  value: unknown;
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
  | AddPreferenceTransition
  | AddRelationshipTransition
  | RemoveRelationshipTransition
  | UpdateObjectTransition;

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
