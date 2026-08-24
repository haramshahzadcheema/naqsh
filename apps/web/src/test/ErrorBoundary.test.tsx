import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ErrorBoundary } from "../components/common/ErrorBoundary.js";

function Bomb(): JSX.Element {
  throw new Error("Simulated render crash for a real test, not a fabricated one.");
}

afterEach(cleanup);

describe("ErrorBoundary", () => {
  it("renders children normally when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>Everything is fine</p>
      </ErrorBoundary>
    );
    expect(screen.getByText("Everything is fine")).toBeInTheDocument();
  });

  it("catches a real thrown render error instead of unmounting to a blank screen", () => {
    // React logs the caught error to the console during this render --
    // silence it here so the test's own output stays readable; the
    // assertion below is what actually proves the boundary worked.
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Simulated render crash for a real test, not a fabricated one.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    consoleSpy.mockRestore();
  });
});
