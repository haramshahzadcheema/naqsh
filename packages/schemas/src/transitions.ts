import type {
  ConstraintInput,
  DecisionInput,
  EngineeringObjectInput,
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
