import {
  assertPlan,
  createTool,
  WorldModelValidationError,
  ToolError,
  type ModelRequestConfigInput,
  type Plan,
  type Tool,
  type ToolValueSchema
} from "@naqsh/schemas";
import type { ModelProvider } from "./model-provider.js";
import type { ToolRegistry } from "./tool-registry.js";
import { generateProposal, type GenerateProposalOptions } from "./proposal-generator.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * The second agent-facing, PRODUCTION tool this repository adds after P8's
 * `observe_project` and P9's `create_plan` (P10). Registered and executed
 * the normal way; classified `mutation: "suggest"` — the same permission
 * tier `create_plan` uses, and for the identical reason: a proposal is a
 * reasoned-about, PROPOSED action, not an applied one. There is nothing
 * for a future `authorize` hook or P4 policy to gate beyond the
 * classification itself, since the handler has no write path: it calls
 * only `generateProposal` (pure orchestration over an injected
 * `ModelProvider` and a read-only `ToolRegistry` lookup) — never
 * `executeTool`, never `invokeRegisteredTool`, never `updateWorldModel`.
 *
 * There is deliberately no `execute_proposal` tool anywhere in this
 * repository. That is Phase 11's job — creating a proposal must never be
 * able to reach execution through this or any other tool.
 *
 * `registry`/`provider` are explicit collaborators, not captured/global
 * references, matching `create_plan`'s own convention. Unlike
 * `create_plan`, this tool takes no `getState` — a `Proposal` is realized
 * from an already-generated `Plan` value the caller supplies directly (no
 * `PlanStore` exists yet — see `plan-tool.ts`'s and the README's own notes
 * on this deferral), not from live `WorldModelState`.
 */

const changeTargetOutputSchema: ToolValueSchema = {
  type: "object",
  nullable: true,
  properties: {
    entityType: { type: "string" },
    entityId: { type: "string", nullable: true }
  },
  required: ["entityType", "entityId"]
};

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    plan: {
      type: "object",
      properties: {},
      additionalProperties: true,
      description: "The full Plan (P9) this proposal realizes one step of. Deep-validated by this tool's handler."
    },
    planStepId: { type: "string", description: "id of the PlanStep (within `plan`) this proposal should realize." },
    additionalInstruction: { type: "string", description: "Optional extra guidance for the proposal generator." },
    modelId: { type: "string", description: "Which model to use for proposal generation." }
  },
  required: ["plan", "planStepId", "modelId"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    projectId: { type: "string" },
    projectVersion: { type: "number" },
    planId: { type: "string" },
    planStepId: { type: "string" },
    objectiveSummary: { type: "string" },
    toolName: { type: "string" },
    toolTarget: {
      type: "string",
      enum: ["world_model", "environment", "verification", "research", "simulation", "robotics", "eda"]
    },
    input: { type: "object", properties: {}, additionalProperties: true },
    target: changeTargetOutputSchema,
    rationale: { type: "string" },
    expectedEffect: { type: "string" },
    relevantRequirementIds: { type: "array", items: { type: "string" } },
    relevantConstraintIds: { type: "array", items: { type: "string" } },
    status: { type: "string", enum: ["proposed", "approved", "rejected", "executed", "superseded"] },
    supersedesProposalId: { type: "string", nullable: true },
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
    "planId",
    "planStepId",
    "objectiveSummary",
    "toolName",
    "toolTarget",
    "input",
    "target",
    "rationale",
    "expectedEffect",
    "relevantRequirementIds",
    "relevantConstraintIds",
    "status",
    "supersedesProposalId",
    "version",
    "source",
    "createdAt",
    "updatedAt",
    "metadata"
  ]
};

function toGenerateProposalInput(input: unknown): { plan: Plan; planStepId: string; options: GenerateProposalOptions } {
  const record = input as { plan?: unknown; planStepId?: unknown; additionalInstruction?: unknown; modelId?: unknown };
  if (typeof record.modelId !== "string" || record.modelId.trim().length === 0) {
    throw new ToolError("invalid_input", "modelId is required and must be a non-empty string");
  }
  if (typeof record.planStepId !== "string" || record.planStepId.trim().length === 0) {
    throw new ToolError("invalid_input", "planStepId is required and must be a non-empty string");
  }
  try {
    assertPlan(record.plan);
  } catch (error) {
    if (error instanceof WorldModelValidationError) {
      throw new ToolError("invalid_input", `plan is invalid: ${error.message}`);
    }
    throw error;
  }
  const config: ModelRequestConfigInput = { modelId: record.modelId };
  const additionalInstruction = typeof record.additionalInstruction === "string" ? record.additionalInstruction : undefined;
  const options: GenerateProposalOptions = additionalInstruction ? { config, additionalInstruction } : { config };
  return { plan: record.plan, planStepId: record.planStepId, options };
}

export function createProposalTool(registry: ToolRegistry, provider: ModelProvider): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "create_proposal",
    description:
      "Generates a concrete, inspectable, NON-EXECUTING proposal for how to realize one step of an already-generated Plan (P9) -- a specific tool call NAQSH proposes making, and why. Never mutates project state, never executes a tool, never modifies CAD or any environment. Requires human approval (a later phase) before anything happens.",
    target: "world_model",
    mutation: "suggest",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = async (input) => {
    const { plan, planStepId, options } = toGenerateProposalInput(input);
    const result = await generateProposal(provider, registry, plan, planStepId, options);
    if (result.status === "error") {
      const toolErrorKind =
        result.error.kind === "invalid_input" ? "invalid_input" : result.error.kind === "model_unavailable" ? "unavailable" : "execution_failure";
      throw new ToolError(toolErrorKind, result.error.message);
    }
    return result.proposal;
  };

  return { tool, handler };
}
