import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorldModelState, type WorldModelState } from "@naqsh/schemas";
import { createModifyObjectTool } from "../src/modify-object-tool.js";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry } from "../src/tool-registry.js";
import { createChangeHistory } from "../src/change-history.js";
import { createApprovalStore } from "../src/approval-store.js";
import { createAutonomyGrantStore } from "../src/autonomy-grant-store.js";
import { createExecuteToolAuthorizer } from "../src/authorization.js";

function buildState(): WorldModelState {
  return createWorldModelState({
    project: {
      name: "Bracket Study",
      description: "x",
      objective: { summary: "Reduce mass by 20%." },
      objects: [{ id: "obj_1", type: "part", name: "Bracket", properties: { material: "steel", thicknessMm: 6 } }]
    },
    session: {}
  });
}

function buildHarness() {
  let state = buildState();
  const history = createChangeHistory();
  const registry = createToolRegistry();
  const { tool, handler } = createModifyObjectTool(
    () => state,
    (next) => {
      state = next;
    },
    history
  );
  registry.register(tool, handler);
  return { registry, history, getState: () => state };
}

describe("createModifyObjectTool: identity and classification", () => {
  it("is classified mutate/world_model -- P11's first real mutating tool", () => {
    const { tool } = createModifyObjectTool(buildState, () => {}, createChangeHistory());
    assert.equal(tool.mutation, "mutate");
    assert.equal(tool.target, "world_model");
    assert.equal(tool.name, "modify_object");
  });
});

describe("createModifyObjectTool: a real, audited mutation", () => {
  it("REGRESSION: successfully modifies a property and durably advances the World Model, allowed at autonomy level 'suggest' with no approval hook (test uses always-allow default)", async () => {
    const { registry, getState } = buildHarness();
    const before = getState();
    const { result } = await executeTool(registry, {
      toolName: "modify_object",
      input: { objectId: "obj_1", propertyKey: "material", value: "aluminum_6061" },
      target: { entityType: "object", entityId: "obj_1" }
    });
    assert.equal(result.status, "success");
    const after = getState();
    assert.equal(after.project.version, before.project.version + 1);
    assert.equal(after.project.objects[0]!.properties.material, "aluminum_6061");
    assert.equal(after.project.objects[0]!.properties.thicknessMm, 6);
  });

  it("REGRESSION: every successful call produces a real, auditable Change -- not a silent, unaudited write", async () => {
    const { registry, history } = buildHarness();
    assert.equal(history.list().length, 0);
    await executeTool(registry, {
      toolName: "modify_object",
      input: { objectId: "obj_1", propertyKey: "material", value: "aluminum_6061" }
    });
    assert.equal(history.list().length, 1);
    const change = history.latest()!;
    assert.equal(change.target.entityType, "object");
    assert.equal(change.target.entityId, "obj_1");
    assert.equal(change.transitionKind, "update_object");
  });

  it("rejects a nonexistent objectId with invalid_input, and performs zero mutation", async () => {
    const { registry, getState } = buildHarness();
    const before = getState();
    const { result } = await executeTool(registry, {
      toolName: "modify_object",
      input: { objectId: "obj_ghost", propertyKey: "material", value: "aluminum_6061" }
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
    assert.deepEqual(getState(), before);
  });

  it("rejects malformed input (missing propertyKey) with invalid_input from schema validation, before the handler ever runs", async () => {
    const { registry, getState } = buildHarness();
    const before = getState();
    const { result } = await executeTool(registry, { toolName: "modify_object", input: { objectId: "obj_1", value: "x" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
    assert.deepEqual(getState(), before);
  });
});

describe("createModifyObjectTool: real P4 permission integration", () => {
  it("SECURITY INVARIANT: denied at autonomy level 'observe'/'suggest' -- mutation requires at least 'approved_modify', and zero mutation occurs", async () => {
    const { registry, getState } = buildHarness();
    const before = getState();
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    for (const autonomyLevel of ["observe", "suggest"] as const) {
      const authorize = createExecuteToolAuthorizer({ autonomyLevel, approvals, autonomyGrants });
      const { result } = await executeTool(registry, {
        toolName: "modify_object",
        input: { objectId: "obj_1", propertyKey: "material", value: "aluminum_6061" },
        target: { entityType: "object", entityId: "obj_1" },
        authorize
      });
      assert.equal(result.status, "error");
      assert.equal(result.error?.kind, "policy_rejected");
    }
    assert.deepEqual(getState(), before);
  });

  it("SECURITY INVARIANT: at 'approved_modify', denied with zero mutation until a matching Approval exists and is approved", async () => {
    const { registry, getState } = buildHarness();
    const before = getState();
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "approved_modify", approvals, autonomyGrants });

    const denied = await executeTool(registry, {
      toolName: "modify_object",
      input: { objectId: "obj_1", propertyKey: "material", value: "aluminum_6061" },
      target: { entityType: "object", entityId: "obj_1" },
      authorize
    });
    assert.equal(denied.result.status, "error");
    assert.equal(denied.result.error?.kind, "policy_rejected");
    assert.deepEqual(getState(), before);

    const approval = approvals.create({ toolName: "modify_object", targetType: "object", targetId: "obj_1" });
    approvals.approve(approval.id, "human");

    const allowed = await executeTool(registry, {
      toolName: "modify_object",
      input: { objectId: "obj_1", propertyKey: "material", value: "aluminum_6061" },
      target: { entityType: "object", entityId: "obj_1" },
      authorize
    });
    assert.equal(allowed.result.status, "success");
    assert.equal(getState().project.objects[0]!.properties.material, "aluminum_6061");
  });
});
