import { describe, expect, it } from "vitest";
import { resolveNextStep } from "../data/resolveNextStep.js";
import type { EnvironmentStatus, ProjectSnapshot } from "../data/NaqshDataSource.js";

/**
 * The next-step resolver is the one place in the UI that claims to know
 * what is blocking you. If its ORDER is wrong it doesn't just look odd --
 * it actively sends you to the wrong tab, which is the exact failure this
 * whole surface exists to fix. So every rule below asserts real
 * precedence, not merely that some string came back.
 */

function snapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    project: { id: "proj_1", name: "Test", environmentKind: "freecad", createdAt: "", updatedAt: "" },
    requirements: [],
    constraints: [],
    clarifications: [],
    objects: [],
    plan: null,
    sources: [],
    evidence: [],
    candidates: [],
    designSpecifications: [],
    checks: [],
    verificationResults: [],
    experiments: [],
    objectiveSatisfaction: null,
    proposals: [],
    decisions: [],
    memoryRecords: [],
    buildResults: [],
    backgroundJobs: [],
    jobEvents: [],
    files: [],
    ...overrides
  } as unknown as ProjectSnapshot;
}

const connected: EnvironmentStatus = { kind: "freecad", name: "FreeCAD", status: "connected", capabilities: ["create", "modify", "save", "checkpoint"], documentName: "naqsh" };
const disconnected: EnvironmentStatus = { ...connected, status: "disconnected" };

const requirement = { id: "req_1", status: "active" } as never;
const pendingClarification = { id: "clar_1", status: "pending" } as never;
const answeredClarification = { id: "clar_2", status: "answered" } as never;
const pendingProposal = { id: "prop_1", status: "proposed" } as never;
const executedProposal = { id: "prop_2", status: "executed" } as never;
const plan = { id: "plan_1", steps: [{ id: "s1" }] } as never;

