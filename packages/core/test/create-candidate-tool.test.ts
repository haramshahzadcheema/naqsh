import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createConstraint, createPlan, createPlanStep, createRequirement, createWorldModelState, type Candidate, type Plan, type WorldModelState } from "@naqsh/schemas";
import { createCreateCandidateTool } from "../src/create-candidate-tool.js";
import { createCandidateStore } from "../src/candidate-store.js";
import { createDesignSpecificationStore } from "../src/design-specification-store.js";
import { createDesignSpecification } from "@naqsh/schemas";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry } from "../src/tool-registry.js";

function buildPlan(projectId = "proj_1"): Plan {
  return createPlan({
    projectId,
    projectVersion: 1,
    observationId: "obs_1",
    objectiveSummary: "Design a lightweight mounting bracket.",
    steps: [
      createPlanStep({
        id: "step_1",
        order: 0,
        title: "Design mounting plate",
        description: "Design a rectangular mounting plate.",
        purpose: "Provide the primary load-bearing surface.",
        relevantRequirementIds: ["req_load"],
        relevantConstraintIds: ["con_material"]
      })
    ]
  });
}

function buildHarness() {
  const candidateStore = createCandidateStore();
  const designSpecificationStore = createDesignSpecificationStore();
  let state: WorldModelState = createWorldModelState({
    project: {
      id: "proj_1",
      name: "Bracket Study",
      requirements: [createRequirement({ id: "req_load", description: "Withstand 500 N." })],
      constraints: [createConstraint({ id: "con_material", description: "Must use recyclable material." })]
    },
    session: {}
  });
  const registry = createToolRegistry();
  const { tool, handler } = createCreateCandidateTool(candidateStore, () => state, designSpecificationStore);
  registry.register(tool, handler);
  return {
    registry,
    candidateStore,
    designSpecificationStore,
    tool,
    getState: () => state,
    setState: (next: WorldModelState) => {
      state = next;
    }
  };
}

describe("createCreateCandidateTool: identity and classification", () => {
  it("is classified suggest/world_model -- creating a candidate never mutates the World Model or the environment", () => {
    const { tool } = buildHarness();
    assert.equal(tool.mutation, "suggest");
    assert.equal(tool.target, "world_model");
  });
});

