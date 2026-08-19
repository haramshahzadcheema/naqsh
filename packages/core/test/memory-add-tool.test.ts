import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorldModelState, type MemoryRecord, type WorldModelState } from "@naqsh/schemas";
import { createMemoryAddTool } from "../src/memory-add-tool.js";
import { createMemoryStore } from "../src/memory-store.js";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry } from "../src/tool-registry.js";
import { createApprovalStore } from "../src/approval-store.js";
import { createAutonomyGrantStore } from "../src/autonomy-grant-store.js";
import { createExecuteToolAuthorizer } from "../src/authorization.js";

function buildHarness() {
  const memoryStore = createMemoryStore();
  let state: WorldModelState = createWorldModelState({ project: { id: "proj_1", name: "Bracket Study" }, session: {} });
  const registry = createToolRegistry();
  const { tool, handler } = createMemoryAddTool(memoryStore, () => state);
  registry.register(tool, handler);
  return { registry, memoryStore, getState: () => state, setState: (next: WorldModelState) => (state = next) };
}

describe("createMemoryAddTool: identity and classification", () => {
  it("is classified suggest/memory -- never mutates the World Model or the environment", () => {
    const { registry } = buildHarness();
    const tool = registry.getByName("memory_add")!;
    assert.equal(tool.mutation, "suggest");
    assert.equal(tool.target, "memory");
  });
});

describe("createMemoryAddTool: creation", () => {
  it("creates a valid memory and persists it", async () => {
    const harness = buildHarness();
    const { result } = await executeTool(harness.registry, {
      toolName: "memory_add",
      input: { kind: "lesson", title: "Ribbing reduces mass", content: "Ribbed brackets meet strength at lower mass.", provenanceKind: "user_statement" }
    });
    assert.equal(result.status, "success");
    const memory = (result.output as { memory: MemoryRecord }).memory;
    assert.equal(memory.projectId, "proj_1");
    assert.equal(memory.status, "active");
    assert.deepEqual(harness.memoryStore.getById(memory.id), memory);
  });

  it("reads projectId/projectVersion from LIVE WorldModelState, never caller-supplied", async () => {
    const harness = buildHarness();
    const { result } = await executeTool(harness.registry, {
      toolName: "memory_add",
      input: { kind: "lesson", title: "t", content: "c", provenanceKind: "user_statement", projectId: "proj_spoofed" }
    });
    assert.equal(result.status, "success");
    assert.equal((result.output as { memory: MemoryRecord }).memory.projectId, "proj_1");
  });

  it("accepts full references and a grounded provenanceKind", async () => {
    const harness = buildHarness();
    const { result } = await executeTool(harness.registry, {
      toolName: "memory_add",
      input: {
        kind: "verification_finding",
        title: "Candidate A failed strength",
        content: "Verification confirmed Candidate A does not meet the strength requirement.",
        provenanceKind: "verification_result",
        references: { verificationResultIds: ["verifresult_1"], candidateIds: ["candidate_a"] }
      }
    });
    assert.equal(result.status, "success");
    const memory = (result.output as { memory: MemoryRecord }).memory;
    assert.deepEqual(memory.references.verificationResultIds, ["verifresult_1"]);
    assert.deepEqual(memory.references.candidateIds, ["candidate_a"]);
  });
});

describe("createMemoryAddTool: validation", () => {
  it("rejects a missing title", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "memory_add", input: { kind: "lesson", content: "c", provenanceKind: "user_statement" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("rejects an invalid kind", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "memory_add", input: { kind: "opinion", title: "t", content: "c", provenanceKind: "user_statement" } });
    assert.equal(result.status, "error");
  });

  it("rejects an invalid provenanceKind", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "memory_add", input: { kind: "lesson", title: "t", content: "c", provenanceKind: "vibes" } });
    assert.equal(result.status, "error");
  });

  it("rejects verification_result provenance with no verificationResultIds (grounding required)", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, {
      toolName: "memory_add",
      input: { kind: "verification_finding", title: "t", content: "c", provenanceKind: "verification_result" }
    });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /verificationResultIds/);
  });

  it("rejects a decision reference to a requirement that does not exist in the current project", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, {
      toolName: "memory_add",
      input: { kind: "lesson", title: "t", content: "c", provenanceKind: "user_statement", references: { requirementIds: ["req_missing"] } }
    });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /unresolved_requirement_in_project/);
  });

  it("rejects an invalid provenance value", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, {
      toolName: "memory_add",
      input: { kind: "lesson", title: "t", content: "c", provenanceKind: "user_statement", provenance: "not_a_real_source" }
    });
    assert.equal(result.status, "error");
  });

  it("rejects a duplicate (projectId, kind, title) against an existing active memory", async () => {
    const harness = buildHarness();
    await executeTool(harness.registry, { toolName: "memory_add", input: { kind: "lesson", title: "Same title", content: "first", provenanceKind: "user_statement" } });
    const { result } = await executeTool(harness.registry, { toolName: "memory_add", input: { kind: "lesson", title: "Same title", content: "second", provenanceKind: "user_statement" } });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /possible_duplicate_memory/);
  });
});

