import { createTool, ToolError, type ModelRequestConfigInput, type Tool, type ToolValueSchema, type WorldModelState } from "@naqsh/schemas";
import type { ModelProvider } from "./model-provider.js";
import { interpretRequirementFromText, type InterpretRequirementOptions } from "./requirement-interpreter.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * The agent-facing wrapper around `interpretRequirementFromText` (P18) --
 * mirrors `create_proposal`'s (P10) exact shape and reasoning. Classified
 * `mutation: "suggest"` -- the same permission tier `create_plan`/
 * `create_proposal` use, for the identical reason: interpreting text into
 * a candidate is a reasoned-about, PROPOSED structure, not an applied one.
 * The handler has no write path: it calls only `interpretRequirementFromText`
 * (pure orchestration over an injected `ModelProvider` and a read-only
 * `getState`) -- never `executeTool`, never `invokeRegisteredTool`, never
 * `updateWorldModel`.
 *
 * There is deliberately no path from THIS tool to a real `Requirement`.
 * That is `add_requirement`'s (this phase's OTHER new tool) job, and it is
 * classified as a real MUTATION -- gated by the exact same P3/P4
 * approval boundary every other mutation goes through. Interpreting text
 * must never be able to reach the World Model through this or any other
 * tool.
 */

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    statementText: { type: "string", description: "The user's natural-language engineering requirement statement." },
    modelId: { type: "string", description: "Which model to use for interpretation." }
  },
  required: ["statementText", "modelId"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    projectId: { type: "string" },
    projectVersion: { type: "number" },
    statementText: { type: "string" },
    description: { type: "string" },
    category: { type: "string" },
    operator: { type: "string", nullable: true },
    value: { type: "number", nullable: true },
    unit: { type: "string", nullable: true },
    interpretationStatus: { type: "string", enum: ["specific", "ambiguous"] },
    ambiguityReason: { type: "string", nullable: true },
    priority: { type: "string" },
    source: { type: "string" },
    createdAt: { type: "string" },
    metadata: { type: "object", properties: {}, additionalProperties: true }
  },
  required: [
    "id",
    "projectId",
    "projectVersion",
    "statementText",
    "description",
    "category",
    "operator",
    "value",
    "unit",
    "interpretationStatus",
    "ambiguityReason",
    "priority",
    "source",
    "createdAt",
    "metadata"
  ]
};

function toInterpretRequirementInput(input: unknown): { statementText: string; options: InterpretRequirementOptions } {
  const record = input as { statementText?: unknown; modelId?: unknown };
  if (typeof record.statementText !== "string" || record.statementText.trim().length === 0) {
    throw new ToolError("invalid_input", "statementText is required and must be a non-empty string");
  }
  if (typeof record.modelId !== "string" || record.modelId.trim().length === 0) {
    throw new ToolError("invalid_input", "modelId is required and must be a non-empty string");
  }
  const config: ModelRequestConfigInput = { modelId: record.modelId };
  return { statementText: record.statementText, options: { config } };
}

export function createInterpretRequirementTool(getState: () => WorldModelState, provider: ModelProvider): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "interpret_requirement",
    description:
      "Interprets a natural-language engineering requirement statement into a structured, inspectable RequirementCandidate -- never a real Requirement. Ambiguous/underspecified statements are represented honestly (interpretationStatus: 'ambiguous') rather than assigned an invented numeric threshold. Never mutates project state; requires add_requirement (a separate, approval-gated tool) before anything becomes part of the World Model.",
    target: "world_model",
    mutation: "suggest",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = async (rawInput) => {
    const { statementText, options } = toInterpretRequirementInput(rawInput);
    const result = await interpretRequirementFromText(provider, getState(), statementText, options);
    if (result.status === "error") {
      const toolErrorKind =
        result.error.kind === "invalid_input" ? "invalid_input" : result.error.kind === "model_unavailable" ? "unavailable" : "execution_failure";
      throw new ToolError(toolErrorKind, result.error.message);
    }
    return result.candidate;
  };

  return { tool, handler };
}
