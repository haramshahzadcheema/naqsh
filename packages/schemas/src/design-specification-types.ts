import type { EntitySource } from "./types.js";
import type { EnvironmentObjectGenericType } from "./environment-types.js";

/**
 * Phase 20: INTENT -> REQUIREMENTS -> PLAN -> DESIGN -> BUILD -> VERIFY.
 *
 * `DesignSpecification` is the structured, ENVIRONMENT-INDEPENDENT
 * representation of "what should be built" -- deliberately positioned
 * between `Plan`/`PlanStep` (P9, "what needs to happen," e.g. "create the
 * mounting plate") and an actual environment mutation (P5/P11's
 * `EnvironmentAdapter`, e.g. a real FreeCAD `Part::Box`). It never carries
 * a FreeCAD document-object reference, a Python API name, or any
 * environment-specific topology identifier -- `components`/`expectedOutputs`
 * describe geometry INTENT (`geometryIntent: "rectangular mounting plate,
 * ~100x60x5mm"`) and target properties as plain data, the same "the
 * environment interprets the intent" boundary `EnvironmentAdapter` itself
 * already draws for every other tool in this codebase (see
 * `environment-adapter.ts`'s own doc comment). P26 depends on this
 * boundary staying clean, so nothing in this file imports, mentions, or
 * assumes anything from `@naqsh/adapters`.
 *
 * `DesignSpecification` is a SEPARATE entity from both `Plan` and
 * `Requirement`/`Constraint` (P1) -- mirrors every prior "candidate/process
 * record is not yet real state" entity in this codebase (`Proposal`,
 * `RequirementCandidate`, `Clarification`): it describes a PROPOSED design,
 * never a mutated Plan or a World Model entity. Reuses `EntitySource`
 * (provenance) and the `supersedesXId`/`version` revision pattern `Plan`/
 * `Proposal` already established -- design VERSIONING (Step 19 of the P20
 * brief) is this same convention, not a new one.
 */

/** A closed lifecycle, matching `PlanStatus`/`ProposalStatus`'s identical
 * "define the full enum, only produce a documented subset now" convention.
 * `generateDesignSpecification` only ever produces `"proposed"`; nothing in
 * P20 auto-approves a design -- approval remains P4's job (see
 * `design-specification-store.ts`'s doc comment). */
export type DesignSpecificationStatus = "proposed" | "approved" | "rejected" | "superseded";

export const DESIGN_SPECIFICATION_STATUSES: readonly DesignSpecificationStatus[] = ["proposed", "approved", "rejected", "superseded"];

/**
 * One intended physical/geometric component of the design -- e.g. "the
 * mounting plate," "a reinforcing rib." `geometryIntent` is free text
 * describing shape/size in engineering terms, never a CAD primitive or API
 * call; `dimensions` is a flat, named numeric bag (`{length: 100, width:
 * 60, thickness: 5}`) rather than a fixed geometry schema, since which
 * dimensions matter is entirely design-specific (P20 brief's own "do NOT
 * create a giant universal CAD schema" instruction).
 */
export interface DesignComponent {
  id: string;
  name: string;
  /** Free classification, e.g. "plate", "bracket_body", "mounting_hole" --
   * never a FreeCAD type string. */
  type: string;
  geometryIntent: string;
  dimensions: Record<string, number>;
  /** Another `DesignComponent.id` in THIS specification this one is
   * conceptually part of/attached to, or `null` for a top-level component
   * -- checked by `design-semantics.ts` (must resolve, must not cycle). */
  parentComponentId: string | null;
  metadata: Record<string, unknown>;
}

export interface DesignComponentInput {
  id?: string;
  name: string;
  type: string;
  geometryIntent: string;
  dimensions?: Record<string, number>;
  parentComponentId?: string | null;
  metadata?: Record<string, unknown>;
}

/** A named relationship between two components in the SAME specification
 * (e.g. `type: "attached_to"`) -- mirrors `EntityRelationship`'s (P8)
 * "free-form type string, typed source/target reference" shape, scoped to
 * design-time components rather than World Model entities. */
export interface DesignRelationship {
  id: string;
  type: string;
  sourceComponentId: string;
  targetComponentId: string;
  metadata: Record<string, unknown>;
}

export interface DesignRelationshipInput {
  id?: string;
  type: string;
  sourceComponentId: string;
  targetComponentId: string;
  metadata?: Record<string, unknown>;
}

/**
 * The bridge from design INTENT to a concrete build operation: exactly the
 * fields `create_environment_object` (this phase's new tool) needs, in
 * environment-independent form. `environmentObjectType`/`properties` are
 * plain data handed to `EnvironmentAdapter.createObject` unchanged --
 * `properties` is genuinely environment-specific (a mock CAD environment's
 * "material" is a string; a real FreeCAD Length/Width/Height are numbers),
 * exactly like `modify-environment-object-tool.ts`'s own `value` field
 * already accepts a polymorphic value for the identical reason. This file
 * does not know or care what "Length" means to any given adapter.
 */
