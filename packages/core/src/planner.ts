import {
  assertObservationResult,
  createId,
  createModelContext,
  createModelRequest,
  createPlan,
  type ModelContext,
  type ModelRequestConfigInput,
  type ObservationResult,
  type Plan,
  type PlanGenerationErrorKind,
  type PlanRiskSeverity,
  type PlanStepInput,
  type ToolValueSchema
} from "@naqsh/schemas";
import type { ModelProvider } from "./model-provider.js";
import { validatePlanSemantics } from "./plan-semantics.js";

/**
 * Objective -> Plan (P9).
 *
 * The core flow this file implements is:
 *
 *   ObservationResult -> ModelRequest -> ModelProvider.generate() ->
 *   structured output -> shape validation -> id remapping ->
 *   semantic validation -> Plan
 *
 * NEVER `WorldModelState -> Plan` directly: `generatePlanProposal` takes an
 * already-built `ObservationResult` (P8), never `WorldModelState` — the
 * caller must observe first, exactly the boundary the P9 brief requires
 * ("the planner should consume structured observation rather than
 * directly rummaging through arbitrary World Model state"). This file has
 * no import of `updateWorldModel`/`ChangeHistory`/`recordTransition`, no
 * import of `EnvironmentAdapter`/`@naqsh/adapters`, and no import of
 * `@naqsh/model-providers`/`@google/genai` — all enforced as
 * repo-boundaries regression tests, mirroring P8's identical guards.
 * Generating a plan cannot mutate the World Model because nothing in this
 * file ever holds a reference to anything that could.
 *
 * Gemini's output is never automatically authoritative: `provider.generate()`
 * already runs `validateStructuredResult` (schema conformance) before ever
 * returning `status: "success"` — but that only proves the JSON has the
 * right SHAPE. This file adds two more layers before anything is called a
 * `Plan`: reassembling the shape into real schema-validated domain objects
 * (`createPlan`/`createPlanStep`/... — `assertPlan` and friends), and then
 * `validatePlanSemantics` (plan-semantics.ts) — the check that catches a
 * structurally-valid plan that references a requirement/object/constraint/
 * decision id that doesn't exist in the observation it was built from, or
 * a step dependency cycle. A plan that fails either layer is REJECTED
 * (`status: "error"`), never silently repaired.
 */

const PLANNING_SYSTEM_INSTRUCTION =
  "You are NAQSH's engineering planner. You propose a structured, non-executing plan for how to accomplish an " +
  "engineering objective, given exactly the project information you are shown. You do not execute anything, " +
  "you do not modify CAD, and you do not decide anything on your own authority -- a human reviews everything you " +
  "propose. Rules that must never be broken: (1) every requirement/constraint/object/decision id you reference " +
  "must be copied EXACTLY from the lists you are given -- never invent one, never reference one that isn't listed. " +
  "(2) If information you would need to plan confidently is missing, record it as an unresolved question or an " +
  "assumption -- never state something as fact that isn't already known. (3) Every step id you assign must be " +
  "unique within your response, and every dependsOn/assumptionRef must refer to an id you yourself assigned in " +
  "this same response.";

const planStepOutputSchema: ToolValueSchema = {
  type: "object",
  description: "One engineering step in the plan.",
  properties: {
    id: { type: "string", description: "A short, unique label for this step (e.g. 'clarify-load'). Referenced by other steps' dependsOn." },
    title: { type: "string" },
    description: { type: "string" },
    purpose: { type: "string", description: "Why this step matters for the objective." },
    dependsOn: { type: "array", items: { type: "string" }, description: "ids (from this response's own steps) that must happen first." },
    inputs: { type: "array", items: { type: "string" } },
    expectedOutputs: { type: "array", items: { type: "string" } },
    relevantRequirementIds: {
      type: "array",
      items: { type: "string" },
      description: "Only ids copied exactly from the provided Requirements list. Never invent one."
    },
    relevantConstraintIds: { type: "array", items: { type: "string" }, description: "Only ids copied exactly from the provided Constraints list." },
    relevantObjectIds: { type: "array", items: { type: "string" }, description: "Only ids copied exactly from the provided Objects list." },
    relevantDecisionIds: { type: "array", items: { type: "string" }, description: "Only ids copied exactly from the provided Decisions list." },
    verificationIntent: { type: "string", nullable: true, description: "What 'done correctly' means for this step, or null." },
    assumptionRefs: { type: "array", items: { type: "string" }, description: "ids (from this response's own assumptions) this step relies on." }
  },
  required: [
    "id",
    "title",
    "description",
    "purpose",
    "dependsOn",
    "inputs",
    "expectedOutputs",
    "relevantRequirementIds",
    "relevantConstraintIds",
    "relevantObjectIds",
    "relevantDecisionIds",
    "verificationIntent",
    "assumptionRefs"
  ],
  additionalProperties: false
};

const planAssumptionOutputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "A short, unique label for this assumption. Referenced by steps' assumptionRefs." },
    description: { type: "string" },
    rationale: { type: "string" }
  },
  required: ["id", "description", "rationale"],
  additionalProperties: false
};

const planQuestionOutputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    question: { type: "string" },
    reason: { type: "string" }
  },
  required: ["id", "question", "reason"],
  additionalProperties: false
};

const planRiskOutputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    description: { type: "string" },
    impact: { type: "string" },
    severity: { type: "string", enum: ["low", "medium", "high"] }
  },
  required: ["id", "description", "impact", "severity"],
  additionalProperties: false
};

/** What the model is asked to produce — deliberately NOT the full `Plan`
 * shape: `id`/`projectId`/`projectVersion`/`observationId`/`status`/
 * `createdAt`/etc are provenance/identity fields this application controls
 * itself (see `generatePlanProposal`), never trusted from model output —
 * the same reasoning `observeProject` stamps `source`/`observedAt` itself
 * rather than accepting them as input. */
const planGenerationOutputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    steps: { type: "array", items: planStepOutputSchema },
    assumptions: { type: "array", items: planAssumptionOutputSchema },
    unresolvedQuestions: { type: "array", items: planQuestionOutputSchema },
    risks: { type: "array", items: planRiskOutputSchema },
    additionalMissingInformation: {
      type: "array",
      items: { type: "string" },
      description: "Structural gaps you identified that are not already listed as known missing information."
    }
  },
  required: ["steps", "assumptions", "unresolvedQuestions", "risks", "additionalMissingInformation"],
  additionalProperties: false
};

interface RawPlanStepOutput {
  id: string;
  title: string;
  description: string;
  purpose: string;
  dependsOn: string[];
  inputs: string[];
  expectedOutputs: string[];
  relevantRequirementIds: string[];
  relevantConstraintIds: string[];
  relevantObjectIds: string[];
  relevantDecisionIds: string[];
  verificationIntent: string | null;
  assumptionRefs: string[];
}

interface RawPlanAssumptionOutput {
  id: string;
  description: string;
  rationale: string;
}

interface RawPlanQuestionOutput {
  id: string;
  question: string;
  reason: string;
}

interface RawPlanRiskOutput {
  id: string;
  description: string;
  impact: string;
  severity: string;
}

interface RawPlanGenerationOutput {
  steps: RawPlanStepOutput[];
  assumptions: RawPlanAssumptionOutput[];
  unresolvedQuestions: RawPlanQuestionOutput[];
  risks: RawPlanRiskOutput[];
  additionalMissingInformation: string[];
}

function isRawPlanGenerationOutput(value: unknown): value is RawPlanGenerationOutput {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.steps) &&
    Array.isArray(record.assumptions) &&
    Array.isArray(record.unresolvedQuestions) &&
    Array.isArray(record.risks) &&
    Array.isArray(record.additionalMissingInformation)
  );
}

function summarizeEntityList(label: string, items: readonly object[], idField: string, fields: readonly string[]): string {
  if (items.length === 0) return `${label}: none.`;
  const lines = items.map((entity) => {
    const item = entity as Record<string, unknown>;
    const parts = fields.map((field) => `${field}=${JSON.stringify(item[field])}`).join(", ");
    return `  - ${String(item[idField])}: ${parts}`;
  });
  return `${label}:\n${lines.join("\n")}`;
}

/** Everything the model needs to accurately reference real project data by
 * id, rendered as plain text embedded in the instruction (not a separate
 * structured field — `ModelRequest.context` stays the same bounded,
 * counts-only summary P7 already established; the DETAILED, id-labeled
 * entity list belongs in the task-specific instruction text, not in the
 * generic context shape every model call carries). */
