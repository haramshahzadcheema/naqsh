import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createClarification, createRequirement, createRequirementCandidate } from "@naqsh/schemas";
import { RequirementsView } from "../components/requirements/RequirementsView.js";

describe("RequirementsView", () => {
  it("renders an empty state when there is nothing yet", () => {
    render(<RequirementsView requirements={[]} constraints={[]} clarifications={[]} onAnswerClarification={vi.fn()} />);
    expect(screen.getByText("No requirements yet")).toBeInTheDocument();
  });

  it("renders confirmed requirements with source and status", () => {
    const requirement = createRequirement({ description: "Must support 50 kg.", category: "structural", value: 50, unit: "kg", priority: "high", status: "active", source: "human" });
    render(<RequirementsView requirements={[requirement]} constraints={[]} clarifications={[]} onAnswerClarification={vi.fn()} />);
    expect(screen.getByText("Must support 50 kg.")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  it("presents missing information as something Naqsh noticed, and submits an answer", async () => {
    const user = userEvent.setup();
    const candidate = createRequirementCandidate({
      projectId: "proj_1",
      projectVersion: 1,
      statementText: "It needs to handle the load.",
      description: "Material unspecified.",
      category: "material",
      interpretationStatus: "ambiguous",
      ambiguityReason: "No material or finish was named in the original statement."
    });
    const clarification = createClarification({
      projectId: "proj_1",
      requirementCandidateId: candidate.id,
      candidateSnapshot: candidate,
      question: "What material should the bracket be made from?",
      reason: "No material was specified.",
      category: "missing_target",
      affectedFields: ["value", "unit"]
    });
    const onAnswer = vi.fn().mockResolvedValue(undefined);

    render(<RequirementsView requirements={[]} constraints={[]} clarifications={[clarification]} onAnswerClarification={onAnswer} />);

    expect(screen.getByText("Naqsh noticed missing information")).toBeInTheDocument();
    expect(screen.getByText("What material should the bracket be made from?")).toBeInTheDocument();

    await user.type(screen.getByLabelText(/Answer for/), "Aluminum 6061-T6");
    await user.click(screen.getByRole("button", { name: "Answer" }));

    expect(onAnswer).toHaveBeenCalledWith(clarification.id, "Aluminum 6061-T6");
  });
});
