import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCandidate, createCandidateMetricValue, createOptimizationProblem, type CandidateInput, type OptimizationResult } from "@naqsh/schemas";
import { createRunOptimizationTool } from "../src/run-optimization-tool.js";
import { createOptimizationProblemStore } from "../src/optimization-problem-store.js";
import { createCandidateMetricValueStore } from "../src/optimization-metric-store.js";
import { createOptimizationResultStore } from "../src/optimization-result-store.js";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry } from "../src/tool-registry.js";

function candidateInput(overrides: Partial<CandidateInput> = {}): CandidateInput {
  return { projectId: "proj_1", projectVersion: 1, planId: "plan_1", planStepId: "step_1", hypothesis: "h", rationale: "r", ...overrides };
}

function buildHarness() {
  const optimizationProblemStore = createOptimizationProblemStore();
  const metricValueStore = createCandidateMetricValueStore();
  const optimizationResultStore = createOptimizationResultStore();
  const registry = createToolRegistry();
  const { tool, handler } = createRunOptimizationTool(optimizationProblemStore, metricValueStore, optimizationResultStore);
  registry.register(tool, handler);
  return { registry, optimizationProblemStore, metricValueStore, optimizationResultStore };
}

describe("createRunOptimizationTool: identity and classification", () => {
  it("is classified suggest/optimization", () => {
    const { registry } = buildHarness();
    const tool = registry.getByName("run_optimization")!;
    assert.equal(tool.mutation, "suggest");
    assert.equal(tool.target, "optimization");
  });
});

describe("createRunOptimizationTool: evaluation", () => {
  it("computes and persists an OptimizationResult for a real problem", async () => {
    const harness = buildHarness();
    const a = createCandidate(candidateInput());
    const b = createCandidate(candidateInput());
    const problem = createOptimizationProblem({
      projectId: "proj_1",
      projectVersion: 1,
      candidateIds: [a.id, b.id],
      objectives: [{ metricKey: "mass", description: "d", direction: "minimize" }]
    });
    harness.optimizationProblemStore.save(problem);
    harness.metricValueStore.save(createCandidateMetricValue({ candidateId: a.id, metricKey: "mass", provenanceKind: "declared", status: "estimated", value: 10 }));
    harness.metricValueStore.save(createCandidateMetricValue({ candidateId: b.id, metricKey: "mass", provenanceKind: "declared", status: "estimated", value: 8 }));

    const { result } = await executeTool(harness.registry, { toolName: "run_optimization", input: { problemId: problem.id } });
    assert.equal(result.status, "success");
    const optResult = (result.output as { result: OptimizationResult }).result;
    assert.equal(optResult.problemId, problem.id);
    assert.deepEqual(optResult.paretoOptimalCandidateIds, [b.id]);
    assert.deepEqual(harness.optimizationResultStore.getById(optResult.id), optResult);
  });

  it("two runs of the same problem produce two distinct, independently persisted results -- append-only, never overwritten", async () => {
    const harness = buildHarness();
    const a = createCandidate(candidateInput());
    const problem = createOptimizationProblem({
      projectId: "proj_1",
      projectVersion: 1,
      candidateIds: [a.id],
      objectives: [{ metricKey: "mass", description: "d", direction: "minimize" }]
    });
    harness.optimizationProblemStore.save(problem);
    harness.metricValueStore.save(createCandidateMetricValue({ candidateId: a.id, metricKey: "mass", provenanceKind: "declared", status: "estimated", value: 10 }));

    const { result: r1 } = await executeTool(harness.registry, { toolName: "run_optimization", input: { problemId: problem.id } });
    const { result: r2 } = await executeTool(harness.registry, { toolName: "run_optimization", input: { problemId: problem.id } });
    const res1 = (r1.output as { result: OptimizationResult }).result;
    const res2 = (r2.output as { result: OptimizationResult }).result;
    assert.notEqual(res1.id, res2.id);
    assert.equal(harness.optimizationResultStore.listForProblem(problem.id).length, 2);
  });
});

describe("createRunOptimizationTool: validation", () => {
  it("rejects a missing problemId", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "run_optimization", input: {} });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("rejects a problemId that does not exist", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "run_optimization", input: { problemId: "optproblem_missing" } });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /problem_not_found/);
  });
});
