import type {
  ConstraintInput,
  DecisionInput,
  EngineeringObjectInput,
  EntityRelationshipInput,
  ExperimentInput,
  ObjectiveInput,
  PreferenceInput,
  ProjectInput,
  RequirementInput,
  SessionStateInput
} from "./types.js";
import type { ResearchEvidenceInput, SourceInput } from "./research-types.js";

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

/**
 * P22: patches a single existing `Experiment` -- closes a gap P1-P21 left
 * open despite `Experiment` (P1) having always had lifecycle-shaped fields
 * (`status`/`result`/`conclusion`) that implied progression over time: no
 * reducer ever existed to actually change them after `add_experiment`
 * created one. P22 needs this for real -- an experiment is recorded as
 * `"running"` before a candidate's build executes, then patched to
 * `"complete"`/`"failed"` with `buildResultId`/`result` once it finishes,
 * then patched again with `verificationResultIds` once checks run against
 * what it built. Mirrors `UpdateRequirementTransition`'s exact
 * `{id, patch}` shape and reducer semantics (merge onto the existing
 * record, re-validate, keep the id stable). */
export interface UpdateExperimentTransition extends BaseTransition<"update_experiment"> {
  experimentId: string;
  patch: ExperimentInput;
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

/** P21: adds a `Source` (external knowledge provenance record) to the
 * project. Mirrors `AddDecisionTransition`'s exact shape -- a `Source` is
 * append-only World Model state, never mutated in place (a source that
 * turns out to be wrong is marked `status: "retracted"` via a future
 * `update_source` transition if one is ever needed, not silently edited). */
export interface AddSourceTransition extends BaseTransition<"add_source"> {
  source: SourceInput;
}

/** P21: adds a `ResearchEvidence` record -- always references an existing
 * `Source.id` by convention (checked by `add-evidence-tool.ts`'s handler in
 * core, not the reducer -- matching `AddRelationshipTransition`'s identical
 * "cross-entity referential integrity is a read-time concern" precedent). */
export interface AddEvidenceTransition extends BaseTransition<"add_evidence"> {
  evidence: ResearchEvidenceInput;
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

/**
 * P15: replaces the ENTIRE project content with `project` -- the same
 * "full-entity replacement" shape `ReplaceSessionTransition` already
 * established one level down, applied at the project level for checkpoint
 * rollback. `id`/`createdAt` are always pinned back to the CURRENT
 * project's own values by `restore_checkpoint`'s caller (a rollback can
 * never change WHICH project this is, or fabricate a new genesis time) --
 * `updateWorldModel`'s own wrapper still forces `version: state.project.
 * version + 1` and a fresh `updatedAt` exactly like every other project
 * transition, so restoring never rewinds the version counter backward
 * (that would let a future, unrelated transition collide with an old
 * `resultingProjectVersion` already recorded in ChangeHistory). This is
 * "git revert" semantics, not "git reset" semantics: the CONTENT reverts,
 * the audit trail keeps moving forward.
 */
export interface RestoreProjectTransition extends BaseTransition<"restore_project"> {
  project: ProjectInput;
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
  | UpdateExperimentTransition
  | AddPreferenceTransition
  | AddRelationshipTransition
  | RemoveRelationshipTransition
  | AddSourceTransition
  | AddEvidenceTransition
  | UpdateObjectTransition
  | RestoreProjectTransition;

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
