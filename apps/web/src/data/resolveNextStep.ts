import type { EnvironmentStatus, ProjectSnapshot } from "./NaqshDataSource.js";

/**
 * The ONE answer to "what do I do next?", derived from real project state.
 *
 * Naqsh's workspace spreads genuine, related state across eleven tabs: a
 * clarification lives under Requirements, the proposal it blocks lives
 * under Design, the candidates that proposal unlocks are listed under
 * Design but only RUNNABLE from the chat card that created them, and a
 * dropped FreeCAD session shows only as a badge in the top bar. Every
 * one of those is honestly rendered where it lives -- but nothing ever
 * told you which of them was the thing standing between you and progress,
 * so the app read as a pile of disconnected screens.
 *
 * This resolves that ordering ONCE, from the same snapshot every tab
 * already renders, and returns a single next action. It is deliberately a
 * pure function over real state:
 *   - it never invents a step that isn't backed by a real record,
 *   - it never claims progress the backend hasn't made,
 *   - and when there is genuinely nothing to do it says exactly that
 *     rather than manufacturing busywork.
 *
 * Order matters and is not arbitrary -- it follows what actually blocks
 * what. A disconnected environment blocks every mutation, so it outranks
 * everything. An unanswered clarification blocks requirement capture,
 * which blocks planning, which blocks proposals, which blocks candidates.
 */

export type NextStepAction =
  | { kind: "connect_environment" }
  | { kind: "navigate"; to: string }
  | { kind: "chat"; suggestedMessage: string };

export interface NextStep {
  /** Stable id for tests and for React keys -- never shown to the user. */
  id: string;
  /** Imperative, specific, and honest about what will happen. */
  title: string;
  /** Why this is the next thing, in plain language. */
  detail: string;
  /** What the button does. */
  action: NextStepAction;
  /** The button's label. */
  actionLabel: string;
  /** Drives the accent: "blocked" is something wrong, "todo" is ordinary
   * forward progress, "done" means genuinely nothing is outstanding. */
  tone: "blocked" | "todo" | "done";
}

