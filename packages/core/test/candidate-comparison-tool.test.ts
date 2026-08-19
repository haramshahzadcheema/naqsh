import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCandidate, createWorldModelState, type CandidateInput, type WorldModelState } from "@naqsh/schemas";
import { createCompareCandidatesTool } from "../src/candidate-comparison-tool.js";
import { createCandidateStore } from "../src/candidate-store.js";
import { createVerificationResultStore } from "../src/verification-result-store.js";
import { createToolRegistry } from "../src/tool-registry.js";
import { executeTool } from "../src/execute-tool.js";

function candidateInput(overrides: Partial<CandidateInput> = {}): CandidateInput {
  return {
    projectId: "proj_1",
    projectVersion: 1,
    planId: "plan_1",
    planStepId: "step_1",
    hypothesis: "h",
    rationale: "r",
    ...overrides
  };
}

function buildHarness() {
  const candidateStore = createCandidateStore();
  const verificationResultStore = createVerificationResultStore();
  const state: WorldModelState = createWorldModelState({ project: { id: "proj_1", name: "Bracket Study" }, session: {} });
  const registry = createToolRegistry();
  const { tool, handler } = createCompareCandidatesTool(candidateStore, () => state, verificationResultStore);
  registry.register(tool, handler);
  return { registry, candidateStore };
}

describe("createCompareCandidatesTool: identity and classification", () => {
  it("is classified observe/world_model -- comparison never mutates anything", () => {
    const { registry } = buildHarness();
    const tool = registry.getByName("compare_candidates")!;
    assert.equal(tool.mutation, "observe");
    assert.equal(tool.target, "world_model");
  });
});

describe("createCompareCandidatesTool: comparison", () => {
  it("compares two saved candidates by id", async () => {
    const { registry, candidateStore } = buildHarness();
    const a = createCandidate(candidateInput({ hypothesis: "A" }));
    const b = createCandidate(candidateInput({ hypothesis: "B" }));
    candidateStore.save(a);
    candidateStore.save(b);

    const { result } = await executeTool(registry, { toolName: "compare_candidates", input: { candidateIds: [a.id, b.id] } });
    assert.equal(result.status, "success");
    const output = result.output as { candidates: { candidateId: string; hypothesis: string }[] };
    assert.equal(output.candidates.length, 2);
    assert.deepEqual(
      output.candidates.map((entry) => entry.hypothesis).sort(),
      ["A", "B"]
    );
  });

  it("rejects a candidateId that doesn't exist", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "compare_candidates", input: { candidateIds: ["cand_missing"] } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
    assert.match(result.error!.message, /candidate_not_found/);
  });

  it("rejects an empty candidateIds array", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "compare_candidates", input: { candidateIds: [] } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("rejects comparing candidates from different plan steps", async () => {
    const { registry, candidateStore } = buildHarness();
    const a = createCandidate(candidateInput({ planStepId: "step_1" }));
    const b = createCandidate(candidateInput({ planStepId: "step_2" }));
    candidateStore.save(a);
    candidateStore.save(b);

    const { result } = await executeTool(registry, { toolName: "compare_candidates", input: { candidateIds: [a.id, b.id] } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });
});
