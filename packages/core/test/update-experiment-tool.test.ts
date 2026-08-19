import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorldModelState, type Experiment, type WorldModelState } from "@naqsh/schemas";
import { createAddExperimentTool } from "../src/add-experiment-tool.js";
import { createUpdateExperimentTool } from "../src/update-experiment-tool.js";
import { createChangeHistory } from "../src/change-history.js";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry } from "../src/tool-registry.js";

function buildHarness() {
  let state: WorldModelState = createWorldModelState({ project: { id: "proj_1", name: "Bracket Study" }, session: {} });
  const history = createChangeHistory();
  const registry = createToolRegistry();
  const getState = () => state;
  const setState = (next: WorldModelState) => {
    state = next;
  };
  const addTool = createAddExperimentTool(getState, setState, history);
  registry.register(addTool.tool, addTool.handler);
  const updateTool = createUpdateExperimentTool(getState, setState, history);
  registry.register(updateTool.tool, updateTool.handler);
  return { registry, history, getState };
}

async function addExperiment(registry: ReturnType<typeof createToolRegistry>, overrides: Record<string, unknown> = {}): Promise<Experiment> {
  const { result } = await executeTool(registry, { toolName: "add_experiment", input: { objective: "o", hypothesis: "h", ...overrides } });
  assert.equal(result.status, "success");
  return (result.output as { experiment: Experiment }).experiment;
}

describe("createUpdateExperimentTool: identity and classification", () => {
  it("is classified mutate/world_model", () => {
    const { registry } = buildHarness();
    const tool = registry.getByName("update_experiment")!;
    assert.equal(tool.mutation, "mutate");
    assert.equal(tool.target, "world_model");
  });
});

describe("createUpdateExperimentTool: updates", () => {
  it("updates status/result/conclusion/buildResultId/verificationResultIds/checkpointAfterId", async () => {
    const { registry, getState } = buildHarness();
    const experiment = await addExperiment(registry);

    const { result } = await executeTool(registry, {
      toolName: "update_experiment",
      input: {
        experimentId: experiment.id,
        status: "complete",
        result: { buildStatus: "completed" },
        conclusion: "Build completed successfully.",
        buildResultId: "build_1",
        verificationResultIds: ["vr_1", "vr_2"],
        checkpointAfterId: "chkpt_after_1"
      }
    });
    assert.equal(result.status, "success");
    const updated = (result.output as { experiment: Experiment }).experiment;
    assert.equal(updated.status, "complete");
    assert.deepEqual(updated.result, { buildStatus: "completed" });
    assert.equal(updated.conclusion, "Build completed successfully.");
    assert.equal(updated.buildResultId, "build_1");
    assert.deepEqual(updated.verificationResultIds, ["vr_1", "vr_2"]);
    assert.equal(updated.checkpointAfterId, "chkpt_after_1");
    assert.deepEqual(getState().project.experiments.find((e) => e.id === experiment.id), updated);
  });

  it("a partial patch leaves unspecified fields unchanged", async () => {
    const { registry } = buildHarness();
    const experiment = await addExperiment(registry, { candidateId: "cand_1", checkpointBeforeId: "chkpt_before_1" });

    const { result } = await executeTool(registry, { toolName: "update_experiment", input: { experimentId: experiment.id, status: "failed" } });
    assert.equal(result.status, "success");
    const updated = (result.output as { experiment: Experiment }).experiment;
    assert.equal(updated.status, "failed");
    assert.equal(updated.candidateId, "cand_1", "fields not named in the patch must survive unchanged");
    assert.equal(updated.checkpointBeforeId, "chkpt_before_1");
    assert.equal(updated.objective, experiment.objective);
    assert.equal(updated.hypothesis, experiment.hypothesis);
  });
});

describe("createUpdateExperimentTool: identity fields cannot be patched", () => {
  it("ignores an attempted patch of candidateId/checkpointBeforeId/objective/hypothesis/source/createdAt/id -- only the documented outcome fields are ever applied", async () => {
    const { registry } = buildHarness();
    const experiment = await addExperiment(registry, { candidateId: "cand_real", checkpointBeforeId: "chkpt_real" });

    const rawInput = {
      experimentId: experiment.id,
      status: "complete",
      // None of these should be reachable through this tool's input schema
      // (it declares no such properties), but even if a caller crafts the
      // input by hand, toUpdateExperimentToolInput only ever reads the
      // allowlisted keys.
      candidateId: "cand_spoofed",
      checkpointBeforeId: "chkpt_spoofed",
      objective: "a rewritten objective",
      hypothesis: "a rewritten hypothesis",
      source: "human",
      createdAt: "2000-01-01T00:00:00.000Z",
      id: "exp_spoofed"
    };
    const { result } = await executeTool(registry, { toolName: "update_experiment", input: rawInput });
    assert.equal(result.status, "success");
    const updated = (result.output as { experiment: Experiment }).experiment;
    assert.equal(updated.id, experiment.id, "id must never be rewritable");
    assert.equal(updated.candidateId, "cand_real", "candidateId must never be rewritable through update_experiment");
    assert.equal(updated.checkpointBeforeId, "chkpt_real");
    assert.equal(updated.objective, experiment.objective);
    assert.equal(updated.hypothesis, experiment.hypothesis);
    assert.equal(updated.source, experiment.source);
    assert.equal(updated.createdAt, experiment.createdAt);
    assert.equal(updated.status, "complete", "only the allowlisted status field from the same call actually applied");
  });
});

describe("createUpdateExperimentTool: validation", () => {
  it("rejects a missing experimentId", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "update_experiment", input: { status: "complete" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("rejects an experimentId that does not exist -- never a silent no-op", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "update_experiment", input: { experimentId: "exp_does_not_exist", status: "complete" } });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /experiment_not_found/);
  });

  it("rejects an invalid status value", async () => {
    const { registry } = buildHarness();
    const experiment = await addExperiment(registry);
    const { result } = await executeTool(registry, { toolName: "update_experiment", input: { experimentId: experiment.id, status: "not_a_real_status" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("rejects a non-array verificationResultIds", async () => {
    const { registry } = buildHarness();
    const experiment = await addExperiment(registry);
    const { result } = await executeTool(registry, { toolName: "update_experiment", input: { experimentId: experiment.id, verificationResultIds: "vr_1" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });
});
