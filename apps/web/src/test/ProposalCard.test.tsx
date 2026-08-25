import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createEngineeringObject, createProposal } from "@naqsh/schemas";
import { ProposalCard } from "../components/proposal/ProposalCard.js";

function buildProposal(overrides: Partial<Parameters<typeof createProposal>[0]> = {}) {
  return createProposal({
    projectId: "proj_1",
    projectVersion: 1,
    planId: "plan_1",
    planStepId: "step_1",
    objectiveSummary: "Increase mounting-hole offset.",
    toolName: "modify_environment_object",
    toolTarget: "environment",
    input: { objectId: "envobj_1", propertyKey: "holeOffsetMm", value: 5 },
    target: { entityType: "object", entityId: "envobj_1" },
    rationale: "Clearance is too tight.",
    expectedEffect: "Clearance increases to 5 mm.",
    ...overrides
  });
}

describe("ProposalCard", () => {
  it("shows what will change, why, and the expected effect", () => {
    render(<ProposalCard proposal={buildProposal()} onApprove={vi.fn()} onReject={vi.fn()} />);
    expect(screen.getByText("Increase mounting-hole offset.")).toBeInTheDocument();
    expect(screen.getByText("Clearance is too tight.")).toBeInTheDocument();
    expect(screen.getByText("Clearance increases to 5 mm.")).toBeInTheDocument();
  });

  it("calls onApprove when Approve is clicked", async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn().mockResolvedValue(undefined);
    render(<ProposalCard proposal={buildProposal()} onApprove={onApprove} onReject={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Approve change" }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("AUDIT FIX: a fast double-click on Approve only calls onApprove ONCE -- reproduces the real race a user hit live (React's re-render that disables the button lags one tick behind a real double-click, and the second click used to reach the server and come back with a confusing 'already approved' error)", async () => {
    let resolveApprove!: () => void;
    const onApprove = vi.fn(() => new Promise<void>((resolve) => (resolveApprove = resolve)));
    render(<ProposalCard proposal={buildProposal()} onApprove={onApprove} onReject={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Approve change" });
    // fireEvent (not userEvent, which serializes interactions with its own
    // awaits) fires both click events on the SAME tick, before React has
    // any chance to re-render and flip `disabled` -- exactly the race a
    // real fast double-click reproduces.
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onApprove).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveApprove();
    });
  });

  it("calls onReject when Reject is clicked", async () => {
    const user = userEvent.setup();
    const onReject = vi.fn().mockResolvedValue(undefined);
    render(<ProposalCard proposal={buildProposal()} onApprove={vi.fn()} onReject={onReject} />);
    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it("disables both actions once the proposal is already decided", () => {
    render(<ProposalCard proposal={buildProposal({ status: "approved" })} onApprove={vi.fn()} onReject={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Approve change" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
    expect(screen.getByText("approved")).toBeInTheDocument();
  });

  it("shows a genuine Before -> After when the target object's current value is known", () => {
    const object = createEngineeringObject({ id: "envobj_1", type: "part", name: "Plate", properties: { holeOffsetMm: 2.4 } });
    render(<ProposalCard proposal={buildProposal()} objects={[object]} onApprove={vi.fn()} onReject={vi.fn()} />);
    expect(screen.getByText("2.4")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.queryByText("current value unknown")).not.toBeInTheDocument();
  });

  it("honestly says the current value is unknown, rather than fabricating one, when the target object isn't in the World Model yet", () => {
    render(<ProposalCard proposal={buildProposal()} objects={[]} onApprove={vi.fn()} onReject={vi.fn()} />);
    expect(screen.getByText("current value unknown")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("states the real revertibility guarantee (a checkpoint is always taken before execution), never a fabricated risk score", () => {
    render(<ProposalCard proposal={buildProposal()} onApprove={vi.fn()} onReject={vi.fn()} />);
    expect(screen.getByText(/Reversible -- Naqsh saves a checkpoint before executing/)).toBeInTheDocument();
    expect(screen.queryByText(/^Risk$/)).not.toBeInTheDocument();
  });
});
