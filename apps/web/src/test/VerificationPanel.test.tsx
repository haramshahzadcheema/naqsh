import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { createCheck, createObjectiveSatisfactionResult, createVerificationResult } from "@naqsh/schemas";
import { VerificationPanel } from "../components/verification/VerificationPanel.js";

describe("VerificationPanel", () => {
  it("renders a passing check with required vs actual values, and a satisfied objective", () => {
    const check = createCheck({ kind: "bounds_check", description: "Edge clearance", objectId: "envobj_1", property: "edgeClearanceMm", min: 5, max: null, unit: "mm" });
    const result = createVerificationResult({
      checkId: check.id,
      checkKind: "bounds_check",
      status: "pass",
      reasonKind: "satisfied",
      message: "Edge clearance 5.3 mm satisfies the 5 mm minimum.",
      expected: { min: 5, max: null, unit: "mm" },
      actual: 5.3,
      projectId: "proj_1",
      projectVersion: 1
    });
    const objectiveSatisfaction = createObjectiveSatisfactionResult({
      projectId: "proj_1",
      projectVersion: 1,
      objectiveSummary: "Clearance target",
      status: "satisfied",
      reason: "All checks passed.",
      conditions: [{ checkId: check.id, effectiveStatus: "pass", reasonKind: "satisfied", message: "ok" }]
    });

    render(<VerificationPanel checks={[check]} results={[result]} objectiveSatisfaction={objectiveSatisfaction} />);

    expect(screen.getByText("1 / 1 checks passed")).toBeInTheDocument();
    expect(screen.getByText(/Required: ≥ 5 mm/)).toBeInTheDocument();
    expect(screen.getByText(/Actual: 5.3/)).toBeInTheDocument();
    expect(screen.getByText("Objective satisfied.")).toBeInTheDocument();
  });

  it("distinguishes a failing check and a not-satisfied objective — never renders 'AI says it looks good'", () => {
    const check = createCheck({ kind: "bounds_check", description: "Edge clearance", objectId: "envobj_1", property: "edgeClearanceMm", min: 5, max: null, unit: "mm" });
    const result = createVerificationResult({
      checkId: check.id,
      checkKind: "bounds_check",
      status: "fail",
      reasonKind: "violated",
      message: "Edge clearance 4.2 mm is below the 5 mm minimum.",
      expected: { min: 5, max: null, unit: "mm" },
      actual: 4.2,
      projectId: "proj_1",
      projectVersion: 1
    });
    const objectiveSatisfaction = createObjectiveSatisfactionResult({
      projectId: "proj_1",
      projectVersion: 1,
      objectiveSummary: "Clearance target",
      status: "not_satisfied",
      reason: "Edge clearance check failed.",
      conditions: [{ checkId: check.id, effectiveStatus: "fail", reasonKind: "violated", message: "below minimum" }]
    });

    render(<VerificationPanel checks={[check]} results={[result]} objectiveSatisfaction={objectiveSatisfaction} />);

    expect(screen.getByText("0 / 1 checks passed")).toBeInTheDocument();
    expect(screen.getByText("Objective not satisfied.")).toBeInTheDocument();
    expect(screen.queryByText(/looks good/i)).not.toBeInTheDocument();
  });
});
