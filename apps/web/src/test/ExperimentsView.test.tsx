import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createBackgroundJob, createCandidate, createDesignSpecification, createExperiment, createJobEvent, createVerificationResult } from "@naqsh/schemas";
import { ExperimentsView } from "../components/experiments/ExperimentsView.js";

function buildCandidateAndExperiment(id: string, status: "complete" | "failed", verificationResultIds: string[] = []) {
  const design = createDesignSpecification({
    projectId: "proj_1",
    projectVersion: 1,
    planId: "plan_1",
    planStepId: "step_1",
    objectiveSummary: "x",
    description: "x",
    components: [{ id: "comp_1", name: "Comp", type: "part", geometryIntent: "x" }],
    expectedOutputs: [{ id: "out_1", componentId: "comp_1", environmentObjectType: "part", environmentGenericType: "solid", properties: {} }]
  });
  const candidate = createCandidate({
    id,
    projectId: "proj_1",
    projectVersion: 1,
    planId: "plan_1",
    planStepId: "step_1",
    designSpecificationId: design.id,
    hypothesis: `Hypothesis for ${id}`,
    rationale: "r"
  });
  const experiment = createExperiment({ objective: "x", hypothesis: candidate.hypothesis, candidateId: candidate.id, status, conclusion: "done", verificationResultIds });
  return { candidate, experiment };
}

describe("ExperimentsView", () => {
  it("shows an empty state when there are no candidates yet", () => {
    render(<ExperimentsView candidates={[]} experiments={[]} verificationResults={[]} recommendedCandidateId={null} backgroundJobs={[]} jobEvents={[]} onCancelJob={vi.fn()} />);
    expect(screen.getByText("No experiments yet")).toBeInTheDocument();
  });

  it("marks exactly the recommended candidate as recommended, distinct from raw measurements", () => {
    const a = buildCandidateAndExperiment("cand_a", "complete");
    const b = buildCandidateAndExperiment("cand_b", "complete");
    render(
      <ExperimentsView
        candidates={[a.candidate, b.candidate]}
        experiments={[a.experiment, b.experiment]}
        verificationResults={[]}
        recommendedCandidateId="cand_b"
        backgroundJobs={[]}
        jobEvents={[]}
        onCancelJob={vi.fn()}
      />
    );
    expect(screen.getAllByText("Recommended")).toHaveLength(1);
  });

  it("shows REAL per-candidate check counts derived from VerificationResults, never a hardcoded/fabricated metrics table", () => {
    const passResult = createVerificationResult({ checkId: "check_1", checkKind: "numeric_comparison", status: "pass", reasonKind: "satisfied", message: "ok", projectId: "proj_1", projectVersion: 1 });
    const failResult = createVerificationResult({ checkId: "check_2", checkKind: "property_required", status: "fail", reasonKind: "violated", message: "no", projectId: "proj_1", projectVersion: 1 });
    const a = buildCandidateAndExperiment("cand_a", "complete", [passResult.id, failResult.id]);
    const b = buildCandidateAndExperiment("cand_b", "complete"); // no verification yet -- must show nothing, not a fake "0/0"

    render(
      <ExperimentsView
        candidates={[a.candidate, b.candidate]}
        experiments={[a.experiment, b.experiment]}
        verificationResults={[passResult, failResult]}
        recommendedCandidateId={null}
        backgroundJobs={[]}
        jobEvents={[]}
        onCancelJob={vi.fn()}
      />
    );

    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    expect(screen.queryByText("Checks passed")).toBeInTheDocument();
  });

  it("shows running job progress and calls onCancelJob when cancelled", async () => {
    const user = userEvent.setup();
    const job = createBackgroundJob({
      projectId: "proj_1",
      projectVersion: 1,
      status: "running",
      objective: "Sweep candidates",
      candidateIds: ["cand_a"],
      autonomyLevel: "approved_modify",
      allowedTools: ["modify_environment_object"],
      budget: { maxIterations: 20, maxDurationMs: 60000, maxToolCalls: 100, maxModelCalls: 10, maxCandidates: 20 },
      consumption: { iterationsUsed: 7, durationMsUsed: 1000, toolCallsUsed: 10, modelCallsUsed: 2, candidatesEvaluated: 7 }
    });
    const event = createJobEvent({ jobId: job.id, projectId: "proj_1", kind: "candidate_started", message: "Starting candidate 8." });
    const onCancel = vi.fn().mockResolvedValue(undefined);

    render(<ExperimentsView candidates={[]} experiments={[]} verificationResults={[]} recommendedCandidateId={null} backgroundJobs={[job]} jobEvents={[event]} onCancelJob={onCancel} />);

    expect(screen.getByText("7 / 20 candidates")).toBeInTheDocument();
    expect(screen.getByText("Starting candidate 8.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledWith(job.id);
  });
});