describe("resolveNextStep", () => {
  it("names the offline demo when the demo has nothing else outstanding", () => {
    const step = resolveNextStep(snapshot({ requirements: [requirement], plan }), connected, false);
    expect(step.id).toBe("demo");
    expect(step.title).toMatch(/offline demo/i);
  });

  it("the demo notice never suppresses genuinely actionable demo state -- the seeded demo really does honour these actions", () => {
    // Caught in the real browser: the seeded demo carries a pending
    // proposal AND two failing checks, both actionable, yet an
    // earlier ordering announced only "you're viewing the offline demo"
    // and buried the guidance the page was actually showing.
    const withProposal = resolveNextStep(snapshot({ requirements: [requirement], plan, proposals: [pendingProposal] }), connected, false);
    expect(withProposal.id).toBe("decide_proposal");

    const withFailure = resolveNextStep(snapshot({ requirements: [requirement], plan, verificationResults: [{ id: "vr_1", status: "fail" } as never] }), connected, false);
    expect(withFailure.id).toBe("verification_failed");
  });

  it("a disconnected environment outranks EVERYTHING -- it blocks every mutation downstream", () => {
    const step = resolveNextStep(
      snapshot({ requirements: [requirement], clarifications: [pendingClarification], proposals: [pendingProposal], plan }),
      disconnected,
      true
    );
    expect(step.id).toBe("environment_disconnected");
    expect(step.tone).toBe("blocked");
    expect(step.action).toEqual({ kind: "connect_environment" });
  });

  it("a pending clarification outranks a pending proposal -- Naqsh is stuck, not waiting on you to approve", () => {
    const step = resolveNextStep(snapshot({ requirements: [requirement], clarifications: [pendingClarification], proposals: [pendingProposal], plan }), connected, true);
    expect(step.id).toBe("answer_clarification");
    expect(step.action).toEqual({ kind: "navigate", to: "/requirements" });
  });

  it("counts only genuinely pending clarifications, never answered or dismissed ones", () => {
    const step = resolveNextStep(snapshot({ requirements: [requirement], clarifications: [answeredClarification], plan }), connected, true);
    expect(step.id).not.toBe("answer_clarification");
  });

  it("asks for requirements first when there are none", () => {
    const step = resolveNextStep(snapshot(), connected, true);
    expect(step.id).toBe("capture_requirements");
  });

  it("sends you to Design for a proposal awaiting a decision, and counts them accurately", () => {
    const step = resolveNextStep(snapshot({ requirements: [requirement], proposals: [pendingProposal, { id: "prop_3", status: "proposed" } as never], plan }), connected, true);
    expect(step.id).toBe("decide_proposal");
    expect(step.title).toContain("2");
    expect(step.action).toEqual({ kind: "navigate", to: "/design" });
  });

  it("does not treat an already-executed proposal as still needing a decision -- the exact stale-card bug this replaces", () => {
    const step = resolveNextStep(snapshot({ requirements: [requirement], proposals: [executedProposal], plan }), connected, true);
    expect(step.id).not.toBe("decide_proposal");
  });

  it("asks for a plan once requirements exist but no plan does", () => {
    const step = resolveNextStep(snapshot({ requirements: [requirement] }), connected, true);
    expect(step.id).toBe("generate_plan");
    expect(step.action).toEqual({ kind: "chat", suggestedMessage: "generate" });
  });

  it("a real verification failure outranks generating more candidates", () => {
    const step = resolveNextStep(
      snapshot({
        requirements: [requirement],
        plan,
        verificationResults: [{ id: "vr_1", status: "fail" } as never],
        candidates: [{ id: "cand_1", status: "proposed" } as never]
      }),
      connected,
      true
    );
    expect(step.id).toBe("verification_failed");
    expect(step.tone).toBe("blocked");
  });

  it("a passing verification does not raise a failure step", () => {
    const step = resolveNextStep(snapshot({ requirements: [requirement], plan, verificationResults: [{ id: "vr_1", status: "pass" } as never] }), connected, true);
    expect(step.id).not.toBe("verification_failed");
  });

  it("AUDIT FIX: a genuinely failed build is surfaced with its REAL adapter error, not silence", () => {
    // Reproduced live before the fix: three consecutive builds failed
    // with a real adapter error and the workspace showed nothing at all.
    const failedBuild = {
      id: "build_1",
      status: "failed",
      operations: [{ id: "op_1", toolName: "create_environment_object", status: "failed", error: { kind: "execution_failure", message: '"freecad" does not support "create"' } }]
    } as never;
    const step = resolveNextStep(snapshot({ requirements: [requirement], plan, buildResults: [failedBuild] }), connected, true);
    expect(step.id).toBe("build_failed");
    expect(step.tone).toBe("blocked");
    expect(step.detail).toContain('does not support "create"');
    expect(step.action).toEqual({ kind: "navigate", to: "/experiments" });
  });

  it("a completed build is never reported as a failure", () => {
    const okBuild = { id: "build_2", status: "completed", operations: [{ id: "op_2", toolName: "create_environment_object", status: "succeeded", error: null }] } as never;
    const step = resolveNextStep(snapshot({ requirements: [requirement], plan, buildResults: [okBuild] }), connected, true);
    expect(step.id).not.toBe("build_failed");
  });

  it("a failed build outranks unbuilt candidates -- fix what broke before generating more", () => {
    const failedBuild = { id: "build_3", status: "failed", operations: [] } as never;
    const step = resolveNextStep(
      snapshot({ requirements: [requirement], plan, buildResults: [failedBuild], candidates: [{ id: "cand_1", status: "proposed" } as never] }),
      connected,
      true
    );
    expect(step.id).toBe("build_failed");
  });

  it("surfaces unbuilt candidates and points at Experiments, where they can actually be run", () => {
    const step = resolveNextStep(snapshot({ requirements: [requirement], plan, candidates: [{ id: "cand_1", status: "proposed" } as never] }), connected, true);
    expect(step.id).toBe("run_candidates");
    expect(step.action).toEqual({ kind: "navigate", to: "/experiments" });
  });

  it("does not ask you to re-run candidates that were already tested", () => {
    const step = resolveNextStep(snapshot({ requirements: [requirement], plan, candidates: [{ id: "cand_1", status: "tested" } as never] }), connected, true);
    expect(step.id).toBe("up_to_date");
  });

  it("says plainly when nothing is outstanding rather than manufacturing busywork", () => {
    const step = resolveNextStep(snapshot({ requirements: [requirement], plan, proposals: [executedProposal] }), connected, true);
    expect(step.id).toBe("up_to_date");
    expect(step.tone).toBe("done");
  });

  it("never returns an empty title, detail, or action label for any reachable state", () => {
    const states: ProjectSnapshot[] = [
      snapshot(),
      snapshot({ requirements: [requirement] }),
      snapshot({ requirements: [requirement], plan }),
      snapshot({ requirements: [requirement], plan, proposals: [pendingProposal] }),
      snapshot({ clarifications: [pendingClarification] })
    ];
    for (const state of states) {
      for (const env of [connected, disconnected, null]) {
        const step = resolveNextStep(state, env, true);
        expect(step.title.length).toBeGreaterThan(0);
        expect(step.detail.length).toBeGreaterThan(0);
        expect(step.actionLabel.length).toBeGreaterThan(0);
      }
    }
  });
});
