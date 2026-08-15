import {
  assertPlan,
  createModelContext,
  createModelRequest,
  createProposal,
  type ModelContext,
  type ModelRequestConfigInput,
  type Plan,
  type PlanStep,
  type Proposal,
  type ProposalGenerationErrorKind,
  type Tool,
  type ToolValueSchema
} from "@naqsh/schemas";
import type { ModelProvider } from "./model-provider.js";
import type { ToolRegistry } from "./tool-registry.js";
import { validateProposalSemantics } from "./proposal-semantics.js";

/**
 * Plan Step -> Proposal (P10).
 *
 * The core flow this file implements is:
 *
 *   Plan + PlanStep -> ModelRequest -> ModelProvider.generate() ->
 *   structured candidate -> shape validation -> semantic validation ->
 *   Proposal
 *
 * NEVER `Proposal -> execution`: `generateProposal` produces a `Proposal`
 * (a description of INTENT) and stops there — nothing in this file, and
 * nothing that constructs a `Proposal`, imports `updateWorldModel`,
 * `ChangeHistory`, `recordTransition`, `executeTool`, `invokeRegisteredTool`,
 * an `EnvironmentAdapter`, or `@naqsh/adapters`. Generating a proposal
 * cannot mutate `WorldModelState` and cannot execute anything because
 * nothing in this file ever holds a reference to anything that could —
 * enforced as repo-boundaries regression tests, mirroring P8/P9's
 * identical guards. `ToolRegistry` is used ONLY for read-only lookups
 * (`getByName`/`list`), never for dispatch (`invokeRegisteredTool` is not
 * even importable from outside `execute-tool.ts` — see `tool-registry.ts`'s
 * doc comment).
 *
 * Gemini's output is never automatically authoritative, the identical
 * discipline `generatePlanProposal` (P9) already established:
 * `provider.generate()` runs `validateStructuredResult` (schema
 * conformance) before ever returning `status: "success"` — but that only
 * proves the JSON has the right SHAPE. This file adds two more layers
 * before anything is called a `Proposal`: reassembling the shape into a
 * real, schema-validated domain object (`createProposal`/`assertProposal`),
 * and then `validateProposalSemantics` (proposal-semantics.ts) — the check
 * that catches a structurally-valid proposal referencing a plan step,
 * requirement, constraint, target entity, or tool that doesn't exist (or
 * whose `input` doesn't match the named tool's own `inputSchema`). A
 * proposal that fails either layer is REJECTED (`status: "error"`), never
 * silently repaired.
 */

const PROPOSAL_SYSTEM_INSTRUCTION =
  "You are NAQSH's engineering proposal generator. Given ONE specific plan step and the tools NAQSH has " +
  "registered, you propose EXACTLY ONE concrete tool call that would realize that step. You do not execute " +
  "anything -- a human must approve this proposal before anything happens. Rules that must never be broken: " +
  "(1) toolName must be copied EXACTLY from the tools listed below -- never invent one, never propose a tool " +
  "that isn't listed. (2) input must be a complete, valid set of arguments for that tool, matching its " +
  "inputSchema exactly. (3) relevantRequirementIds/relevantConstraintIds must be copied exactly from what the " +
  "plan step already lists as relevant -- never invent a new one. (4) target should name the specific entity " +
  "this action would act on, or null if it creates something new / doesn't act on one specific existing entity.";

const proposalOutputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    toolName: { type: "string", description: "Must be exactly one of the tool names listed as available." },
    input: {
      type: "object",
      properties: {},
      additionalProperties: true,
      description: "The complete arguments that would be passed to this tool."
    },
    target: {
      type: "object",
      nullable: true,
      properties: {
        entityType: { type: "string" },
        entityId: { type: "string", nullable: true }
      },
      required: ["entityType", "entityId"],
      additionalProperties: false,
      description: "What entity this proposal would act on, or null if it creates something new."
    },
    rationale: { type: "string" },
    expectedEffect: { type: "string" },
    relevantRequirementIds: {
      type: "array",
      items: { type: "string" },
      description: "Must be a subset of the plan step's own relevantRequirementIds."
    },
    relevantConstraintIds: {
      type: "array",
      items: { type: "string" },
      description: "Must be a subset of the plan step's own relevantConstraintIds."
    }
  },
  required: ["toolName", "input", "target", "rationale", "expectedEffect", "relevantRequirementIds", "relevantConstraintIds"],
  additionalProperties: false
};

interface RawProposalOutput {
  toolName: string;
  input: Record<string, unknown>;
  target: { entityType: string; entityId: string | null } | null;
  rationale: string;
  expectedEffect: string;
  relevantRequirementIds: string[];
  relevantConstraintIds: string[];
}

function isRawProposalOutput(value: unknown): value is RawProposalOutput {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.toolName === "string" &&
    typeof record.input === "object" &&
    record.input !== null &&
    (record.target === null || (typeof record.target === "object" && record.target !== null)) &&
    typeof record.rationale === "string" &&
    typeof record.expectedEffect === "string" &&
    Array.isArray(record.relevantRequirementIds) &&
    Array.isArray(record.relevantConstraintIds)
  );
}

/** Text summary of every registered tool, embedded in the instruction —
 * not `ModelRequest.tools` (which declares tools for actual function
 * calling): this request asks for a structured JSON description of a
 * PROPOSED call, not a live tool_call response, so declaring `tools`
 * alongside `outputSchema` would risk the model making an actual
 * function-call turn instead of the structured description this function
 * needs. Mirrors `planner.ts`'s `summarizeEntityList` reasoning exactly —
 * detailed, id-labeled context belongs in instruction text, not a
 * dual-purpose structured field. */
function summarizeAvailableTools(tools: readonly Tool[]): string {
  if (tools.length === 0) return "Available tools: none.";
  const lines = tools.map(
    (tool) =>
      `  - ${tool.name} (target: ${tool.target}, mutation: ${tool.mutation}): ${tool.description}\n` +
      `    inputSchema: ${JSON.stringify(tool.inputSchema)}`
  );
  return `Available tools:\n${lines.join("\n")}`;
}

function buildProposalInstruction(
  plan: Plan,
  step: PlanStep,
  tools: readonly Tool[],
  additionalInstruction?: string
): string {
  const lines = [
    `Objective: ${plan.objectiveSummary}`,
    "",
    `Plan step to realize: "${step.title}"`,
    `Step description: ${step.description}`,
    `Step purpose: ${step.purpose}`,
    step.verificationIntent ? `Verification intent: ${step.verificationIntent}` : "Verification intent: none stated.",
    "",
    "This step is already known to relate to:",
    `  requirements: [${step.relevantRequirementIds.join(", ")}]`,
    `  constraints: [${step.relevantConstraintIds.join(", ")}]`,
    `  objects: [${step.relevantObjectIds.join(", ")}]`,
    `  decisions: [${step.relevantDecisionIds.join(", ")}]`,
    "",
    summarizeAvailableTools(tools),
    "",
    "Propose exactly ONE concrete tool call that would realize this step, based only on the information above."
  ];
  if (additionalInstruction) lines.push("", additionalInstruction);
  return lines.join("\n");
}

function buildProposalModelContext(plan: Plan): ModelContext {
  return createModelContext({
    projectId: plan.projectId,
    objectiveSummary: plan.objectiveSummary
  });
}

export interface GenerateProposalOptions {
  /** Extra guidance appended to the instruction sent to the model. Optional. */
  additionalInstruction?: string;
  /** Forwarded to `ModelRequest.config`. `modelId` has no sensible
   * core-level default (core is provider-agnostic), so the caller must
   * supply one. */
  config: ModelRequestConfigInput;
  sessionId?: string | null;
}

