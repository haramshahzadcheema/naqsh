import {
  createOptimizationProblem,
  ENTITY_SOURCES,
  NORMALIZATION_METHODS,
  ToolError,
  WorldModelValidationError,
  createTool,
  type EntitySource,
  type NormalizationMethod,
  type OptimizationConstraintInput,
  type OptimizationObjectiveInput,
  type OptimizationProblemInput,
  type Tool,
  type ToolValueSchema,
  type WorldModelState
} from "@naqsh/schemas";
import type { CandidateStore } from "./candidate-store.js";
import type { OptimizationProblemStore } from "./optimization-problem-store.js";
import { validateOptimizationProblemSemantics } from "./optimization-semantics.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * Phase 23's problem-DEFINITION tool: mirrors `create_candidate`'s (P22)
 * exact shape -- flat, already-decided fields in (objectives/directions/
 * weights/constraints an agent's own reasoning or a human already settled
 * on, NOT computed by this tool), a validated, stored `OptimizationProblem`
 * out. No Gemini-calling orchestration function exists for this either --
 * an agent proposes objectives/constraints through its own normal
 * tool-calling reasoning, and this tool deterministically validates what
 * it's handed (the brief's own explicit "any model-generated optimization
 * configuration must pass deterministic validation before use").
 *
 * Classified `mutation: "suggest"` (creates a new independent record, never
 * touches `WorldModelState` or the environment) -- the same classification
 * `create_candidate`/`create_check`/`create_checkpoint` use for the
 * identical reason.
 *
 * `objectives`/`constraints` are declared loosely in the input schema (an
 * array of open objects, `additionalProperties: true`) -- `ToolValueSchema`
 * has no way to express `OptimizationObjective`/`OptimizationConstraint`'s
 * real shape at this coarse gate; the REAL validation happens inside
 * `createOptimizationProblem` (which builds each nested objective/constraint
 * through its own factory) followed by `validateOptimizationProblemSemantics`
 * -- the same "coarse gate, real validation in the handler" precedent
 * `modify-environment-object-tool.ts` already established.
 *
 * `projectId`/`projectVersion` are NOT caller-supplied -- read from LIVE
 * `WorldModelState`, closing the same spoofing path `create_candidate`
 * already closes. `candidateIds` are cross-checked against a REAL
 * `CandidateStore` -- an optimization problem can never silently analyze a
 * candidate that doesn't exist.
 */

const openObjectArraySchema: ToolValueSchema = {
  type: "array",
  items: { type: "object", properties: {}, additionalProperties: true }
};

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    planId: { type: "string", nullable: true },
    planStepId: { type: "string", nullable: true },
    candidateIds: { type: "array", items: { type: "string" }, description: "The candidates this optimization problem analyzes. Must be a non-empty array." },
    objectives: {
      ...openObjectArraySchema,
      description: "OptimizationObjective inputs: { metricKey, description, direction: 'minimize'|'maximize', unit?, requirementId?, weight? }. Deep-validated by this tool's handler."
    },
    constraints: {
      ...openObjectArraySchema,
      nullable: true,
      description: "OptimizationConstraint inputs: { metricKey, description, operator, threshold, unit?, constraintId? }. Deep-validated by this tool's handler."
    },
    normalizationMethod: { type: "string", enum: NORMALIZATION_METHODS as string[], nullable: true },
    provenance: {
      type: "string",
      nullable: true,
      description: "Who/what is proposing this problem -- one of EntitySource. Defaults to 'agent'."
    }
  },
  required: ["candidateIds", "objectives"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: { problem: { type: "object", properties: {}, additionalProperties: true } },
  required: ["problem"]
};

interface CreateOptimizationProblemToolInput {
  planId: string | null;
  planStepId: string | null;
  candidateIds: string[];
  objectives: OptimizationObjectiveInput[];
  constraints: OptimizationConstraintInput[];
  normalizationMethod: NormalizationMethod | null;
  provenance: EntitySource | null;
}

