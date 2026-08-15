import { createTool, ObservationError, ToolError, type ModelRequestConfigInput, type Tool, type ToolValueSchema, type WorldModelState } from "@naqsh/schemas";
import { observeProject, type ObserveProjectOptions } from "./observe-project.js";
import type { ModelProvider } from "./model-provider.js";
import { generatePlanProposal, type GeneratePlanOptions } from "./planner.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * The first agent-facing, PRODUCTION planning tool (P9). Registered and
 * executed the normal way (`registry.register(tool, handler)`,
 * `executeTool`) — nothing about this tool's plumbing is special. What
 * makes it "the planning tool" is entirely its `mutation: "suggest"`
 * classification (it reasons and proposes, exactly like `AutonomyLevel`'s
 * own doc comment defines that tier: "may also reason/propose (still zero
 * mutation)") and a handler that only ever calls `observeProject` (read)
 * and `generatePlanProposal` (pure orchestration over a `ModelProvider`) —
 * it has no write path into `WorldModelState`, no `EnvironmentAdapter`, and
 * no ability to execute another tool. There is nothing for a future
 * `authorize` hook or P4 policy to gate beyond the classification itself,
 * the same reasoning `observation-tool.ts` documents for `mutation:
 * "observe"`.
 *
 * `getState`/`provider` are explicit accessors/collaborators, not
 * captured/global references — this repository has no singleton "current
 * world model" or "current model provider," and this tool does not
 * introduce one. Whoever wires this tool into a real `ToolRegistry` (a
 * future P11 orchestration layer) supplies both.
 */

const planStepOutputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    order: { type: "number" },
    title: { type: "string" },
    description: { type: "string" },
    purpose: { type: "string" },
    dependsOn: { type: "array", items: { type: "string" } },
    inputs: { type: "array", items: { type: "string" } },
    expectedOutputs: { type: "array", items: { type: "string" } },
    relevantRequirementIds: { type: "array", items: { type: "string" } },
    relevantConstraintIds: { type: "array", items: { type: "string" } },
    relevantObjectIds: { type: "array", items: { type: "string" } },
    relevantDecisionIds: { type: "array", items: { type: "string" } },
    verificationIntent: { type: "string", nullable: true },
    assumptionIds: { type: "array", items: { type: "string" } },
    status: { type: "string", enum: ["pending", "in_progress", "complete", "blocked", "skipped"] },
    metadata: { type: "object", properties: {}, additionalProperties: true }
  },
  required: [
    "id",
    "order",
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
    "assumptionIds",
    "status",
    "metadata"
  ]
};

const planAssumptionOutputSchema: ToolValueSchema = {
  type: "object",
  properties: { id: { type: "string" }, description: { type: "string" }, rationale: { type: "string" } },
  required: ["id", "description", "rationale"]
};

const planQuestionOutputSchema: ToolValueSchema = {
  type: "object",
  properties: { id: { type: "string" }, question: { type: "string" }, reason: { type: "string" } },
  required: ["id", "question", "reason"]
};

const planRiskOutputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    description: { type: "string" },
    impact: { type: "string" },
    severity: { type: "string", enum: ["low", "medium", "high"] }
  },
  required: ["id", "description", "impact", "severity"]
};

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    scope: {
      type: "string",
      enum: ["project", "focus", "object"],
      description:
        'What portion of the project to plan against, mirroring observe_project\'s scopes. "project" (default) plans against the whole project.'
    },
    objectId: { type: "string", description: 'Required when scope is "object"; ignored otherwise.' },
    additionalInstruction: { type: "string", description: "Optional extra guidance for the planner (e.g. 'prioritize manufacturability')." },
    modelId: { type: "string", description: "Which model to use for plan generation." }
  },
  required: ["modelId"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    projectId: { type: "string" },
    projectVersion: { type: "number" },
    observationId: { type: "string" },
    objectiveSummary: { type: "string" },
    status: { type: "string", enum: ["draft", "proposed", "approved", "executing", "completed", "rejected", "superseded"] },
    steps: { type: "array", items: planStepOutputSchema },
    assumptions: { type: "array", items: planAssumptionOutputSchema },
    unresolvedQuestions: { type: "array", items: planQuestionOutputSchema },
    risks: { type: "array", items: planRiskOutputSchema },
    missingInformation: { type: "array", items: { type: "string" } },
    supersedesPlanId: { type: "string", nullable: true },
    version: { type: "number" },
    source: { type: "string" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    metadata: { type: "object", properties: {}, additionalProperties: true }
  },
  required: [
    "id",
    "projectId",
    "projectVersion",
    "observationId",
    "objectiveSummary",
    "status",
    "steps",
    "assumptions",
    "unresolvedQuestions",
    "risks",
    "missingInformation",
    "supersedesPlanId",
    "version",
    "source",
    "createdAt",
    "updatedAt",
    "metadata"
  ]
};

function toObserveProjectOptions(input: unknown): ObserveProjectOptions {
  const record = input as { scope?: unknown; objectId?: unknown };
  if (record.scope === "object") {
    if (typeof record.objectId !== "string" || record.objectId.trim().length === 0) {
      throw new ToolError("invalid_input", 'objectId is required and must be a non-empty string when scope is "object"');
    }
    return { scope: "object", objectId: record.objectId };
  }
  if (record.scope === "focus") {
    return { scope: "focus" };
  }
  return { scope: "project" };
}

function toGeneratePlanOptions(input: unknown): GeneratePlanOptions {
  const record = input as { modelId?: unknown; additionalInstruction?: unknown };
  if (typeof record.modelId !== "string" || record.modelId.trim().length === 0) {
    throw new ToolError("invalid_input", "modelId is required and must be a non-empty string");
  }
  const config: ModelRequestConfigInput = { modelId: record.modelId };
  const additionalInstruction = typeof record.additionalInstruction === "string" ? record.additionalInstruction : undefined;
  return additionalInstruction ? { config, additionalInstruction } : { config };
}

export function createPlanningTool(getState: () => WorldModelState, provider: ModelProvider): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "create_plan",
    description:
      "Generates a structured, inspectable, NON-EXECUTING engineering plan for the current project's objective, based on a deterministic observation of the current World Model state. Never mutates project state, never executes a tool, never modifies CAD.",
    target: "world_model",
    mutation: "suggest",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = async (input) => {
    const observeOptions = toObserveProjectOptions(input);
    const planOptions = toGeneratePlanOptions(input);
    let observation;
    try {
      observation = observeProject(getState(), observeOptions);
    } catch (error) {
      if (error instanceof ObservationError) {
        throw new ToolError("invalid_input", error.message);
      }
      throw error;
    }
    const result = await generatePlanProposal(provider, observation, planOptions);
    if (result.status === "error") {
      const toolErrorKind = result.error.kind === "invalid_input" ? "invalid_input" : result.error.kind === "model_unavailable" ? "unavailable" : "execution_failure";
      throw new ToolError(toolErrorKind, result.error.message);
    }
    return result.plan;
  };

  return { tool, handler };
}
