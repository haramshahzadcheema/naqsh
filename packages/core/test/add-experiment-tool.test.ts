import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorldModelState, type Experiment, type WorldModelState } from "@naqsh/schemas";
import { createAddExperimentTool } from "../src/add-experiment-tool.js";
import { createChangeHistory } from "../src/change-history.js";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry } from "../src/tool-registry.js";

function buildHarness() {
  let state: WorldModelState = createWorldModelState({ project: { id: "proj_1", name: "Bracket Study" }, session: {} });
  const history = createChangeHistory();
  const registry = createToolRegistry();
  const { tool, handler } = createAddExperimentTool(
    () => state,
    (next) => {
      state = next;
    },
    history
  );
  registry.register(tool, handler);
  return { registry, history, getState: () => state };
}

describe("createAddExperimentTool: identity and classification", () => {
  it("is classified mutate/world_model -- Experiment lives in Project.experiments, exactly like Requirement/Source", () => {
    const { registry } = buildHarness();
    const tool = registry.getByName("add_experiment")!;
    assert.equal(tool.mutation, "mutate");
    assert.equal(tool.target, "world_model");
  });
});

describe("createAddExperimentTool: creation", () => {
  it("adds an experiment through the existing add_experiment transition", async () => {
    const { registry, getState } = buildHarness();
    const before = getState().project.experiments.length;
    const { result } = await executeTool(registry, {
      toolName: "add_experiment",
      input: { objective: "Test load capacity", hypothesis: "The plate holds 500N", candidateId: "cand_1", checkpointBeforeId: "chkpt_1", status: "running" }
    });
    assert.equal(result.status, "success");
    assert.equal(getState().project.experiments.length, before + 1);
    const experiment = (result.output as { experiment: Experiment }).experiment;
    assert.equal(experiment.objective, "Test load capacity");
    assert.equal(experiment.hypothesis, "The plate holds 500N");
    assert.equal(experiment.candidateId, "cand_1");
    assert.equal(experiment.checkpointBeforeId, "chkpt_1");
    assert.equal(experiment.status, "running");
    assert.equal(experiment.source, "agent");
  });

  it("defaults status to 'planned' and source to 'agent' when omitted", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "add_experiment", input: { objective: "o", hypothesis: "h" } });
    assert.equal(result.status, "success");
    const experiment = (result.output as { experiment: Experiment }).experiment;
    assert.equal(experiment.status, "planned");
    assert.equal(experiment.source, "agent");
    assert.equal(experiment.candidateId, null);
    assert.equal(experiment.checkpointBeforeId, null);
  });

  it("accepts an explicit provenance of 'human'", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "add_experiment", input: { objective: "o", hypothesis: "h", provenance: "human" } });
    assert.equal(result.status, "success");
    assert.equal((result.output as { experiment: Experiment }).experiment.source, "human");
  });

  it("two experiments created with the same input get distinct ids -- never accidentally deduplicated", async () => {
    const { registry } = buildHarness();
    const input = { objective: "o", hypothesis: "h" };
    const { result: r1 } = await executeTool(registry, { toolName: "add_experiment", input });
    const { result: r2 } = await executeTool(registry, { toolName: "add_experiment", input });
    const e1 = (r1.output as { experiment: Experiment }).experiment;
    const e2 = (r2.output as { experiment: Experiment }).experiment;
    assert.notEqual(e1.id, e2.id);
  });
});

describe("createAddExperimentTool: validation", () => {
  it("rejects a missing objective", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "add_experiment", input: { hypothesis: "h" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("rejects a missing hypothesis", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "add_experiment", input: { objective: "o" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("rejects an invalid status value", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "add_experiment", input: { objective: "o", hypothesis: "h", status: "not_a_real_status" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("rejects an invalid provenance value", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "add_experiment", input: { objective: "o", hypothesis: "h", provenance: "not_a_real_source" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });
});