describe("createMemoryAddTool: supersedesMemoryId declaration", () => {
  it("accepts a supersedesMemoryId referencing a real, active, same-project memory", async () => {
    const harness = buildHarness();
    const first = await executeTool(harness.registry, { toolName: "memory_add", input: { kind: "lesson", title: "Old lesson", content: "c1", provenanceKind: "user_statement" } });
    const oldId = (first.result.output as { memory: MemoryRecord }).memory.id;
    const { result } = await executeTool(harness.registry, {
      toolName: "memory_add",
      input: { kind: "lesson", title: "New lesson", content: "c2", provenanceKind: "user_statement", supersedesMemoryId: oldId }
    });
    assert.equal(result.status, "success");
    assert.equal((result.output as { memory: MemoryRecord }).memory.supersedesMemoryId, oldId);
    // memory_add does NOT itself apply the transition -- the old record is still active.
    assert.equal(harness.memoryStore.getById(oldId)!.status, "active");
  });

  it("rejects a supersedesMemoryId that does not resolve to a real memory", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, {
      toolName: "memory_add",
      input: { kind: "lesson", title: "t", content: "c", provenanceKind: "user_statement", supersedesMemoryId: "memory_missing" }
    });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /memory_not_found/);
  });

  it("rejects a supersedesMemoryId belonging to a different project", async () => {
    const harness = buildHarness();
    const first = await executeTool(harness.registry, { toolName: "memory_add", input: { kind: "lesson", title: "Old", content: "c1", provenanceKind: "user_statement" } });
    const oldId = (first.result.output as { memory: MemoryRecord }).memory.id;
    harness.setState(createWorldModelState({ project: { id: "proj_2", name: "Different Project" }, session: {} }));
    const { result } = await executeTool(harness.registry, {
      toolName: "memory_add",
      input: { kind: "lesson", title: "New", content: "c2", provenanceKind: "user_statement", supersedesMemoryId: oldId }
    });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /memory_wrong_project/);
  });

  it("rejects a supersedesMemoryId that is already archived", async () => {
    const harness = buildHarness();
    const first = await executeTool(harness.registry, { toolName: "memory_add", input: { kind: "lesson", title: "Old", content: "c1", provenanceKind: "user_statement" } });
    const oldId = (first.result.output as { memory: MemoryRecord }).memory.id;
    harness.memoryStore.archive(oldId);
    const { result } = await executeTool(harness.registry, {
      toolName: "memory_add",
      input: { kind: "lesson", title: "New", content: "c2", provenanceKind: "user_statement", supersedesMemoryId: oldId }
    });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /memory_not_active/);
  });
});

describe("createMemoryAddTool: respects real P4 authorization", () => {
  it("is rejected with policy_rejected under an autonomy level below 'suggest'", async () => {
    const harness = buildHarness();
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "observe", approvals, autonomyGrants });

    const { result } = await executeTool(harness.registry, {
      toolName: "memory_add",
      input: { kind: "lesson", title: "t", content: "c", provenanceKind: "user_statement" },
      authorize
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "policy_rejected");
    assert.equal(harness.memoryStore.list().length, 0);
  });

  it("succeeds at autonomy level 'suggest' -- a suggest-tier tool needs no Approval/AutonomyGrant", async () => {
    const harness = buildHarness();
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "suggest", approvals, autonomyGrants });

    const { result } = await executeTool(harness.registry, {
      toolName: "memory_add",
      input: { kind: "lesson", title: "t", content: "c", provenanceKind: "user_statement" },
      authorize
    });
    assert.equal(result.status, "success");
  });
});
