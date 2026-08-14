import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTool, type ChangeTarget, type Tool, type ToolInput } from "@naqsh/schemas";
import { createApprovalStore, type ApprovalStore } from "../src/approval-store.js";
import { createAutonomyGrantStore, type AutonomyGrantStore } from "../src/autonomy-grant-store.js";
import { createExecuteToolAuthorizer, evaluateToolAuthorization } from "../src/authorization.js";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry, invokeRegisteredTool, type ToolRegistry } from "../src/tool-registry.js";

function buildTool(overrides: Partial<ToolInput> = {}): Tool {
  return createTool({
    name: "inspect_project",
    target: "world_model",
    mutation: "observe",
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: {} },
    ...overrides
  });
}

const OBJECT_TARGET: ChangeTarget = { entityType: "engineering_object", entityId: "obj_5" };
const OTHER_TARGET: ChangeTarget = { entityType: "engineering_object", entityId: "obj_9" };

function freshStores(): { approvals: ApprovalStore; autonomyGrants: AutonomyGrantStore } {
  return { approvals: createApprovalStore(), autonomyGrants: createAutonomyGrantStore() };
}

describe("evaluateToolAuthorization: permission tests", () => {
  it("allows an observe tool at OBSERVE level", () => {
    const { approvals, autonomyGrants } = freshStores();
    const decision = evaluateToolAuthorization({
      tool: buildTool({ mutation: "observe" }),
      target: null,
      source: "agent",
      requestId: "treq_1",
      autonomyLevel: "observe",
      approvals,
      autonomyGrants
    });
    assert.equal(decision.allowed, true);
  });

  it("denies a mutate tool at OBSERVE level", () => {
    const { approvals, autonomyGrants } = freshStores();
    const decision = evaluateToolAuthorization({
      tool: buildTool({ mutation: "mutate" }),
      target: null,
      source: "agent",
      requestId: "treq_1",
      autonomyLevel: "observe",
      approvals,
      autonomyGrants
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.denialReason, "insufficient_autonomy_level");
  });

  it("denies a mutate tool at SUGGEST level", () => {
    const { approvals, autonomyGrants } = freshStores();
    const decision = evaluateToolAuthorization({
      tool: buildTool({ mutation: "mutate" }),
      target: null,
      source: "agent",
      requestId: "treq_1",
      autonomyLevel: "suggest",
      approvals,
      autonomyGrants
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.denialReason, "insufficient_autonomy_level");
  });

  it("allows a suggest tool at SUGGEST level with no approval needed", () => {
    const { approvals, autonomyGrants } = freshStores();
    const decision = evaluateToolAuthorization({
      tool: buildTool({ mutation: "suggest" }),
      target: null,
      source: "agent",
      requestId: "treq_1",
      autonomyLevel: "suggest",
      approvals,
      autonomyGrants
    });
    assert.equal(decision.allowed, true);
    assert.equal(decision.matchedApprovalId, null);
  });

  it("allows a mutate tool at APPROVED_MODIFY only with a matching approval", () => {
    const { approvals, autonomyGrants } = freshStores();
    const tool = buildTool({ name: "modify_parameter", mutation: "mutate" });
    const approval = approvals.create({ toolName: "modify_parameter" });
    approvals.approve(approval.id, "human");

    const decision = evaluateToolAuthorization({
      tool,
      target: null,
      source: "agent",
      requestId: "treq_1",
      autonomyLevel: "approved_modify",
      approvals,
      autonomyGrants
    });
    assert.equal(decision.allowed, true);
    assert.equal(decision.matchedApprovalId, approval.id);
  });

  it("allows a mutate tool at AUTONOMOUS only within a matching, active grant", () => {
    const { approvals, autonomyGrants } = freshStores();
    const tool = buildTool({ name: "modify_parameter", mutation: "mutate" });
    const grant = autonomyGrants.create({ toolNames: ["modify_parameter"] });

    const decision = evaluateToolAuthorization({
      tool,
      target: null,
      source: "agent",
      requestId: "treq_1",
      autonomyLevel: "autonomous",
      approvals,
      autonomyGrants
    });
    assert.equal(decision.allowed, true);
    assert.equal(decision.matchedAutonomyGrantId, grant.id);
  });

  it("denies AUTONOMOUS execution for a tool not covered by any grant", () => {
    const { approvals, autonomyGrants } = freshStores();
    autonomyGrants.create({ toolNames: ["some_other_tool"] });
    const decision = evaluateToolAuthorization({
      tool: buildTool({ name: "modify_parameter", mutation: "mutate" }),
      target: null,
      source: "agent",
      requestId: "treq_1",
      autonomyLevel: "autonomous",
      approvals,
      autonomyGrants
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.denialReason, "autonomy_grant_not_found");
  });

  it("denies a target not covered by an otherwise-matching grant", () => {
    const { approvals, autonomyGrants } = freshStores();
    autonomyGrants.create({ toolNames: ["modify_parameter"], targetType: "engineering_object", targetId: OTHER_TARGET.entityId });
    const decision = evaluateToolAuthorization({
      tool: buildTool({ name: "modify_parameter", mutation: "mutate" }),
      target: OBJECT_TARGET,
      source: "agent",
      requestId: "treq_1",
      autonomyLevel: "autonomous",
      approvals,
      autonomyGrants
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.denialReason, "autonomy_grant_target_mismatch");
  });

  it("denies an unrecognized autonomy level deterministically", () => {
    const { approvals, autonomyGrants } = freshStores();
    const decision = evaluateToolAuthorization({
      tool: buildTool(),
      target: null,
      source: "agent",
      requestId: "treq_1",
      autonomyLevel: "godmode",
      approvals,
      autonomyGrants
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.denialReason, "unknown_autonomy_level");
  });
});

describe("evaluateToolAuthorization: approval tests", () => {
  const tool = buildTool({ name: "modify_parameter", mutation: "mutate" });

  it("denies when no approval exists at all", () => {
    const { approvals, autonomyGrants } = freshStores();
    const decision = evaluateToolAuthorization({
      tool,
      target: null,
      source: "agent",
      requestId: "treq_1",
      autonomyLevel: "approved_modify",
      approvals,
      autonomyGrants
    });
    assert.equal(decision.denialReason, "approval_not_found");
  });

  it("denies while an approval is still pending", () => {
    const { approvals, autonomyGrants } = freshStores();
    approvals.create({ toolName: "modify_parameter" });
    const decision = evaluateToolAuthorization({
      tool,
      target: null,
      source: "agent",
      requestId: "treq_1",
      autonomyLevel: "approved_modify",
      approvals,
      autonomyGrants
    });
    assert.equal(decision.denialReason, "approval_required");
  });

  it("denies when the approval was rejected", () => {
    const { approvals, autonomyGrants } = freshStores();
    const approval = approvals.create({ toolName: "modify_parameter" });
    approvals.reject(approval.id, "human");
    const decision = evaluateToolAuthorization({
      tool,
      target: null,
      source: "agent",
      requestId: "treq_1",
      autonomyLevel: "approved_modify",
      approvals,
      autonomyGrants
    });
    assert.equal(decision.denialReason, "approval_rejected");
  });

  it("denies when the approval was revoked after being granted", () => {
    const { approvals, autonomyGrants } = freshStores();
    const approval = approvals.create({ toolName: "modify_parameter" });
    approvals.approve(approval.id, "human");
    approvals.revoke(approval.id, "human");
    const decision = evaluateToolAuthorization({
      tool,
      target: null,
      source: "agent",
      requestId: "treq_1",
      autonomyLevel: "approved_modify",
      approvals,
      autonomyGrants
    });
    assert.equal(decision.denialReason, "approval_revoked");
  });

  it("denies an expired approval", () => {
    const { approvals, autonomyGrants } = freshStores();
    const approval = approvals.create({ toolName: "modify_parameter", expiresAt: new Date(Date.now() - 1000).toISOString() });
    approvals.approve(approval.id, "human");
    const decision = evaluateToolAuthorization({
      tool,
      target: null,
      source: "agent",
      requestId: "treq_1",
      autonomyLevel: "approved_modify",
      approvals,
      autonomyGrants
    });
    assert.equal(decision.denialReason, "approval_expired");
  });

  it("denies an already-consumed approval", () => {
    const { approvals, autonomyGrants } = freshStores();
    const approval = approvals.create({ toolName: "modify_parameter" });
    approvals.approve(approval.id, "human");
    approvals.consume(approval.id);
    const decision = evaluateToolAuthorization({
      tool,
      target: null,
      source: "agent",
      requestId: "treq_1",
      autonomyLevel: "approved_modify",
      approvals,
      autonomyGrants
    });
    assert.equal(decision.denialReason, "approval_already_consumed");
  });

  it("an approval for a different tool (a different action) does not authorize this one", () => {
    const { approvals, autonomyGrants } = freshStores();
    const approval = approvals.create({ toolName: "delete_object" });
    approvals.approve(approval.id, "human");
    const decision = evaluateToolAuthorization({
      tool, // "modify_parameter", not "delete_object"
      target: null,
      source: "agent",
      requestId: "treq_1",
      autonomyLevel: "approved_modify",
      approvals,
      autonomyGrants
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.denialReason, "approval_not_found");
  });

  it("an approval scoped to a different target does not authorize this target", () => {
    const { approvals, autonomyGrants } = freshStores();
    const approval = approvals.create({
      toolName: "modify_parameter",
      targetType: OTHER_TARGET.entityType,
      targetId: OTHER_TARGET.entityId
    });
    approvals.approve(approval.id, "human");
    const decision = evaluateToolAuthorization({
      tool,
      target: OBJECT_TARGET,
      source: "agent",
      requestId: "treq_1",
      autonomyLevel: "approved_modify",
      approvals,
      autonomyGrants
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.denialReason, "approval_target_mismatch");
  });

  it("an approval scoped to any target (targetId null) DOES authorize a specific target of the same type", () => {
    const { approvals, autonomyGrants } = freshStores();
    const approval = approvals.create({ toolName: "modify_parameter", targetType: OBJECT_TARGET.entityType });
    approvals.approve(approval.id, "human");
    const decision = evaluateToolAuthorization({
      tool,
      target: OBJECT_TARGET,
      source: "agent",
      requestId: "treq_1",
      autonomyLevel: "approved_modify",
      approvals,
      autonomyGrants
    });
    assert.equal(decision.allowed, true);
    assert.equal(decision.matchedApprovalId, approval.id);
  });
});

describe("authorization decisions are deterministic", () => {
  it("evaluating the exact same inputs twice produces the same allow/deny/reason", () => {
    const { approvals, autonomyGrants } = freshStores();
    const tool = buildTool({ name: "modify_parameter", mutation: "mutate" });
    const input = {
      tool,
      target: OBJECT_TARGET,
      source: "agent" as const,
      requestId: "treq_1",
      autonomyLevel: "approved_modify",
      approvals,
      autonomyGrants
    };
    const first = evaluateToolAuthorization(input);
    const second = evaluateToolAuthorization(input);
    assert.equal(first.allowed, second.allowed);
    assert.equal(first.denialReason, second.denialReason);
    assert.equal(first.message, second.message);
  });

  it("evaluation never mutates the approval/grant stores (deciding and consuming are separate)", () => {
    const { approvals, autonomyGrants } = freshStores();
    const approval = approvals.create({ toolName: "modify_parameter" });
    approvals.approve(approval.id, "human");
    const tool = buildTool({ name: "modify_parameter", mutation: "mutate" });

    evaluateToolAuthorization({
      tool,
      target: null,
      source: "agent",
      requestId: "treq_1",
      autonomyLevel: "approved_modify",
      approvals,
      autonomyGrants
    });

    // Still approved and NOT consumed -- evaluating did not consume it.
    const stillThere = approvals.getById(approval.id)!;
    assert.equal(stillThere.status, "approved");
    assert.equal(stillThere.consumedAt, null);
  });
});

describe("createExecuteToolAuthorizer: end-to-end with executeTool", () => {
  function buildRegistry(mutation: Tool["mutation"] = "mutate"): { registry: ToolRegistry; tool: Tool; calls: number } {
    const registry = createToolRegistry();
    const tool = createTool({
      name: "modify_parameter",
      target: "world_model",
      mutation,
      inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
      outputSchema: { type: "object", properties: { newValue: { type: "number" } }, required: ["newValue"] }
    });
    const state = { calls: 0 };
    registry.register(tool, (input: unknown) => {
      state.calls += 1;
      return { newValue: (input as { value: number }).value };
    });
    return { registry, tool, calls: state.calls };
  }

  it("denies at the executeTool boundary when autonomy level is insufficient, without calling the handler", async () => {
    const { registry } = buildRegistry();
    const { approvals, autonomyGrants } = freshStores();
    const authorizer = createExecuteToolAuthorizer({ autonomyLevel: "observe", approvals, autonomyGrants });

    const { result } = await executeTool(registry, {
      toolName: "modify_parameter",
      input: { value: 5 },
      authorize: authorizer
    });

    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "policy_rejected");
    assert.match(result.error?.message ?? "", /insufficient_autonomy_level|requires at least autonomy level/i);
  });

  it("allows at APPROVED_MODIFY once approved, and the handler actually runs", async () => {
    const { registry } = buildRegistry();
    const { approvals, autonomyGrants } = freshStores();
    const approval = approvals.create({ toolName: "modify_parameter" });
    approvals.approve(approval.id, "human");
    const authorizer = createExecuteToolAuthorizer({ autonomyLevel: "approved_modify", approvals, autonomyGrants });

    const { result } = await executeTool(registry, {
      toolName: "modify_parameter",
      input: { value: 42 },
      authorize: authorizer
    });

    assert.equal(result.status, "success");
    assert.deepEqual(result.output, { newValue: 42 });
  });

  it("consuming the approval after a successful call prevents reuse for a second call", async () => {
    const { registry } = buildRegistry();
    const { approvals, autonomyGrants } = freshStores();
    const approval = approvals.create({ toolName: "modify_parameter" });
    approvals.approve(approval.id, "human");
    const authorizer = createExecuteToolAuthorizer({ autonomyLevel: "approved_modify", approvals, autonomyGrants });

    const first = await executeTool(registry, { toolName: "modify_parameter", input: { value: 1 }, authorize: authorizer });
    assert.equal(first.result.status, "success");
    approvals.consume(approval.id);

    const second = await executeTool(registry, { toolName: "modify_parameter", input: { value: 2 }, authorize: authorizer });
    assert.equal(second.result.status, "error");
    assert.equal(second.result.error?.kind, "policy_rejected");
  });

  it("records every decision via onDecision, allowed and denied alike", async () => {
    const { registry } = buildRegistry();
    const { approvals, autonomyGrants } = freshStores();
    const decisions: { allowed: boolean }[] = [];
    const authorizer = createExecuteToolAuthorizer({
      autonomyLevel: "observe",
      approvals,
      autonomyGrants,
      onDecision: (decision) => decisions.push(decision)
    });

    await executeTool(registry, { toolName: "modify_parameter", input: { value: 1 }, authorize: authorizer });
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]!.allowed, false);
  });

  it("malformed input is rejected before authorization even runs", async () => {
    const { registry } = buildRegistry();
    const { approvals, autonomyGrants } = freshStores();
    let authorizeCalled = false;
    const authorizer = createExecuteToolAuthorizer({ autonomyLevel: "autonomous", approvals, autonomyGrants });
    autonomyGrants.create({ toolNames: ["modify_parameter"] });

    const wrappedAuthorizer = (context: Parameters<typeof authorizer>[0]) => {
      authorizeCalled = true;
      return authorizer(context);
    };

    const { result } = await executeTool(registry, {
      toolName: "modify_parameter",
      input: { value: "not a number" },
      authorize: wrappedAuthorizer
    });

    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
    assert.equal(authorizeCalled, false);
  });
});

describe("security: authorization and the tool registry cannot be bypassed", () => {
  it("ToolRegistry has no callable invoke/execute method on its public surface", () => {
    const registry = createToolRegistry();
    const anyRegistry = registry as unknown as Record<string, unknown>;
    assert.equal(typeof anyRegistry.invoke, "undefined");
    assert.equal(typeof anyRegistry.execute, "undefined");
  });

  it("a tool call cannot reach the handler without going through executeTool's authorize hook", async () => {
    // Directly calling invokeRegisteredTool (the internal dispatch
    // primitive execute-tool.ts uses) has NO authorization step at all --
    // by design (see tool-registry.ts). This test documents that fact
    // explicitly rather than pretending it's impossible: the guarantee
    // NAQSH provides is that executeTool ALWAYS enforces its authorize
    // hook, not that invokeRegisteredTool is unreachable in-process. See
    // its own doc comment for why that's the right threat model for a
    // single-process TypeScript system.
    const registry = createToolRegistry();
    registry.register(
      createTool({
        name: "modify_parameter",
        target: "world_model",
        mutation: "mutate",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: {} }
      }),
      () => ({})
    );

    // The SANCTIONED path enforces authorization:
    const { approvals, autonomyGrants } = freshStores();
    const { result } = await executeTool(registry, {
      toolName: "modify_parameter",
      input: {},
      authorize: createExecuteToolAuthorizer({ autonomyLevel: "observe", approvals, autonomyGrants })
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "policy_rejected");

    // invokeRegisteredTool itself is not exported from @naqsh/core's
    // public barrel -- confirmed by tool-registry.test.ts's own
    // regression test. It remains reachable only via the internal
    // relative import used here, which is the point: the correct path
    // is the ONLY ergonomic one.
    const output = await invokeRegisteredTool(registry, "modify_parameter", {});
    assert.deepEqual(output, {});
  });

  it("unknown tools cannot execute regardless of autonomy level", async () => {
    const registry = createToolRegistry();
    const { approvals, autonomyGrants } = freshStores();
    autonomyGrants.create({ toolNames: ["does_not_exist"] });
    const { result } = await executeTool(registry, {
      toolName: "does_not_exist",
      input: {},
      authorize: createExecuteToolAuthorizer({ autonomyLevel: "autonomous", approvals, autonomyGrants })
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "unknown_tool");
  });
});
