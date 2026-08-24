import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { LoadingState, ErrorState, EmptyState } from "../components/common/States.js";

describe("common states", () => {
  it("LoadingState announces its label via role=status (assistive-tech visible)", () => {
    render(<LoadingState label="Observing environment…" />);
    expect(screen.getByRole("status")).toHaveTextContent("Observing environment…");
  });

  it("ErrorState uses role=alert and never claims work happened", () => {
    render(<ErrorState title="Environment disconnected" message="Naqsh cannot safely execute this proposal." />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Environment disconnected")).toBeInTheDocument();
    expect(screen.getByText("Naqsh cannot safely execute this proposal.")).toBeInTheDocument();
  });

  it("EmptyState explains what to do next rather than showing a blank screen", () => {
    render(<EmptyState title="No experiments yet" message="Once you have multiple candidate designs, Naqsh can evaluate them here." />);
    expect(screen.getByText("No experiments yet")).toBeInTheDocument();
  });
});