export function resolveNextStep(snapshot: ProjectSnapshot, environment: EnvironmentStatus | null, isRealProject: boolean): NextStep {
  // --- 1. A dropped session blocks every single mutation downstream. ---
  // Restarting the API server drops the in-memory environment session,
  // which is invisible apart from one badge -- and every build afterward
  // fails for a reason the UI never explains.
  if (environment && environment.status !== "connected") {
    return {
      id: "environment_disconnected",
      title: `Reconnect to ${environment.name}`,
      detail: "The environment session isn't connected, so Naqsh can't create or modify any geometry. This happens whenever the API server restarts.",
      action: { kind: "connect_environment" },
      actionLabel: "Reconnect",
      tone: "blocked"
    };
  }

  // --- 2. A pending clarification is Naqsh honestly saying it is stuck. ---
  const pendingClarifications = snapshot.clarifications.filter((clarification) => clarification.status === "pending");
  if (pendingClarifications.length > 0) {
    return {
      id: "answer_clarification",
      title: pendingClarifications.length === 1 ? "Answer 1 open question" : `Answer ${pendingClarifications.length} open questions`,
      detail: "Naqsh couldn't extract a firm criterion from something you said and is asking rather than guessing. Answering unblocks the plan.",
      action: { kind: "navigate", to: "/requirements" },
      actionLabel: "Review questions",
      tone: "blocked"
    };
  }

  // --- 3. Nothing to design from yet. ---
  if (snapshot.requirements.length === 0) {
    return {
      id: "capture_requirements",
      title: "Tell Naqsh what you're building",
      detail: "No requirements captured yet. Describe one concrete fact per message -- for example \"the bracket must be no more than 100mm long\".",
      action: { kind: "chat", suggestedMessage: "" },
      actionLabel: "Go to chat",
      tone: "todo"
    };
  }

  // --- 4. A proposal is waiting on a human decision. ---
  const pendingProposals = snapshot.proposals.filter((proposal) => proposal.status === "proposed");
  if (pendingProposals.length > 0) {
    return {
      id: "decide_proposal",
      title: pendingProposals.length === 1 ? "Approve or reject 1 proposed change" : `Decide on ${pendingProposals.length} proposed changes`,
      detail: "Naqsh never touches the document without your approval. A checkpoint is captured first, so anything you approve can be restored.",
      action: { kind: "navigate", to: "/design" },
      actionLabel: "Review the change",
      tone: "todo"
    };
  }

  // --- 5. Requirements exist but nothing has been planned from them. ---
  if (!snapshot.plan || snapshot.plan.steps.length === 0) {
    return {
      id: "generate_plan",
      title: "Ask Naqsh to plan the build",
      detail: `${snapshot.requirements.length} requirement${snapshot.requirements.length === 1 ? "" : "s"} captured. Naqsh can turn them into a step-by-step plan.`,
      action: { kind: "chat", suggestedMessage: "generate" },
      actionLabel: "Generate a plan",
      tone: "todo"
    };
  }

  // --- 5b. A plan with work left should say so, and say what's next. ---
  // Until this existed the loop was invisible: after approving a step you
  // had to know to retype "generate" to get the next one. Nothing on
  // screen said a plan was mid-flight, which step was next, or how many
  // remained.
  const pendingSteps = snapshot.plan.steps.filter((step) => step.status === "pending");
  if (pendingSteps.length > 0 && pendingSteps.length < snapshot.plan.steps.length) {
    const nextStep = pendingSteps[0]!;
    return {
      id: "continue_plan",
      title: `Next: ${nextStep.title}`,
      detail: `${pendingSteps.length} of ${snapshot.plan.steps.length} steps remain. Naqsh prepares one change at a time so each is approved on its own.`,
      action: { kind: "chat", suggestedMessage: "continue" },
      actionLabel: "Continue the plan",
      tone: "todo"
    };
  }

  // --- 6. A real verification failure outranks generating more options. ---
  const failedChecks = snapshot.verificationResults.filter((result) => result.status === "fail");
  if (failedChecks.length > 0) {
    return {
      id: "verification_failed",
      title: failedChecks.length === 1 ? "1 check failed against the real geometry" : `${failedChecks.length} checks failed against the real geometry`,
      detail: "Naqsh measured the actual solid, not the proposal, and it doesn't meet a requirement you set.",
      action: { kind: "navigate", to: "/design" },
      actionLabel: "See what failed",
      tone: "blocked"
    };
  }

  // --- 6b. A build that actually FAILED outranks anything optional. ---
  // This is the case that produced no UI whatsoever before the audit:
  // real builds failing with a real adapter error, three times in a row,
  // while the workspace showed nothing and the exploration simply looked
  // like it had done nothing at all.
  // `?? []` on purpose: resolveNextStep runs on EVERY render of the
  // workspace and the chat, so a snapshot from a source that predates
  // this field must degrade to "no failures known", never throw and take
  // the whole page down with it.
  const failedBuilds = (snapshot.buildResults ?? []).filter((build) => build.status === "failed");
  if (failedBuilds.length > 0) {
    const firstError = failedBuilds
      .flatMap((build) => build.operations)
      .find((operation) => operation.error)?.error?.message;
    return {
      id: "build_failed",
      title: failedBuilds.length === 1 ? "1 build failed" : `${failedBuilds.length} builds failed`,
      detail: firstError
        ? `Naqsh could not apply a change to the document: ${firstError}`
        : "Naqsh could not apply a change to the connected document. Open Experiments for the full result.",
      action: { kind: "navigate", to: "/experiments" },
      actionLabel: "See the failure",
      tone: "blocked"
    };
  }

  // --- 7. Candidates generated but never actually built. ---
  const unbuiltCandidates = snapshot.candidates.filter((candidate) => candidate.status === "proposed");
  if (unbuiltCandidates.length > 0) {
    return {
      id: "run_candidates",
      title: `Build and compare ${unbuiltCandidates.length} candidate design${unbuiltCandidates.length === 1 ? "" : "s"}`,
      detail: "These exist as specifications only. Running them builds each one in the connected document and verifies it against your requirements.",
      action: { kind: "navigate", to: "/experiments" },
      actionLabel: "Run them",
      tone: "todo"
    };
  }

  // --- 8. Nothing real is outstanding. ---
  // The offline demo is checked HERE, not first, deliberately: the seeded
  // demo carries genuinely actionable state (a pending proposal, failing
  // checks) and its data source really does honour those actions. Leading
  // with "this is only a demo" would have suppressed correct, useful
  // guidance about the very things on screen -- so it is only said when
  // there is nothing more specific to say.
  if (!isRealProject) {
    return {
      id: "demo",
      title: "You're viewing the offline demo",
      detail: "This project is seeded sample data. Start a new chat to create a real project Naqsh can build in for real.",
      action: { kind: "navigate", to: "/" },
      actionLabel: "Go to chat",
      tone: "todo"
    };
  }

  return {
    id: "up_to_date",
    title: "Nothing is waiting on you",
    detail: "Every proposal has been decided and no checks are failing. Ask Naqsh for a change, or explore alternatives.",
    action: { kind: "chat", suggestedMessage: "explore alternatives" },
    actionLabel: "Explore alternatives",
    tone: "done"
  };
}