export type ProposalGenerationResult =
  | { status: "success"; proposal: Proposal }
  | { status: "error"; error: { kind: ProposalGenerationErrorKind; message: string } };

/**
 * A `Plan` + one of its `PlanStep`s -> a validated, semantically-checked
 * `Proposal`. Never throws for an expected failure mode — the same
 * discipline `generatePlanProposal` (P9) already established: a caller
 * branches on `result.status`, never wraps this in try/catch. `registry`
 * is used only to (a) show the model what tools genuinely exist and (b)
 * cross-check the model's chosen `toolName`/`input` afterward — this
 * function never calls `invokeRegisteredTool` or `executeTool`, so no
 * registered tool is ever actually invoked by generating a proposal.
 */
export async function generateProposal(
  provider: ModelProvider,
  registry: ToolRegistry,
  plan: Plan,
  planStepId: string,
  options: GenerateProposalOptions
): Promise<ProposalGenerationResult> {
  let request;
  let step: PlanStep;
  try {
    assertPlan(plan);
    const found = plan.steps.find((candidate) => candidate.id === planStepId);
    if (!found) {
      return {
        status: "error",
        error: { kind: "invalid_input", message: `No step with id "${planStepId}" exists in plan "${plan.id}"` }
      };
    }
    step = found;
    request = createModelRequest({
      systemInstruction: PROPOSAL_SYSTEM_INSTRUCTION,
      context: buildProposalModelContext(plan),
      instruction: buildProposalInstruction(plan, step, registry.list(), options.additionalInstruction),
      outputSchema: proposalOutputSchema,
      config: options.config,
      sessionId: options.sessionId ?? null
    });
  } catch (error) {
    // Covers a malformed `plan` and a malformed `options` (e.g. an empty
    // `config.modelId`) -- both are caller-supplied input, and this
    // function never throws for an expected failure mode.
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
  if (response.kind !== "structured_result" || !isRawProposalOutput(response.structuredResult)) {
    return {
      status: "error",
      error: {
        kind: "invalid_model_output",
        message: `Expected a structured proposal result, got response kind "${response.kind}"`
      }
    };
  }

  const raw: RawProposalOutput = response.structuredResult;

  let proposal: Proposal;
  try {
    // Every field access below (including the registry lookup) is inside
    // this try/catch, not just createProposal itself -- a non-compliant
    // ModelProvider that skips its own schema validation before returning
    // status:"success" must not be able to throw an uncaught exception
    // out of this function (the same defense-in-depth `generatePlanProposal`
    // was hardened with after the P9 audit found the gap, applied here
    // from the start).
    const tool = registry.getByName(raw.toolName);
    proposal = createProposal({
      projectId: plan.projectId,
      projectVersion: plan.projectVersion,
      planId: plan.id,
      planStepId: step.id,
      objectiveSummary: plan.objectiveSummary,
      toolName: raw.toolName,
      // Falls back to a placeholder when the tool isn't registered --
      // harmless: validateProposalSemantics rejects an unregistered
      // toolName outright below, so this value never reaches a caller as
      // part of a "successful" proposal.
      toolTarget: tool ? tool.target : "world_model",
      input: raw.input,
      target: raw.target,
      rationale: raw.rationale,
      expectedEffect: raw.expectedEffect,
      relevantRequirementIds: raw.relevantRequirementIds,
      relevantConstraintIds: raw.relevantConstraintIds,
      source: "agent"
    });
  } catch (error) {
    return { status: "error", error: { kind: "malformed_proposal_shape", message: error instanceof Error ? error.message : String(error) } };
  }

  const issues = validateProposalSemantics(proposal, plan, registry);
  if (issues.length > 0) {
    return {
      status: "error",
      error: { kind: "semantic_validation_failed", message: issues.map((issue) => issue.message).join("; ") }
    };
  }

  return { status: "success", proposal };
}
