import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryRecord, createWorldModelState, type MemoryRecord, type MemoryRecordInput, type WorldModelState } from "@naqsh/schemas";
import { createMemorySupersedeTool } from "../src/memory-supersede-tool.js";
import { createMemoryStore } from "../src/memory-store.js";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry } from "../src/tool-registry.js";
import { createApprovalStore } from "../src/approval-store.js";
import { createAutonomyGrantStore } from "../src/autonomy-grant-store.js";
import { createExecuteToolAuthorizer } from "../src/authorization.js";

function memoryInput(overrides: Partial<MemoryRecordInput> = {}): MemoryRecordInput {
  return {
    projectId: "proj_1",
    projectVersion: 1,
    kind: "lesson",
    title: "Ribbing reduces mass",
    content: "Ribbed brackets meet strength at lower mass.",
    provenanceKind: "user_statement",
    ...overrides
  };
}

function buildHarness() {
  const memoryStore = createMemoryStore();
  const state: WorldModelState = createWorldModelState({ project: { id: "proj_1", name: "Bracket Study" }, session: {} });
  const registry = createToolRegistry();
  const { tool, handler } = createMemorySupersedeTool(memoryStore, () => state);
  registry.register(tool, handler);
  return { registry, memoryStore, getState: () => state };
}

describe("createMemorySupersedeTool: identity and classification", () => {
  it("is classified suggest/memory", () => {
    const { registry } = buildHarness();
    const tool = registry.getByName("memory_supersede")!;
    assert.equal(tool.mutation, "suggest");
    assert.equal(tool.target, "memory");
  });
});

describe("createMemorySupersedeTool: supersession", () => {
  it("transitions the old memory to superseded, linking it to the new one; neither is deleted", async () => {
    const harness = buildHarness();
    const oldMemory = createMemoryRecord(memoryInput({ title: "Old" }));
    const newMemory = createMemoryRecord(memoryInput({ title: "New" }));
    harness.memoryStore.save(oldMemory);
    harness.memoryStore.save(newMemory);
    const { result } = await executeTool(harness.registry, { toolName: "memory_supersede", input: { oldMemoryId: oldMemory.id, newMemoryId: newMemory.id } });
    assert.equal(result.status, "success");
    const output = (result.output as { memory: MemoryRecord }).memory;
    assert.equal(output.status, "superseded");
    assert.equal(output.supersededByMemoryId, newMemory.id);
    assert.ok(harness.memoryStore.getById(oldMemory.id));
    assert.ok(harness.memoryStore.getById(newMemory.id));
  });

  it("rejects a cycle: A supersedes B, then B attempts to supersede A", async () => {
    const harness = buildHarness();
    const a = createMemoryRecord(memoryInput({ title: "A" }));
    const b = createMemoryRecord(memoryInput({ title: "B" }));
    harness.memoryStore.save(a);
    harness.memoryStore.save(b);
    await executeTool(harness.registry, { toolName: "memory_supersede", input: { oldMemoryId: a.id, newMemoryId: b.id } });
    const { result } = await executeTool(harness.registry, { toolName: "memory_supersede", input: { oldMemoryId: b.id, newMemoryId: a.id } });
    assert.equal(result.status, "error");
  });
});

describe("createMemorySupersedeTool: validation", () => {
  it("rejects a nonexistent oldMemoryId", async () => {
    const harness = buildHarness();
    const newMemory = createMemoryRecord(memoryInput());
    harness.memoryStore.save(newMemory);
    const { result } = await executeTool(harness.registry, { toolName: "memory_supersede", input: { oldMemoryId: "memory_missing", newMemoryId: newMemory.id } });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /memory_not_found/);
  });

  it("rejects a nonexistent newMemoryId", async () => {
    const harness = buildHarness();
    const oldMemory = createMemoryRecord(memoryInput());
    harness.memoryStore.save(oldMemory);
    const { result } = await executeTool(harness.registry, { toolName: "memory_supersede", input: { oldMemoryId: oldMemory.id, newMemoryId: "memory_missing" } });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /memory_not_found/);
  });

  it("rejects superseding an already-superseded memory", async () => {
    const harness = buildHarness();
    const a = createMemoryRecord(memoryInput({ title: "A" }));
    const b = createMemoryRecord(memoryInput({ title: "B" }));
    const c = createMemoryRecord(memoryInput({ title: "C" }));
    harness.memoryStore.save(a);
    harness.memoryStore.save(b);
    harness.memoryStore.save(c);
    await executeTool(harness.registry, { toolName: "memory_supersede", input: { oldMemoryId: a.id, newMemoryId: b.id } });
    const { result } = await executeTool(harness.registry, { toolName: "memory_supersede", input: { oldMemoryId: a.id, newMemoryId: c.id } });
    assert.equal(result.status, "error");
  });
});

describe("createMemorySupersedeTool: project isolation", () => {
  it("rejects when oldMemoryId belongs to a different project", async () => {
    const harness = buildHarness();
    const otherProjectMemory = createMemoryRecord(memoryInput({ projectId: "proj_other", title: "Other" }));
    const newMemory = createMemoryRecord(memoryInput({ title: "New" }));
    harness.memoryStore.save(otherProjectMemory);
    harness.memoryStore.save(newMemory);
    const { result } = await executeTool(harness.registry, { toolName: "memory_supersede", input: { oldMemoryId: otherProjectMemory.id, newMemoryId: newMemory.id } });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /memory_not_found/);
  });

  it("rejects when newMemoryId belongs to a different project", async () => {
    const harness = buildHarness();
    const oldMemory = createMemoryRecord(memoryInput({ title: "Old" }));
    const otherProjectMemory = createMemoryRecord(memoryInput({ projectId: "proj_other", title: "Other" }));
    harness.memoryStore.save(oldMemory);
    harness.memoryStore.save(otherProjectMemory);
    const { result } = await executeTool(harness.registry, { toolName: "memory_supersede", input: { oldMemoryId: oldMemory.id, newMemoryId: otherProjectMemory.id } });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /memory_not_found/);
  });
});

describe("createMemorySupersedeTool: respects real P4 authorization", () => {
  it("is rejected with policy_rejected under an autonomy level below 'suggest'", async () => {
    const harness = buildHarness();
    const oldMemory = createMemoryRecord(memoryInput({ title: "Old" }));
    const newMemory = createMemoryRecord(memoryInput({ title: "New" }));
    harness.memoryStore.save(oldMemory);
    harness.memoryStore.save(newMemory);
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "observe", approvals, autonomyGrants });
    const { result } = await executeTool(harness.registry, {
      toolName: "memory_supersede",
      input: { oldMemoryId: oldMemory.id, newMemoryId: newMemory.id },
      authorize
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "policy_rejected");
    assert.equal(harness.memoryStore.getById(oldMemory.id)!.status, "active");
  });

  it("succeeds at autonomy level 'suggest' -- a suggest-tier tool needs no Approval/AutonomyGrant", async () => {
    const harness = buildHarness();
    const oldMemory = createMemoryRecord(memoryInput({ title: "Old" }));
    const newMemory = createMemoryRecord(memoryInput({ title: "New" }));
    harness.memoryStore.save(oldMemory);
    harness.memoryStore.save(newMemory);
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "suggest", approvals, autonomyGrants });
    const { result } = await executeTool(harness.registry, {
      toolName: "memory_supersede",
      input: { oldMemoryId: oldMemory.id, newMemoryId: newMemory.id },
      authorize
    });
    assert.equal(result.status, "success");
    assert.equal(harness.memoryStore.getById(oldMemory.id)!.status, "superseded");
  });
});
