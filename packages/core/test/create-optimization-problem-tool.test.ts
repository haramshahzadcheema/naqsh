import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCandidate, createWorldModelState, type CandidateInput, type OptimizationProblem, type WorldModelState } from "@naqsh/schemas";
import { createCreateOptimizationProblemTool } from "../src/create-optimization-problem-tool.js";
import { createCandidateStore } from "../src/candidate-store.js";
import { createOptimizationProblemStore } from "../src/optimization-problem-store.js";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry } from "../src/tool-registry.js";
import { createApprovalStore } from "../src/approval-store.js";
import { createAutonomyGrantStore } from "../src/autonomy-grant-store.js";
import { createExecuteToolAuthorizer } from "../src/authorization.js";

function candidateInput(overrides: Partial<CandidateInput> = {}): CandidateInput {
  return { projectId: "proj_1", projectVersion: 1, planId: "plan_1", planStepId: "step_1", hypothesis: "h", rationale: "r", ...overrides };
}

function buildHarness() {
  const candidateStore = createCandidateStore();
  const optimizationProblemStore = createOptimizationProblemStore();
  let state: WorldModelState = createWorldModelState({ project: { id: "proj_1", name: "Bracket Study" }, session: {} });
  const registry = createToolRegistry();
  const { tool, handler } = createCreateOptimizationProblemTool(candidateStore, optimizationProblemStore, () => state);
  registry.register(tool, handler);
  return { registry, candidateStore, optimizationProblemStore, getState: () => state };
}

function saveCandidate(harness: ReturnType<typeof buildHarness>, overrides: Partial<CandidateInput> = {}) {
  const candidate = createCandidate(candidateInput(overrides));
  harness.candidateStore.save(candidate);
  return candidate;
}

describe("createCreateOptimizationProblemTool: identity and classification", () => {
  it("is classified suggest/optimization -- never mutates the World Model or the environment", () => {
    const { registry } = buildHarness();
    const tool = registry.getByName("create_optimization_problem")!;
    assert.equal(tool.mutation, "suggest");
    assert.equal(tool.target, "optimization");
  });
});

describe("createCreateOptimizationProblemTool: creation", () => {
  it("creates a valid problem and persists it", async () => {
    const harness = buildHarness();
    const a = saveCandidate(harness);
    const b = saveCandidate(harness);
    const { result } = await executeTool(harness.registry, {
      toolName: "create_optimization_problem",
      input: {
        candidateIds: [a.id, b.id],
        objectives: [{ metricKey: "mass", description: "Minimize mass.", direction: "minimize" }]
      }
    });
    assert.equal(result.status, "success");
    const problem = (result.output as { problem: OptimizationProblem }).problem;
    assert.deepEqual(problem.candidateIds, [a.id, b.id]);
    assert.equal(problem.objectives.length, 1);
    assert.equal(problem.projectId, "proj_1");
    assert.deepEqual(harness.optimizationProblemStore.getById(problem.id), problem);
  });

  it("reads projectId/projectVersion from LIVE WorldModelState, never caller-supplied", async () => {
    const harness = buildHarness();
    const a = saveCandidate(harness);
    const { result } = await executeTool(harness.registry, {
      toolName: "create_optimization_problem",
      input: { candidateIds: [a.id], objectives: [{ metricKey: "mass", description: "d", direction: "minimize" }], projectId: "proj_spoofed" }
    });
    assert.equal(result.status, "success");
    assert.equal((result.output as { problem: OptimizationProblem }).problem.projectId, "proj_1");
  });

  it("accepts an explicit weight and constraint", async () => {
    const harness = buildHarness();
    const a = saveCandidate(harness);
    const { result } = await executeTool(harness.registry, {
      toolName: "create_optimization_problem",
      input: {
        candidateIds: [a.id],
        objectives: [{ metricKey: "mass", description: "d", direction: "minimize", weight: 0.5 }],
        constraints: [{ metricKey: "mass", description: "d", operator: "lte", threshold: 10 }]
      }
    });
    assert.equal(result.status, "success");
    const problem = (result.output as { problem: OptimizationProblem }).problem;
    assert.equal(problem.objectives[0]!.weight, 0.5);
    assert.equal(problem.constraints.length, 1);
  });
});

