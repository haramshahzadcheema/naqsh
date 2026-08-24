import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatSidebar } from "../components/chat/ChatSidebar.js";
import type { ChatThread } from "../chat/types.js";

function buildThread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: overrides.id ?? "thread_1",
    projectId: null,
    kind: "new",
    title: "Mounting bracket",
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

function renderSidebar(threads: ChatThread[], overrides: Partial<Parameters<typeof ChatSidebar>[0]> = {}) {
  const handlers = {
    onSelectThread: vi.fn(),
    onNewThread: vi.fn(),
    onRenameThread: vi.fn(),
    onDeleteThread: vi.fn(),
    onTogglePinThread: vi.fn(),
    onToggleArchiveThread: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenSearch: vi.fn()
  };
  render(<ChatSidebar threads={threads} activeThreadId={null} {...handlers} {...overrides} />);
  return handlers;
}

describe("ChatSidebar", () => {
  it("calls onTogglePinThread with the real thread id when Pin is clicked", async () => {
    const user = userEvent.setup();
    const thread = buildThread();
    const handlers = renderSidebar([thread]);
    await user.click(screen.getByRole("button", { name: "Pin Mounting bracket" }));
    expect(handlers.onTogglePinThread).toHaveBeenCalledWith(thread.id);
  });

  it("shows Unpin (not Pin) for a thread that's already pinned", () => {
    renderSidebar([buildThread({ pinned: true })]);
    expect(screen.getByRole("button", { name: "Unpin Mounting bracket" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pin Mounting bracket" })).not.toBeInTheDocument();
  });

  it("calls onToggleArchiveThread when Archive is clicked", async () => {
    const user = userEvent.setup();
    const thread = buildThread();
    const handlers = renderSidebar([thread]);
    await user.click(screen.getByRole("button", { name: "Archive Mounting bracket" }));
    expect(handlers.onToggleArchiveThread).toHaveBeenCalledWith(thread.id);
  });

  it("hides archived threads from the main list, showing them only inside a collapsed Archived section", () => {
    renderSidebar([buildThread({ archived: true, title: "Old idea" })]);
    expect(screen.queryByText("Old idea")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archived (1)" })).toBeInTheDocument();
  });

  it("reveals an archived thread on expanding the Archived section", async () => {
    const user = userEvent.setup();
    renderSidebar([buildThread({ archived: true, title: "Old idea" })]);
    await user.click(screen.getByRole("button", { name: "Archived (1)" }));
    expect(screen.getByText("Old idea")).toBeInTheDocument();
  });

  it("does not show an Archived section at all when nothing is archived", () => {
    renderSidebar([buildThread()]);
    expect(screen.queryByText(/^Archived/)).not.toBeInTheDocument();
  });

  it("offers Pin and Archive on the demo (existing) thread too, but never Rename/Delete", () => {
    renderSidebar([buildThread({ kind: "existing", title: "Motor Mounting Bracket" })]);
    expect(screen.getByRole("button", { name: "Pin Motor Mounting Bracket" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive Motor Mounting Bracket" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rename Motor Mounting Bracket" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete Motor Mounting Bracket" })).not.toBeInTheDocument();
  });
});
