import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDesignSpecification } from "@naqsh/schemas";
import { ArtifactsView } from "../components/artifacts/ArtifactsView.js";

function buildSpec(overrides: Partial<Parameters<typeof createDesignSpecification>[0]> = {}) {
  return createDesignSpecification({
    projectId: "proj_1",
    projectVersion: 1,
    planId: "plan_1",
    planStepId: "step_1",
    objectiveSummary: "Reduce mass by 20% while keeping the 50kg load capacity.",
    description: "Ribbed mounting bracket",
    material: "6061-T6 aluminum",
    manufacturingIntent: "CNC milled from billet",
    components: [
      { id: "comp_1", name: "Base plate", type: "plate", geometryIntent: "100x60x5mm rectangular plate", dimensions: { length: 100, width: 60, thickness: 5 } },
      { id: "comp_2", name: "Reinforcing rib", type: "rib", geometryIntent: "single centered rib, 4mm thick" }
    ],
    ...overrides
  });
}

describe("ArtifactsView", () => {
  it("shows an honest empty state when there are no design specifications yet", () => {
    render(<ArtifactsView designSpecifications={[]} />);
    expect(screen.getByText("No artifacts yet")).toBeInTheDocument();
  });

  it("renders a real design specification as a card with its actual status and component count", () => {
    const spec = buildSpec();
    render(<ArtifactsView designSpecifications={[spec]} />);
    expect(screen.getByText("Ribbed mounting bracket")).toBeInTheDocument();
    expect(screen.getByText("proposed")).toBeInTheDocument();
    expect(screen.getByText(/2 components/)).toBeInTheDocument();
    expect(screen.getByText(/Reduce mass by 20%/)).toBeInTheDocument();
  });

  it("expands to show the real component table only after Preview is clicked", async () => {
    const user = userEvent.setup();
    const spec = buildSpec();
    render(<ArtifactsView designSpecifications={[spec]} />);

    expect(screen.queryByText("Base plate")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByText("Base plate")).toBeInTheDocument();
    expect(screen.getByText("Reinforcing rib")).toBeInTheDocument();
    expect(screen.getByText("6061-T6 aluminum")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Hide details" }));
    expect(screen.queryByText("Base plate")).not.toBeInTheDocument();
  });

  it("sorts multiple specifications most-recent-first", () => {
    const older = buildSpec({ description: "Older design", createdAt: "2024-01-01T00:00:00.000Z" });
    const newer = buildSpec({ description: "Newer design", createdAt: "2024-06-01T00:00:00.000Z" });
    render(<ArtifactsView designSpecifications={[older, newer]} />);
    const titles = screen.getAllByRole("heading", { level: 3 }).map((el) => el.textContent);
    expect(titles).toEqual(["Newer design", "Older design"]);
  });
});