export interface ExpectedBuildOutput {
  id: string;
  /** The `DesignComponent.id` (same specification) this output realizes. */
  componentId: string;
  environmentObjectType: string;
  environmentGenericType: EnvironmentObjectGenericType | null;
  properties: Record<string, unknown>;
}

export interface ExpectedBuildOutputInput {
  id?: string;
  componentId: string;
  environmentObjectType: string;
  environmentGenericType?: EnvironmentObjectGenericType | null;
  properties?: Record<string, unknown>;
}

export interface DesignSpecification {
  id: string;
  projectId: string;
  /** `Project.version` this design was generated against -- staleness
   * signal, mirrors `Plan.projectVersion`/`Proposal.projectVersion`. */
  projectVersion: number;
  /** The `Plan.id` this design realizes. */
  planId: string;
  /** The `PlanStep.id` (within that plan) this design concretely realizes
   * -- the same "never an unexplained orphan" traceability `Proposal.
   * planStepId` already requires. */
  planStepId: string;
  /** Copied from `Plan.objectiveSummary` at generation time -- same "a
   * record describes what it was asked to accomplish AT THE TIME"
   * reasoning `Plan`/`Proposal` already document. */
  objectiveSummary: string;
  description: string;
  components: DesignComponent[];
  relationships: DesignRelationship[];
  /** Free-form named engineering parameters (e.g. `{safety_factor: 1.5}`)
   * that don't belong to one specific component -- deliberately a plain
   * bag, not a fixed schema (same reasoning as `DesignComponent.dimensions`). */
  parameters: Record<string, unknown>;
  material: string | null;
  manufacturingIntent: string | null;
  /** Real `Constraint.id`s (P1) this design was built to respect -- must
   * resolve to real constraints in the current project (checked by
   * `design-semantics.ts`), never invented. */
  relevantConstraintIds: string[];
  /** Real `Requirement.id`s (P1) this design addresses -- must be a subset
   * of the originating `PlanStep.relevantRequirementIds`, mirroring
   * `Proposal.relevantRequirementIds`'s identical narrowing rule. */
  relevantRequirementIds: string[];
  expectedOutputs: ExpectedBuildOutput[];
  status: DesignSpecificationStatus;
  /** id of the design specification this one revises/replaces, or `null`
   * for an original design. Mirrors `Plan.supersedesPlanId`/`Proposal.
   * supersedesProposalId` exactly -- P20's versioning story reuses this
   * established convention rather than inventing a new one. */
  supersedesDesignSpecificationId: string | null;
  version: number;
  /** Provenance: who/what produced this design. Typically `"agent"`
   * (Gemini proposed it via `generateDesignSpecification`) -- reuses
   * `EntitySource` exactly like `Plan.source`/`Proposal.source`. */
  source: EntitySource;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface DesignSpecificationInput {
  id?: string;
  projectId: string;
  projectVersion: number;
  planId: string;
  planStepId: string;
  objectiveSummary: string;
  description: string;
  components?: DesignComponentInput[];
  relationships?: DesignRelationshipInput[];
  parameters?: Record<string, unknown>;
  material?: string | null;
  manufacturingIntent?: string | null;
  relevantConstraintIds?: string[];
  relevantRequirementIds?: string[];
  expectedOutputs?: ExpectedBuildOutputInput[];
  status?: DesignSpecificationStatus;
  supersedesDesignSpecificationId?: string | null;
  version?: number;
  source?: EntitySource;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

/** Every distinct way a DESIGN GENERATION REQUEST or the resulting
 * structure can fail -- never a bare `Error("design generation failed")`.
 * Mirrors `ProposalGenerationErrorKind`'s (P10) granularity exactly:
 *   "invalid_input"              -> the Plan/planStepId/options given to
 *                                    generateDesignSpecification are
 *                                    malformed, or planStepId doesn't name
 *                                    a real step in the given plan
 *   "model_unavailable"          -> the underlying ModelProvider.generate()
 *                                    call itself returned status:"error"
 *   "invalid_model_output"       -> the model didn't return a
 *                                    structured_result at all
 *   "malformed_design_shape"     -> the structured JSON came back but does
 *                                    not assemble into a valid
 *                                    DesignSpecification (assertDesignSpecification
 *                                    failed)
 *   "semantic_validation_failed" -> the shape is valid but references a
 *                                    component/requirement/constraint that
 *                                    doesn't exist, or another semantic
 *                                    violation (see design-semantics.ts)
 */
export type DesignGenerationErrorKind =
  | "invalid_input"
  | "model_unavailable"
  | "invalid_model_output"
  | "malformed_design_shape"
  | "semantic_validation_failed";

export const DESIGN_GENERATION_ERROR_KINDS: readonly DesignGenerationErrorKind[] = [
  "invalid_input",
  "model_unavailable",
  "invalid_model_output",
  "malformed_design_shape",
  "semantic_validation_failed"
];
