import { createTool, ToolError, type Tool, type ToolValueSchema } from "@naqsh/schemas";
import type { OptimizationProblemStore } from "./optimization-problem-store.js";
import type { CandidateMetricValueStore } from "./optimization-metric-store.js";
import type { OptimizationResultStore } from "./optimization-result-store.js";
import { computeOptimizationResult } from "./optimization-engine.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * Phase 23's EVALUATION half: locates an `OptimizationProblem`, hands it and
 * the recorded `CandidateMetricValue`s to the PURE, deterministic
 * `computeOptimizationResult` (`optimization-engine.ts`), and persists the
 * resulting `OptimizationResult` -- mirrors `run_verification`'s (P16)
 * exact shape: read-only against the World Model and the environment (this
 * tool touches neither), a real Tool call that persists a NEW, immutable
 * record, same as `create_checkpoint`/`create_check`.
 *
 * Classified `mutation: "suggest"` for the identical reason `create_check`/
 * `create_checkpoint`/`create_candidate` are -- a new independent record,
 * never World Model state. (Not `"verify"`: that tier is P16's own specific
 * "evaluate one deterministic Check against Evidence" meaning; this tool
 * runs a different deterministic procedure over different inputs.)
 *
 * Never accepts a Gemini-authored result, never lets a model recompute or
 * override what `computeOptimizationResult` decided -- this tool's only
 * job is locate-the-problem, call-the-pure-function, persist-the-result.
 */

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    problemId: { type: "string", description: "The OptimizationProblem to evaluate." }
  },
  required: ["problemId"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: { result: { type: "object", properties: {}, additionalProperties: true } },
  required: ["result"]
};

function toRunOptimizationInput(rawInput: unknown): { problemId: string } {
  const record = rawInput as { problemId?: unknown };
  if (typeof record.problemId !== "string" || record.problemId.trim().length === 0) {
    throw new ToolError("invalid_input", "problemId is required and must be a non-empty string");
  }
  return { problemId: record.problemId };
}

export function createRunOptimizationTool(
  optimizationProblemStore: OptimizationProblemStore,
  metricValueStore: CandidateMetricValueStore,
  optimizationResultStore: OptimizationResultStore
): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "run_optimization",
    description:
      "Deterministically evaluates a previously defined OptimizationProblem against recorded CandidateMetricValues -- feasibility, Pareto dominance, and (if every objective carries an explicit weight) a normalized weighted score. Never Gemini's judgment. Persists a new, immutable OptimizationResult.",
    target: "optimization",
    mutation: "suggest",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = (rawInput) => {
    const input = toRunOptimizationInput(rawInput);

    const problem = optimizationProblemStore.getById(input.problemId);
    if (!problem) {
      throw new ToolError("invalid_input", `problem_not_found: no OptimizationProblem "${input.problemId}" exists`);
    }

    const result = computeOptimizationResult(problem, metricValueStore);
    optimizationResultStore.save(result);
    return { result };
  };

  return { tool, handler };
}
