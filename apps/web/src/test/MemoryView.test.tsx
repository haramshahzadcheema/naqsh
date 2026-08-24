import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRecord } from "@naqsh/schemas";
import { MemoryView } from "../components/memory/MemoryView.js";

function buildRecord(overrides: Partial<Parameters<typeof createMemoryRecord>[0]> = {}) {
  return createMemoryRecord({
    projectId: "proj_1",
    projectVersion: 1,
    kind: "decision",
    title: "Selected Candidate B",
    content: "The only feasible, verification-passing candidate on the Pareto frontier.",
    provenanceKind: "user_statement",
    ...overrides
  });
}

describe("MemoryView", () => {
  it("shows an empty state when there are no memory records yet", () => {
    render(<MemoryView records={[]} />);
    expect(screen.getByText("No memory yet")).toBeInTheDocument();
  });

  it("does not render Archive/Forget actions when no onArchive handler is supplied", () => {
    render(<MemoryView records={[buildRecord()]} />);
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
  });

  it("only offers Archive/Forget for active records, never for one already archived/rejected/superseded", () => {
    const active = buildRecord({ id: "mem_active" });
    const archived = buildRecord({ id: "mem_archived", status: "archived" });
    render(<MemoryView records={[active, archived]} onArchive={vi.fn()} />);
    expect(screen.getAllByRole("button", { name: "Archive" })).toHaveLength(1);
  });

  it("calls onArchive with 'archived' when Archive is clicked", async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn().mockResolvedValue(buildRecord({ status: "archived" }));
    const record = buildRecord();
    render(<MemoryView records={[record]} onArchive={onArchive} />);

    await user.click(screen.getByRole("button", { name: "Archive" }));
    expect(onArchive).toHaveBeenCalledWith(record.id, "archived");
  });

  it("calls onArchive with 'rejected' when Forget (found incorrect) is clicked -- a distinct outcome from Archive", async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn().mockResolvedValue(buildRecord({ status: "rejected" }));
    const record = buildRecord();
    render(<MemoryView records={[record]} onArchive={onArchive} />);

    await user.click(screen.getByRole("button", { name: "Forget (found incorrect)" }));
    expect(onArchive).toHaveBeenCalledWith(record.id, "rejected");
  });

  it("shows the real failure reason, never a silently-swallowed error, when the transition fails", async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn().mockRejectedValue(new Error("Memory already archived."));
    render(<MemoryView records={[buildRecord()]} onArchive={onArchive} />);

    await user.click(screen.getByRole("button", { name: "Archive" }));
    expect(await screen.findByText("Memory already archived.")).toBeInTheDocument();
  });
});
