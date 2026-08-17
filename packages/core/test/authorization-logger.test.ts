import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAuthorizationDecision } from "@naqsh/schemas";
import { createAuthorizationLogger, formatAuthorizationLogRecord } from "../src/authorization-logger.js";

function decision(overrides: Partial<Parameters<typeof createAuthorizationDecision>[0]> = {}) {
  return createAuthorizationDecision({
    toolName: "modify_object",
    target: { entityType: "object", entityId: "envobj_1" },
    autonomyLevel: "approved_modify",
    source: "agent",
    requestId: "req_1",
    allowed: true,
    ...overrides
  });
}

describe("formatAuthorizationLogRecord", () => {
  it("carries every field a reader needs to reconstruct the decision, without re-deriving it", () => {
    const record = formatAuthorizationLogRecord(decision({ allowed: false, denialReason: "approval_not_found", message: "no approval on file" }));
    assert.equal(record.toolName, "modify_object");
    assert.equal(record.allowed, false);
    assert.equal(record.denialReason, "approval_not_found");
    assert.equal(record.message, "no approval on file");
    assert.deepEqual(record.target, { entityType: "object", entityId: "envobj_1" });
  });
});

describe("createAuthorizationLogger", () => {
  it("emits one structured, JSON-parseable line per decision to the supplied sink", () => {
    const lines: string[] = [];
    const logger = createAuthorizationLogger((line) => lines.push(line));

    logger(decision({ allowed: true }));
    logger(decision({ allowed: false, denialReason: "insufficient_autonomy_level", message: "too low" }));

    assert.equal(lines.length, 2);
    const parsed = lines.map((line) => JSON.parse(line));
    assert.equal(parsed[0].allowed, true);
    assert.equal(parsed[1].allowed, false);
    assert.equal(parsed[1].denialReason, "insufficient_autonomy_level");
  });

  it("defaults to console.log when no sink is supplied -- never silently drops a decision", () => {
    const calls: unknown[][] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => calls.push(args);
    try {
      const logger = createAuthorizationLogger();
      logger(decision());
    } finally {
      console.log = original;
    }
    assert.equal(calls.length, 1);
    assert.equal(typeof calls[0]![0], "string");
    assert.doesNotThrow(() => JSON.parse(calls[0]![0] as string));
  });

  it("is wire-compatible with createExecuteToolAuthorizer's onDecision hook", async () => {
    const { createExecuteToolAuthorizer } = await import("../src/authorization.js");
    const { createApprovalStore } = await import("../src/approval-store.js");
    const { createAutonomyGrantStore } = await import("../src/autonomy-grant-store.js");
    const lines: string[] = [];
    const authorize = createExecuteToolAuthorizer({
      autonomyLevel: "observe",
      approvals: createApprovalStore(),
      autonomyGrants: createAutonomyGrantStore(),
      onDecision: createAuthorizationLogger((line) => lines.push(line))
    });
    authorize({
      tool: { name: "observe_project", target: "world_model", mutation: "observe" } as never,
      input: {},
      target: null,
      source: "agent",
      requestId: "req_2"
    });
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]!).toolName, "observe_project");
  });
});