describe("createCreateCandidateTool: creation", () => {
  it("creates a valid candidate and persists it", async () => {
    const { registry, candidateStore } = buildHarness();
    const plan = buildPlan();
    const { result } = await executeTool(registry, {
      toolName: "create_candidate",
      input: {
        plan,
        planStepId: "step_1",
        relevantRequirementIds: ["req_load"],
        relevantConstraintIds: ["con_material"],
        hypothesis: "A ribbed aluminum bracket meets the load requirement at lower mass.",
        rationale: "Ribbing adds stiffness without much added mass."
      }
    });
    assert.equal(result.status, "success");
    const candidate = (result.output as { candidate: Candidate }).candidate;
    assert.equal(candidate.planId, plan.id);
    assert.equal(candidate.projectId, "proj_1");
    assert.equal(candidate.status, "proposed");
    assert.equal(candidate.source, "agent");
    assert.deepEqual(candidateStore.getById(candidate.id), candidate);
  });

  it("defaults planStepId to null for a whole-plan candidate", async () => {
    const { registry } = buildHarness();
    const plan = buildPlan();
    const { result } = await executeTool(registry, {
      toolName: "create_candidate",
      input: { plan, hypothesis: "A single-piece design outperforms an assembled one.", rationale: "Fewer parts, fewer failure points." }
    });
    assert.equal(result.status, "success");
    const candidate = (result.output as { candidate: Candidate }).candidate;
    assert.equal(candidate.planStepId, null);
  });

  it("accepts an explicit provenance of 'human'", async () => {
    const { registry } = buildHarness();
    const plan = buildPlan();
    const { result } = await executeTool(registry, {
      toolName: "create_candidate",
      input: { plan, hypothesis: "h", rationale: "r", provenance: "human" }
    });
    assert.equal(result.status, "success");
    const candidate = (result.output as { candidate: Candidate }).candidate;
    assert.equal(candidate.source, "human");
  });

  it("rejects an invalid provenance value", async () => {
    const { registry } = buildHarness();
    const plan = buildPlan();
    const { result } = await executeTool(registry, {
      toolName: "create_candidate",
      input: { plan, hypothesis: "h", rationale: "r", provenance: "not_a_real_source" }
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("two candidates created with the same input get distinct ids -- never accidentally deduplicated", async () => {
    const { registry } = buildHarness();
    const plan = buildPlan();
    const input = { plan, hypothesis: "h", rationale: "r" };
    const { result: r1 } = await executeTool(registry, { toolName: "create_candidate", input });
    const { result: r2 } = await executeTool(registry, { toolName: "create_candidate", input });
    const c1 = (r1.output as { candidate: Candidate }).candidate;
    const c2 = (r2.output as { candidate: Candidate }).candidate;
    assert.notEqual(c1.id, c2.id);
  });
});

describe("createCreateCandidateTool: shared/shape validation", () => {
  it("rejects a missing hypothesis", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "create_candidate", input: { plan: buildPlan(), rationale: "r" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("rejects a missing rationale", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "create_candidate", input: { plan: buildPlan(), hypothesis: "h" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("rejects a missing plan", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "create_candidate", input: { hypothesis: "h", rationale: "r" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("rejects a malformed plan value", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "create_candidate", input: { plan: { not: "a real plan" }, hypothesis: "h", rationale: "r" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("rejects a non-array relevantRequirementIds", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, {
      toolName: "create_candidate",
      input: { plan: buildPlan(), hypothesis: "h", rationale: "r", relevantRequirementIds: "req_load" }
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });
});

describe("createCreateCandidateTool: semantic validation (goalpost integrity)", () => {
  it("rejects a candidate that names a plan/project the current project doesn't match", async () => {
    const { registry } = buildHarness();
    const plan = buildPlan("proj_other");
    const { result } = await executeTool(registry, { toolName: "create_candidate", input: { plan, hypothesis: "h", rationale: "r" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
    assert.match(result.error!.message, /project_mismatch/);
  });

  it("rejects a candidate citing a requirement its plan step never cited -- no hallucinated relevance", async () => {
    const { registry } = buildHarness();
    const plan = buildPlan();
    const { result } = await executeTool(registry, {
      toolName: "create_candidate",
      input: { plan, planStepId: "step_1", relevantRequirementIds: ["req_invented"], hypothesis: "h", rationale: "r" }
    });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /unknown_requirement_reference/);
  });

  it("rejects a candidate referencing a planStepId that doesn't exist in the plan", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, {
      toolName: "create_candidate",
      input: { plan: buildPlan(), planStepId: "step_missing", hypothesis: "h", rationale: "r" }
    });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /unknown_plan_step/);
  });

  it("rejects a designSpecificationId that does not exist in the DesignSpecificationStore", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, {
      toolName: "create_candidate",
      input: { plan: buildPlan(), designSpecificationId: "design_missing", hypothesis: "h", rationale: "r" }
    });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /unknown_design_specification_reference/);
  });

  it("accepts a designSpecificationId that exists and matches the candidate's own plan/step", async () => {
    const { registry, designSpecificationStore } = buildHarness();
    const plan = buildPlan();
    const design = createDesignSpecification({
      projectId: "proj_1",
      projectVersion: 1,
      planId: plan.id,
      planStepId: "step_1",
      objectiveSummary: "Design a lightweight mounting bracket.",
      description: "A rectangular mounting plate."
    });
    designSpecificationStore.save(design);
    const { result } = await executeTool(registry, {
      toolName: "create_candidate",
      input: { plan, planStepId: "step_1", designSpecificationId: design.id, hypothesis: "h", rationale: "r" }
    });
    assert.equal(result.status, "success");
  });

  it("rejects a parentCandidateId that does not exist in the CandidateStore", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, {
      toolName: "create_candidate",
      input: { plan: buildPlan(), parentCandidateId: "cand_missing", hypothesis: "h", rationale: "r" }
    });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /unknown_parent_candidate_reference/);
  });

  it("accepts a parentCandidateId that exists -- lineage among sibling candidates", async () => {
    const { registry, candidateStore } = buildHarness();
    const plan = buildPlan();
    const { result: r1 } = await executeTool(registry, { toolName: "create_candidate", input: { plan, hypothesis: "h1", rationale: "r1" } });
    const parent = (r1.output as { candidate: Candidate }).candidate;
    assert.equal(candidateStore.listChildren(parent.id).length, 0);

    const { result: r2 } = await executeTool(registry, {
      toolName: "create_candidate",
      input: { plan, parentCandidateId: parent.id, hypothesis: "h2 (refined from h1)", rationale: "r2" }
    });
    assert.equal(r2.status, "success");
    const child = (r2.output as { candidate: Candidate }).candidate;
    assert.deepEqual(
      candidateStore.listChildren(parent.id).map((c) => c.id),
      [child.id]
    );
  });
});
