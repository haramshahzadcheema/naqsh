import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryRecord, createWorldModelState, type MemoryRecord, type MemoryRecordInput, type WorldModelState } from "@naqsh/schemas";
import { createMemoryGetTool } from "../src/memory-get-tool.js";
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
  const { tool, handler } = createMemoryGetTool(memoryStore, () => state);
  registry.register(tool, handler);
  return { registry, memoryStore, getState: () => state };
}

describe("createMemoryGetTool: identity and classification", () => {
  it("is classified observe/memory -- read-only", () => {
    const { registry } = buildHarness();
    const tool = registry.getByName("memory_get")!;
    assert.equal(tool.mutation, "observe");
    assert.equal(tool.target, "memory");
  });
});

describe("createMemoryGetTool: retrieval", () => {
  it("retrieves a memory by id with an empty related list when nothing else exists", async () => {
    const harness = buildHarness();
    const memory = createMemoryRecord(memoryInput());
    harness.memoryStore.save(memory);
    const { result } = await executeTool(harness.registry, { toolName: "memory_get", input: { memoryId: memory.id } });
    assert.equal(result.status, "success");
    const output = result.output as { memory: MemoryRecord; related: unknown[] };
    assert.equal(output.memory.id, memory.id);
    assert.deepEqual(output.related, []);
  });

  it("includes a related memory sharing a reference id", async () => {
    const harness = buildHarness();
    const target = createMemoryRecord(memoryInput({ references: { candidateIds: ["candidate_7"] } }));
    const related = createMemoryRecord(memoryInput({ title: "Related", references: { candidateIds: ["candidate_7"] } }));
    harness.memoryStore.save(target);
    harness.memoryStore.save(related);
    const { result } = await executeTool(harness.registry, { toolName: "memory_get", input: { memoryId: target.id } });
    const output = result.output as { related: Array<{ memory: MemoryRecord; relation: string }> };
    assert.equal(output.related.length, 1);
    assert.equal(output.related[0]!.memory.id, related.id);
    assert.equal(output.related[0]!.relation, "shares_reference");
  });

  it("rejects a nonexistent memoryId", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "memory_get", input: { memoryId: "memory_missing" } });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /memory_not_found/);
  });
});

describe("createMemoryGetTool: project isolation", () => {
  it("treats a memory from a different project as not found", async () => {
    const harness = buildHarness();
    const otherProjectMemory = createMemoryRecord(memoryInput({ projectId: "proj_other" }));
    harness.memoryStore.save(otherProjectMemory);
    const { result } = await executeTool(harness.registry, { toolName: "memory_get", input: { memoryId: otherProjectMemory.id } });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /memory_not_found/);
  });

  it("does not surface a related memory belonging to a different project", async () => {
    const harness = buildHarness();
    const target = createMemoryRecord(memoryInput({ references: { candidateIds: ["candidate_7"] } }));
    const crossProjectRelated = createMemoryRecord(memoryInput({ projectId: "proj_other", title: "Cross-project", references: { candidateIds: ["candidate_7"] } }));
    harness.memoryStore.save(target);
    harness.memoryStore.save(crossProjectRelated);
    const { result } = await executeTool(harness.registry, { toolName: "memory_get", input: { memoryId: target.id } });
    const output = result.output as { related: unknown[] };
    assert.deepEqual(output.related, []);
  });
});

describe("createMemoryGetTool: respects real P4 authorization", () => {
  it("succeeds at autonomy level 'observe' -- an observe-tier tool needs no elevated authorization", async () => {
    const harness = buildHarness();
    const memory = createMemoryRecord(memoryInput());
    harness.memoryStore.save(memory);
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "observe", approvals, autonomyGrants });
    const { result } = await executeTool(harness.registry, { toolName: "memory_get", input: { memoryId: memory.id }, authorize });
    assert.equal(result.status, "success");
  });
});