describe("createCreateOptimizationProblemTool: validation", () => {
  it("rejects an empty candidateIds array", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, {
      toolName: "create_optimization_problem",
      input: { candidateIds: [], objectives: [{ metricKey: "mass", description: "d", direction: "minimize" }] }
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("rejects an empty objectives array", async () => {
    const harness = buildHarness();
    const a = saveCandidate(harness);
    const { result } = await executeTool(harness.registry, { toolName: "create_optimization_problem", input: { candidateIds: [a.id], objectives: [] } });
    assert.equal(result.status, "error");
  });

  it("rejects an invalid objective direction", async () => {
    const harness = buildHarness();
    const a = saveCandidate(harness);
    const { result } = await executeTool(harness.registry, {
      toolName: "create_optimization_problem",
      input: { candidateIds: [a.id], objectives: [{ metricKey: "mass", description: "d", direction: "bigger" }] }
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("rejects a negative weight (a malformed model-generated configuration must fail deterministic validation)", async () => {
    const harness = buildHarness();
    const a = saveCandidate(harness);
    const { result } = await executeTool(harness.registry, {
      toolName: "create_optimization_problem",
      input: { candidateIds: [a.id], objectives: [{ metricKey: "mass", description: "d", direction: "minimize", weight: -1 }] }
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("rejects two objectives sharing the same metricKey", async () => {
    const harness = buildHarness();
    const a = saveCandidate(harness);
    const { result } = await executeTool(harness.registry, {
      toolName: "create_optimization_problem",
      input: {
        candidateIds: [a.id],
        objectives: [
          { metricKey: "mass", description: "minimize", direction: "minimize" },
          { metricKey: "mass", description: "maximize", direction: "maximize" }
        ]
      }
    });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /duplicate_objective_metric_key/);
  });

  it("rejects a candidateId that does not exist -- an optimization problem can never silently analyze a nonexistent candidate", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, {
      toolName: "create_optimization_problem",
      input: { candidateIds: ["cand_missing"], objectives: [{ metricKey: "mass", description: "d", direction: "minimize" }] }
    });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /unknown_candidate_reference/);
  });

  it("rejects an invalid provenance value", async () => {
    const harness = buildHarness();
    const a = saveCandidate(harness);
    const { result } = await executeTool(harness.registry, {
      toolName: "create_optimization_problem",
      input: { candidateIds: [a.id], objectives: [{ metricKey: "mass", description: "d", direction: "minimize" }], provenance: "not_a_real_source" }
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });
});

describe("createCreateOptimizationProblemTool: respects real P4 authorization", () => {
  it("is rejected with policy_rejected under an autonomy level below 'suggest'", async () => {
    const harness = buildHarness();
    const a = saveCandidate(harness);
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "observe", approvals, autonomyGrants });

    const { result } = await executeTool(harness.registry, {
      toolName: "create_optimization_problem",
      input: { candidateIds: [a.id], objectives: [{ metricKey: "mass", description: "d", direction: "minimize" }] },
      authorize
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "policy_rejected");
    assert.equal(harness.optimizationProblemStore.list().length, 0);
  });

  it("succeeds at autonomy level 'suggest' -- a suggest-tier tool needs no Approval/AutonomyGrant", async () => {
    const harness = buildHarness();
    const a = saveCandidate(harness);
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "suggest", approvals, autonomyGrants });

    const { result } = await executeTool(harness.registry, {
      toolName: "create_optimization_problem",
      input: { candidateIds: [a.id], objectives: [{ metricKey: "mass", description: "d", direction: "minimize" }] },
      authorize
    });
    assert.equal(result.status, "success");
  });
});
