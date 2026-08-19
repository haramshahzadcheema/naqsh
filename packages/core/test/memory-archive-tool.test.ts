import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryRecord, createWorldModelState, type MemoryRecord, type MemoryRecordInput, type WorldModelState } from "@naqsh/schemas";
import { createMemoryArchiveTool } from "../src/memory-archive-tool.js";
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
  const { tool, handler } = createMemoryArchiveTool(memoryStore, () => state);
  registry.register(tool, handler);
  return { registry, memoryStore, getState: () => state };
}

describe("createMemoryArchiveTool: identity and classification", () => {
  it("is classified suggest/memory", () => {
    const { registry } = buildHarness();
    const tool = registry.getByName("memory_archive")!;
    assert.equal(tool.mutation, "suggest");
    assert.equal(tool.target, "memory");
  });
});

describe("createMemoryArchiveTool: archival", () => {
  it("archives an active memory, defaulting status to 'archived'", async () => {
    const harness = buildHarness();
    const memory = createMemoryRecord(memoryInput());
    harness.memoryStore.save(memory);
    const { result } = await executeTool(harness.registry, { toolName: "memory_archive", input: { memoryId: memory.id, reason: "no longer relevant" } });
    assert.equal(result.status, "success");
    const output = (result.output as { memory: MemoryRecord }).memory;
    assert.equal(output.status, "archived");
    assert.equal(output.metadata.archiveReason, "no longer relevant");
  });

  it("rejects with status 'rejected' when explicitly requested", async () => {
    const harness = buildHarness();
    const memory = createMemoryRecord(memoryInput());
    harness.memoryStore.save(memory);
    const { result } = await executeTool(harness.registry, { toolName: "memory_archive", input: { memoryId: memory.id, status: "rejected" } });
    assert.equal((result.output as { memory: MemoryRecord }).memory.status, "rejected");
  });

  it("never touches title/content -- only lifecycle fields change", async () => {
    const harness = buildHarness();
    const memory = createMemoryRecord(memoryInput());
    harness.memoryStore.save(memory);
    const { result } = await executeTool(harness.registry, { toolName: "memory_archive", input: { memoryId: memory.id } });
    const output = (result.output as { memory: MemoryRecord }).memory;
    assert.equal(output.title, memory.title);
    assert.equal(output.content, memory.content);
  });
});

describe("createMemoryArchiveTool: validation", () => {
  it("rejects a nonexistent memoryId", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "memory_archive", input: { memoryId: "memory_missing" } });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /memory_not_found/);
  });

  it("rejects an invalid status", async () => {
    const harness = buildHarness();
    const memory = createMemoryRecord(memoryInput());
    harness.memoryStore.save(memory);
    const { result } = await executeTool(harness.registry, { toolName: "memory_archive", input: { memoryId: memory.id, status: "deleted" } });
    assert.equal(result.status, "error");
  });

  it("rejects archiving an already-archived memory", async () => {
    const harness = buildHarness();
    const memory = createMemoryRecord(memoryInput());
    harness.memoryStore.save(memory);
    harness.memoryStore.archive(memory.id);
    const { result } = await executeTool(harness.registry, { toolName: "memory_archive", input: { memoryId: memory.id } });
    assert.equal(result.status, "error");
  });
});

describe("createMemoryArchiveTool: project isolation", () => {
  it("treats a memory from a different project as not found", async () => {
    const harness = buildHarness();
    const otherProjectMemory = createMemoryRecord(memoryInput({ projectId: "proj_other" }));
    harness.memoryStore.save(otherProjectMemory);
    const { result } = await executeTool(harness.registry, { toolName: "memory_archive", input: { memoryId: otherProjectMemory.id } });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /memory_not_found/);
    assert.equal(harness.memoryStore.getById(otherProjectMemory.id)!.status, "active");
  });
});

describe("createMemoryArchiveTool: respects real P4 authorization", () => {
  it("is rejected with policy_rejected under an autonomy level below 'suggest'", async () => {
    const harness = buildHarness();
    const memory = createMemoryRecord(memoryInput());
    harness.memoryStore.save(memory);
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "observe", approvals, autonomyGrants });
    const { result } = await executeTool(harness.registry, { toolName: "memory_archive", input: { memoryId: memory.id }, authorize });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "policy_rejected");
    assert.equal(harness.memoryStore.getById(memory.id)!.status, "active");
  });
});
