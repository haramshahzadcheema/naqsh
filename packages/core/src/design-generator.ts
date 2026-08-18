import {
  assertPlan,
  createDesignSpecification,
  createModelContext,
  createModelRequest,
  type Constraint,
  type DesignGenerationErrorKind,
  type DesignSpecification,
  type EnvironmentObjectGenericType,
  type ModelContext,
  type ModelRequestConfigInput,
  type Plan,
  type PlanStep,
  type Requirement,
  type ToolValueSchema
} from "@naqsh/schemas";
import type { ModelProvider } from "./model-provider.js";
import { validateDesignSpecificationSemantics } from "./design-semantics.js";

/**
 * Plan Step + Requirements/Constraints -> `DesignSpecification` (P20).
 *
 * The core flow this file implements is:
 *
 *   Plan + PlanStep + Requirements + Constraints -> ModelRequest ->
 *   ModelProvider.generate() -> structured candidate -> shape validation
 *   -> semantic validation -> DesignSpecification
 *
 * NEVER `DesignSpecification -> build`: `generateDesignSpecification`
 * produces a `DesignSpecification` (a description of INTENT) and stops
 * there -- nothing in this file, and nothing that constructs a
 * `DesignSpecification`, imports `updateWorldModel`, `ChangeHistory`,
 * `recordTransition`, `executeTool`, `invokeRegisteredTool`, an
 * `EnvironmentAdapter`, or `@naqsh/adapters`. Generating a design cannot
 * mutate `WorldModelState` and cannot touch any environment because
 * nothing in this file ever holds a reference to anything that could --
 * enforced as repo-boundaries regression tests, mirroring P9/P10's
 * identical guards (see `repo-boundaries.test.ts`'s P20 guard block).
 *
 * Gemini's output is never automatically authoritative -- the identical
 * discipline `generateProposal`/`generatePlanProposal` already established:
 * `provider.generate()` runs `validateStructuredResult` (schema
 * conformance) before ever returning `status: "success"`, and this file
 * adds two more layers before anything is called a `DesignSpecification`:
 * reassembling the shape into a real, schema-validated domain object
 * (`createDesignSpecification`/`assertDesignSpecification`), then
 * `validateDesignSpecificationSemantics` (design-semantics.ts) -- the check
 * that catches a structurally-valid design referencing a plan step,
 * requirement, constraint, or component that doesn't exist (or a
 * component-parent cycle). A design that fails either layer is REJECTED
 * (`status: "error"`), never silently repaired.
 */

const DESIGN_SYSTEM_INSTRUCTION =
  "You are NAQSH's engineering design generator. Given ONE specific plan step and the project's requirements and " +
  "constraints, you propose a structured DESIGN SPECIFICATION describing the intended geometry/components at a " +
  "conceptual level. You do not execute anything and you do not write CAD code -- a human must approve this " +
  "design before anything is built. Rules that must never be broken: " +
  "(1) Describe geometry as INTENT in plain engineering terms (e.g. 'rectangular mounting plate, ~100x60x5mm') -- " +
  "never as a CAD API call, Python snippet, FreeCAD object name, or any executable code. " +
  "(2) relevantRequirementIds/relevantConstraintIds must be copied EXACTLY from what the plan step already lists " +
  "as relevant -- never invent a new one. " +
  "(3) Every component you reference (via parentComponentId, a relationship, or an expectedOutput's componentId) " +
  "must be one of the components you yourself defined in this same response -- never reference a component that " +
  "doesn't exist. " +
  "(4) Do not invent a numeric dimension or parameter the requirements/constraints/plan step don't support -- if " +
  "a dimension is genuinely undetermined, omit it from `dimensions` rather than guessing a plausible-sounding " +
  "number. " +
  "(5) Every component that should actually be built must have exactly one corresponding entry in " +
  "expectedOutputs -- a component with no expectedOutput is design-only (e.g. a conceptual grouping) and will " +
  "never be built.";

const designComponentOutputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "A short, unique label for this component (e.g. 'plate'). Referenced by parentComponentId/relationships/expectedOutputs." },
    name: { type: "string" },
    type: { type: "string", description: "Short classification, e.g. 'plate', 'bracket_body', 'mounting_hole'. Never a CAD API type." },
    geometryIntent: { type: "string", description: "Plain-language description of the intended shape/size -- never code." },
    dimensions: { type: "object", properties: {}, additionalProperties: true, description: "Named numeric dimensions, e.g. {\"length\": 100, \"width\": 60}. Omit any dimension that isn't actually determined." },
    parentComponentId: { type: "string", nullable: true, description: "id of another component in THIS response, or null." }
  },
  required: ["id", "name", "type", "geometryIntent", "dimensions", "parentComponentId"],
  additionalProperties: false
};

const designRelationshipOutputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string", description: "e.g. 'attached_to', 'coaxial_with'." },
    sourceComponentId: { type: "string" },
    targetComponentId: { type: "string" }
  },
  required: ["id", "type", "sourceComponentId", "targetComponentId"],
  additionalProperties: false
};

const expectedBuildOutputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    componentId: { type: "string", description: "Must match a component id defined in THIS response." },
    environmentObjectType: { type: "string", description: "A generic object-type label for the target environment, e.g. 'part'." },
    environmentGenericType: { type: "string", nullable: true, enum: ["solid", "sketch", "container", "datum", "link", "unknown"] },
    properties: { type: "object", properties: {}, additionalProperties: true, description: "Target property values for the built object, e.g. {\"Length\": 100}." }
  },
  required: ["id", "componentId", "environmentObjectType", "environmentGenericType", "properties"],
  additionalProperties: false
};

const designGenerationOutputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    description: { type: "string" },
    components: { type: "array", items: designComponentOutputSchema },
    relationships: { type: "array", items: designRelationshipOutputSchema },
    parameters: { type: "object", properties: {}, additionalProperties: true },
    material: { type: "string", nullable: true },
    manufacturingIntent: { type: "string", nullable: true },
    relevantRequirementIds: { type: "array", items: { type: "string" }, description: "Must be a subset of the plan step's own relevantRequirementIds." },
    relevantConstraintIds: { type: "array", items: { type: "string" }, description: "Must be a subset of the plan step's own relevantConstraintIds." },
    expectedOutputs: { type: "array", items: expectedBuildOutputSchema }
  },
  required: ["description", "components", "relationships", "parameters", "material", "manufacturingIntent", "relevantRequirementIds", "relevantConstraintIds", "expectedOutputs"],
  additionalProperties: false
};

interface RawDesignComponentOutput {
  id: string;
  name: string;
  type: string;
  geometryIntent: string;
  dimensions: Record<string, unknown>;
  parentComponentId: string | null;
}

interface RawDesignRelationshipOutput {
  id: string;
  type: string;
  sourceComponentId: string;
  targetComponentId: string;
}

interface RawExpectedBuildOutput {
  id: string;
  componentId: string;
  environmentObjectType: string;
  environmentGenericType: string | null;
  properties: Record<string, unknown>;
}

interface RawDesignGenerationOutput {
  description: string;
  components: RawDesignComponentOutput[];
  relationships: RawDesignRelationshipOutput[];
  parameters: Record<string, unknown>;
  material: string | null;
  manufacturingIntent: string | null;
  relevantRequirementIds: string[];
  relevantConstraintIds: string[];
  expectedOutputs: RawExpectedBuildOutput[];
}

function isRawDesignGenerationOutput(value: unknown): value is RawDesignGenerationOutput {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.description === "string" &&
    Array.isArray(record.components) &&
    Array.isArray(record.relationships) &&
    typeof record.parameters === "object" &&
    record.parameters !== null &&
    Array.isArray(record.relevantRequirementIds) &&
    Array.isArray(record.relevantConstraintIds) &&
    Array.isArray(record.expectedOutputs)
  );
}

function summarizeRequirements(requirements: readonly Requirement[]): string {
  if (requirements.length === 0) return "Requirements: none.";
  const lines = requirements.map((r) => `  - ${r.id}: ${r.description} (category=${r.category}, value=${JSON.stringify(r.value)}, unit=${JSON.stringify(r.unit)})`);
  return `Requirements:\n${lines.join("\n")}`;
}

function summarizeConstraints(constraints: readonly Constraint[]): string {
  if (constraints.length === 0) return "Constraints: none.";
  const lines = constraints.map((c) => `  - ${c.id}: ${c.description} (severity=${c.severity}, value=${JSON.stringify(c.value)}, unit=${JSON.stringify(c.unit)})`);
  return `Constraints:\n${lines.join("\n")}`;
}

function buildDesignInstruction(plan: Plan, step: PlanStep, requirements: readonly Requirement[], constraints: readonly Constraint[], additionalInstruction?: string): string {
  const lines = [
    `Objective: ${plan.objectiveSummary}`,
    "",
    `Plan step to realize: "${step.title}"`,
    `Step description: ${step.description}`,
    `Step purpose: ${step.purpose}`,
    "",
    `This step is already known to relate to requirements: [${step.relevantRequirementIds.join(", ")}]`,
    `and constraints: [${step.relevantConstraintIds.join(", ")}]`,
    "",
    summarizeRequirements(requirements),
    "",
    summarizeConstraints(constraints),
    "",
    "Propose a structured design specification (components + expected build outputs) that would realize this step, based only on the information above."
  ];
  if (additionalInstruction) lines.push("", additionalInstruction);
  return lines.join("\n");
}