function toCreateOptimizationProblemToolInput(rawInput: unknown): CreateOptimizationProblemToolInput {
  const record = rawInput as {
    planId?: unknown;
    planStepId?: unknown;
    candidateIds?: unknown;
    objectives?: unknown;
    constraints?: unknown;
    normalizationMethod?: unknown;
    provenance?: unknown;
  };
  if (!Array.isArray(record.candidateIds) || record.candidateIds.length === 0 || !record.candidateIds.every((id) => typeof id === "string" && id.trim().length > 0)) {
    throw new ToolError("invalid_input", "candidateIds is required and must be a non-empty array of non-empty strings");
  }
  if (!Array.isArray(record.objectives) || record.objectives.length === 0) {
    throw new ToolError("invalid_input", "objectives is required and must be a non-empty array");
  }
  if (record.constraints !== undefined && record.constraints !== null && !Array.isArray(record.constraints)) {
    throw new ToolError("invalid_input", "constraints must be an array when supplied");
  }
  if (record.normalizationMethod !== undefined && record.normalizationMethod !== null && !(NORMALIZATION_METHODS as readonly string[]).includes(record.normalizationMethod as string)) {
    throw new ToolError("invalid_input", `normalizationMethod must be one of: ${NORMALIZATION_METHODS.join(", ")}`);
  }
  if (record.provenance !== undefined && record.provenance !== null && !(ENTITY_SOURCES as readonly string[]).includes(record.provenance as string)) {
    throw new ToolError("invalid_input", `provenance must be one of: ${ENTITY_SOURCES.join(", ")}`);
  }

  return {
    planId: typeof record.planId === "string" ? record.planId : null,
    planStepId: typeof record.planStepId === "string" ? record.planStepId : null,
    candidateIds: record.candidateIds,
    objectives: record.objectives as OptimizationObjectiveInput[],
    constraints: (record.constraints as OptimizationConstraintInput[] | undefined) ?? [],
    normalizationMethod: typeof record.normalizationMethod === "string" ? (record.normalizationMethod as NormalizationMethod) : null,
    provenance: typeof record.provenance === "string" ? (record.provenance as EntitySource) : null
  };
}

export function createCreateOptimizationProblemTool(
  candidateStore: CandidateStore,
  optimizationProblemStore: OptimizationProblemStore,
  getState: () => WorldModelState
): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "create_optimization_problem",
    description:
      "Defines a new, immutable OptimizationProblem: which candidates to analyze, which objectives (with explicit minimize/maximize direction, and an optional explicit weight) they are measured against, and which hard constraints must be satisfied. Never mutates the World Model or the environment; never itself computes a result.",
    target: "optimization",
    mutation: "suggest",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = (rawInput) => {
    const input = toCreateOptimizationProblemToolInput(rawInput);
    const state = getState();

    const problemInput: OptimizationProblemInput = {
      projectId: state.project.id,
      projectVersion: state.project.version,
      planId: input.planId,
      planStepId: input.planStepId,
      candidateIds: input.candidateIds,
      objectives: input.objectives,
      constraints: input.constraints,
      normalizationMethod: input.normalizationMethod ?? undefined,
      source: input.provenance ?? "agent"
    };

    let problem;
    try {
      problem = createOptimizationProblem(problemInput);
    } catch (error) {
      if (error instanceof WorldModelValidationError) {
        throw new ToolError("invalid_input", `optimization problem is invalid: ${error.message}`);
      }
      throw error;
    }

    const issues = validateOptimizationProblemSemantics(problem, { state, candidateStore });
    if (issues.length > 0) {
      throw new ToolError("invalid_input", `optimization problem failed semantic validation: ${issues.map((issue) => `[${issue.code}] ${issue.message}`).join("; ")}`);
    }

    optimizationProblemStore.save(problem);
    return { problem };
  };

  return { tool, handler };
}
