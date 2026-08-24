import { describe, expect, it } from "vitest";
import { groupThreads, archivedThreads } from "../chat/groupThreads.js";
import type { ChatThread } from "../chat/types.js";

function buildThread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: overrides.id ?? "thread_1",
    projectId: null,
    kind: "new",
    title: "Untitled",
    createdAt: new Date().toISOString(),
    messages: [],
    scriptStep: 0,
    extractions: [],
    requirements: [],
    constraints: [],
    understandingConfirmed: false,
    workflowEvents: [],
    executions: {},
    ...overrides
  };
}

describe("groupThreads", () => {
  it("puts a pinned thread in its own Pinned group, first", () => {
    const pinned = buildThread({ id: "t_pinned", pinned: true, createdAt: "2020-01-01T00:00:00.000Z" });
    const todayThread = buildThread({ id: "t_today" });
    const groups = groupThreads([todayThread, pinned]);
    expect(groups[0]?.label).toBe("Pinned");
    expect(groups[0]?.threads).toEqual([pinned]);
  });

  it("never shows a pinned thread twice -- it does not also appear in its date bucket", () => {
    const pinned = buildThread({ id: "t_pinned", pinned: true });
    const groups = groupThreads([pinned]);
    const allShown = groups.flatMap((g) => g.threads.map((t) => t.id));
    expect(allShown).toEqual(["t_pinned"]);
  });

  it("excludes archived threads from the main grouped list entirely", () => {
    const archived = buildThread({ id: "t_archived", archived: true });
    const active = buildThread({ id: "t_active" });
    const groups = groupThreads([archived, active]);
    const allShown = groups.flatMap((g) => g.threads.map((t) => t.id));
    expect(allShown).not.toContain("t_archived");
    expect(allShown).toContain("t_active");
  });

  it("an archived AND pinned thread still counts as archived -- it does not leak into Pinned", () => {
    const both = buildThread({ id: "t_both", pinned: true, archived: true });
    const groups = groupThreads([both]);
    expect(groups.flatMap((g) => g.threads.map((t) => t.id))).not.toContain("t_both");
  });
});

describe("archivedThreads", () => {
  it("returns only archived threads, newest first", () => {
    const older = buildThread({ id: "t_old", archived: true, createdAt: "2020-01-01T00:00:00.000Z" });
    const newer = buildThread({ id: "t_new", archived: true, createdAt: "2024-01-01T00:00:00.000Z" });
    const active = buildThread({ id: "t_active" });
    expect(archivedThreads([older, active, newer]).map((t) => t.id)).toEqual(["t_new", "t_old"]);
  });

  it("returns an empty array when nothing is archived", () => {
    expect(archivedThreads([buildThread()])).toEqual([]);
  });
});