function buildDesignModelContext(plan: Plan): ModelContext {
  return createModelContext({ projectId: plan.projectId, objectiveSummary: plan.objectiveSummary });
}

export interface GenerateDesignSpecificationOptions {
  additionalInstruction?: string;
  config: ModelRequestConfigInput;
  sessionId?: string | null;
}

export type DesignGenerationResult =
  | { status: "success"; design: DesignSpecification }
  | { status: "error"; error: { kind: DesignGenerationErrorKind; message: string } };

/**
 * A `Plan` + one of its `PlanStep`s + the project's `Requirement`s/
 * `Constraint`s -> a validated, semantically-checked `DesignSpecification`.
 * Never throws for an expected failure mode -- the same discipline
 * `generateProposal` already established: a caller branches on
 * `result.status`, never wraps this in try/catch.
 */
export async function generateDesignSpecification(
  provider: ModelProvider,
  plan: Plan,
  planStepId: string,
  requirements: readonly Requirement[],
  constraints: readonly Constraint[],
  options: GenerateDesignSpecificationOptions
): Promise<DesignGenerationResult> {
  let request;
  let step: PlanStep;
  try {
    assertPlan(plan);
    const found = plan.steps.find((candidate) => candidate.id === planStepId);
    if (!found) {
      return { status: "error", error: { kind: "invalid_input", message: `No step with id "${planStepId}" exists in plan "${plan.id}"` } };
    }
    step = found;
    request = createModelRequest({
      systemInstruction: DESIGN_SYSTEM_INSTRUCTION,
      context: buildDesignModelContext(plan),
      instruction: buildDesignInstruction(plan, step, requirements, constraints, options.additionalInstruction),
      outputSchema: designGenerationOutputSchema,
      config: options.config,
      sessionId: options.sessionId ?? null
    });
  } catch (error) {
    return { status: "error", error: { kind: "invalid_input", message: error instanceof Error ? error.message : String(error) } };
  }

  const invocation = await provider.generate(request);
  if (invocation.status === "error" || !invocation.response) {
    return { status: "error", error: { kind: "model_unavailable", message: invocation.error?.message ?? "Model provider returned no response" } };
  }

  const response = invocation.response;
  if (response.kind !== "structured_result" || !isRawDesignGenerationOutput(response.structuredResult)) {
    return { status: "error", error: { kind: "invalid_model_output", message: `Expected a structured design result, got response kind "${response.kind}"` } };
  }

  const raw: RawDesignGenerationOutput = response.structuredResult;

  let design: DesignSpecification;
  try {
    design = createDesignSpecification({
      projectId: plan.projectId,
      projectVersion: plan.projectVersion,
      planId: plan.id,
      planStepId: step.id,
      objectiveSummary: plan.objectiveSummary,
      description: raw.description,
      components: raw.components.map((component) => ({
        id: component.id,
        name: component.name,
        type: component.type,
        geometryIntent: component.geometryIntent,
        dimensions: Object.fromEntries(Object.entries(component.dimensions).filter(([, value]) => typeof value === "number")) as Record<string, number>,
        parentComponentId: component.parentComponentId
      })),
      relationships: raw.relationships,
      parameters: raw.parameters,
      material: raw.material,
      manufacturingIntent: raw.manufacturingIntent,
      relevantRequirementIds: raw.relevantRequirementIds,
      relevantConstraintIds: raw.relevantConstraintIds,
      expectedOutputs: raw.expectedOutputs.map((output) => ({
        id: output.id,
        componentId: output.componentId,
        environmentObjectType: output.environmentObjectType,
        environmentGenericType: output.environmentGenericType as EnvironmentObjectGenericType | null,
        properties: output.properties
      })),
      source: "agent"
    });
  } catch (error) {
    return { status: "error", error: { kind: "malformed_design_shape", message: error instanceof Error ? error.message : String(error) } };
  }

  const issues = validateDesignSpecificationSemantics(design, plan);
  if (issues.length > 0) {
    return { status: "error", error: { kind: "semantic_validation_failed", message: issues.map((issue) => issue.message).join("; ") } };
  }

  return { status: "success", design };
}