function buildPlanningInstruction(observation: ObservationResult, additionalInstruction?: string): string {
  const objective = observation.objectiveSummary ?? "(no objective has been defined yet for this project)";
  const lines = [
    `Objective: ${objective}`,
    "",
    "Produce a structured engineering plan to accomplish this objective, based only on the project information below.",
    "",
    summarizeEntityList("Requirements", observation.requirements, "id", ["description", "category", "priority", "status"]),
    "",
    summarizeEntityList("Constraints", observation.constraints, "id", ["description", "category", "severity", "status"]),
    "",
    summarizeEntityList("Objects", observation.objects, "id", ["type", "name", "description"]),
    "",
    summarizeEntityList("Decisions", observation.decisions, "id", ["statement", "reason"]),
    "",
    observation.missingInformation.length > 0
      ? `Already-known missing information:\n${observation.missingInformation.map((entry) => `  - ${entry}`).join("\n")}`
      : "Already-known missing information: none."
  ];
  if (additionalInstruction) lines.push("", additionalInstruction);
  return lines.join("\n");
}

function buildPlanningModelContext(observation: ObservationResult): ModelContext {
  return createModelContext({
    projectId: observation.projectId,
    objectiveSummary: observation.objectiveSummary,
    requirementCount: observation.requirements.length,
    constraintCount: observation.constraints.length,
    objectCount: observation.objects.length,
    decisionCount: observation.decisions.length,
    sessionMode: observation.sessionMode,
    focusObjectIds: observation.focusObjectIds
  });
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Rebuilds the model's own local step/assumption id labels into NAQSH's
 * canonical `createId` format, rewriting every `dependsOn`/`assumptionRefs`
 * reference to match. A reference that doesn't resolve to one of the
 * model's OWN declared ids is passed through UNCHANGED rather than
 * dropped — silently filtering it out would be exactly the "silently
 * repair fabricated model output" the P9 brief forbids. Left unresolved,
 * it fails `validatePlanSemantics`'s `unknown_dependency`/
 * `unknown_assumption_reference` check instead, which is the correct,
 * visible rejection path.
 */
function remapStepIds(rawSteps: readonly RawPlanStepOutput[], assumptionIdMap: ReadonlyMap<string, string>): PlanStepInput[] {
  const stepIdMap = new Map<string, string>();
  for (const step of rawSteps) {
    if (!stepIdMap.has(step.id)) stepIdMap.set(step.id, createId("planstep"));
  }
  return rawSteps.map((step, index) => ({
    id: stepIdMap.get(step.id),
    order: index,
    title: step.title,
    description: step.description,
    purpose: step.purpose,
    dependsOn: step.dependsOn.map((depId) => stepIdMap.get(depId) ?? depId),
    inputs: step.inputs,
    expectedOutputs: step.expectedOutputs,
    relevantRequirementIds: step.relevantRequirementIds,
    relevantConstraintIds: step.relevantConstraintIds,
    relevantObjectIds: step.relevantObjectIds,
    relevantDecisionIds: step.relevantDecisionIds,
    verificationIntent: step.verificationIntent,
    assumptionIds: step.assumptionRefs.map((ref) => assumptionIdMap.get(ref) ?? ref)
  }));
}

export interface GeneratePlanOptions {
  /** Extra guidance appended to the instruction sent to the model (e.g.
   * "prioritize manufacturability over cost"). Optional. */
  additionalInstruction?: string;
  /** Forwarded to `ModelRequest.config`. `modelId` has no sensible
   * core-level default (core is provider-agnostic — see `ModelProvider`'s
   * doc comment), so the caller must supply one. */
  config: ModelRequestConfigInput;
  sessionId?: string | null;
}

export type PlanGenerationResult = { status: "success"; plan: Plan } | { status: "error"; error: { kind: PlanGenerationErrorKind; message: string } };

/**
 * Objective + structured observation -> a validated, semantically-checked
 * `Plan` proposal. Never throws for an expected failure mode — the same
 * discipline `ModelProvider.generate()`/`EnvironmentAdapter`/`executeTool`
 * already established: a caller branches on `result.status`, never wraps
 * this in try/catch. `observation` is the plan's entire view of the
 * project — this function never reaches for `WorldModelState` itself.
 */
export async function generatePlanProposal(
  provider: ModelProvider,
  observation: ObservationResult,
  options: GeneratePlanOptions
): Promise<PlanGenerationResult> {
  let request;
  try {
    assertObservationResult(observation);
    request = createModelRequest({
      systemInstruction: PLANNING_SYSTEM_INSTRUCTION,
      context: buildPlanningModelContext(observation),
      instruction: buildPlanningInstruction(observation, options.additionalInstruction),
      outputSchema: planGenerationOutputSchema,
      config: options.config,
      sessionId: options.sessionId ?? null
    });
  } catch (error) {
    // Covers both a malformed `observation` and a malformed `options`
    // (e.g. an empty `config.modelId`) -- both are caller-supplied input,
    // and this function never throws for an expected failure mode, the
    // same discipline `executeTool`/`ModelProvider.generate()` already
    // established: a caller branches on `result.status`, never wraps this
    // call in try/catch.
    return { status: "error", error: { kind: "invalid_input", message: error instanceof Error ? error.message : String(error) } };
  }

  const invocation = await provider.generate(request);
  if (invocation.status === "error" || !invocation.response) {
    return {
      status: "error",
      error: { kind: "model_unavailable", message: invocation.error?.message ?? "Model provider returned no response" }
    };
  }

  const response = invocation.response;
  if (response.kind !== "structured_result" || !isRawPlanGenerationOutput(response.structuredResult)) {
    return {
      status: "error",
      error: {
        kind: "invalid_model_output",
        message: `Expected a structured plan-generation result, got response kind "${response.kind}"`
      }
    };
  }

  const raw: RawPlanGenerationOutput = response.structuredResult;

  let plan: Plan;
  try {
    // Reassembling the model's raw output (id remapping, then `createPlan`)
    // is ALL inside this one try/catch, not just `createPlan` itself: a
    // `ModelProvider` implementation is contractually required to validate
    // its own structured output against `outputSchema` before ever
    // returning `status: "success"` (every provider in this repo does),
    // but `generatePlanProposal` must not simply trust that a THIRD-PARTY
    // provider actually did — this is exactly the "never treat the model
    // (or the boundary around it) as automatically authoritative"
    // principle applied to the provider contract itself, not just the
    // model's content. Without this, a non-compliant provider returning a
    // malformed step (e.g. missing `dependsOn`) would throw an uncaught
    // TypeError out of the id-remapping `.map()` calls below, breaking
    // this function's own "never throws for an expected failure" contract.
    const assumptionIdMap = new Map<string, string>();
    const assumptions = raw.assumptions.map((assumption: RawPlanAssumptionOutput) => {
      const canonicalId = createId("planasm");
      if (!assumptionIdMap.has(assumption.id)) assumptionIdMap.set(assumption.id, canonicalId);
      return { id: assumptionIdMap.get(assumption.id), description: assumption.description, rationale: assumption.rationale };
    });
    const steps = remapStepIds(raw.steps, assumptionIdMap);

    plan = createPlan({
      projectId: observation.projectId,
      projectVersion: observation.projectVersion,
      observationId: observation.id,
      objectiveSummary: observation.objectiveSummary ?? "",
      status: "proposed",
      steps,
      assumptions,
      unresolvedQuestions: raw.unresolvedQuestions.map((question: RawPlanQuestionOutput) => ({ question: question.question, reason: question.reason })),
      risks: raw.risks.map((risk: RawPlanRiskOutput) => ({ description: risk.description, impact: risk.impact, severity: risk.severity as PlanRiskSeverity })),
      missingInformation: dedupeStrings([...observation.missingInformation, ...raw.additionalMissingInformation]),
      source: "agent"
    });
  } catch (error) {
    return { status: "error", error: { kind: "malformed_plan_shape", message: error instanceof Error ? error.message : String(error) } };
  }

  const issues = validatePlanSemantics(plan, observation);
  if (issues.length > 0) {
    return {
      status: "error",
      error: { kind: "semantic_validation_failed", message: issues.map((issue) => issue.message).join("; ") }
    };
  }

  return { status: "success", plan };
}
