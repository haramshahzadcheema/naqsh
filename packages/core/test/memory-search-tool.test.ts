import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryRecord, createWorldModelState, type MemoryRecord, type MemoryRecordInput, type WorldModelState } from "@naqsh/schemas";
import { createMemorySearchTool } from "../src/memory-search-tool.js";
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
  const { tool, handler } = createMemorySearchTool(memoryStore, () => state);
  registry.register(tool, handler);
  return { registry, memoryStore, getState: () => state };
}

describe("createMemorySearchTool: identity and classification", () => {
  it("is classified observe/memory -- read-only", () => {
    const { registry } = buildHarness();
    const tool = registry.getByName("memory_search")!;
    assert.equal(tool.mutation, "observe");
    assert.equal(tool.target, "memory");
  });
});

describe("createMemorySearchTool: project isolation", () => {
  it("never returns memory from a different project, even if the caller tries to name one", async () => {
    const harness = buildHarness();
    harness.memoryStore.save(createMemoryRecord(memoryInput({ projectId: "proj_1", title: "In project" })));
    harness.memoryStore.save(createMemoryRecord(memoryInput({ projectId: "proj_other", title: "Other project" })));
    const { result } = await executeTool(harness.registry, { toolName: "memory_search", input: {} });
    assert.equal(result.status, "success");
    const output = result.output as { records: MemoryRecord[] };
    assert.equal(output.records.length, 1);
    assert.equal(output.records[0]!.projectId, "proj_1");
  });
});

describe("createMemorySearchTool: filters and results", () => {
  it("filters by kind", async () => {
    const harness = buildHarness();
    harness.memoryStore.save(createMemoryRecord(memoryInput({ kind: "lesson", title: "L" })));
    harness.memoryStore.save(createMemoryRecord(memoryInput({ kind: "failure", title: "F" })));
    const { result } = await executeTool(harness.registry, { toolName: "memory_search", input: { kind: "failure" } });
    const output = result.output as { records: MemoryRecord[] };
    assert.equal(output.records.length, 1);
    assert.equal(output.records[0]!.kind, "failure");
  });

  it("returns totalMatched and limit alongside truncated records", async () => {
    const harness = buildHarness();
    for (let i = 0; i < 5; i += 1) {
      harness.memoryStore.save(createMemoryRecord(memoryInput({ title: `Memory ${i}` })));
    }
    const { result } = await executeTool(harness.registry, { toolName: "memory_search", input: { limit: 2 } });
    const output = result.output as { records: MemoryRecord[]; totalMatched: number; limit: number };
    assert.equal(output.records.length, 2);
    assert.equal(output.totalMatched, 5);
    assert.equal(output.limit, 2);
  });

  it("status defaults to active only", async () => {
    const harness = buildHarness();
    const memory = createMemoryRecord(memoryInput({ title: "Will archive" }));
    harness.memoryStore.save(memory);
    harness.memoryStore.archive(memory.id);
    const { result } = await executeTool(harness.registry, { toolName: "memory_search", input: {} });
    const output = result.output as { records: MemoryRecord[] };
    assert.equal(output.records.length, 0);
  });

  it("explicit status: archived retrieves archived history", async () => {
    const harness = buildHarness();
    const memory = createMemoryRecord(memoryInput({ title: "Will archive" }));
    harness.memoryStore.save(memory);
    harness.memoryStore.archive(memory.id);
    const { result } = await executeTool(harness.registry, { toolName: "memory_search", input: { status: "archived" } });
    const output = result.output as { records: MemoryRecord[] };
    assert.equal(output.records.length, 1);
  });
});

describe("createMemorySearchTool: validation", () => {
  it("rejects an invalid kind", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "memory_search", input: { kind: "opinion" } });
    assert.equal(result.status, "error");
  });

  it("rejects a non-positive explicit limit", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "memory_search", input: { limit: 0 } });
    assert.equal(result.status, "error");
  });
});

describe("createMemorySearchTool: respects real P4 authorization", () => {
  it("succeeds at autonomy level 'observe' -- an observe-tier tool needs no elevated authorization", async () => {
    const harness = buildHarness();
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "observe", approvals, autonomyGrants });
    const { result } = await executeTool(harness.registry, { toolName: "memory_search", input: {}, authorize });
    assert.equal(result.status, "success");
  });
});
