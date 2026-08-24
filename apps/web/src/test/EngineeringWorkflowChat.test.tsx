import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { createCheck, createObjectiveSatisfactionResult, createPlan, createProposal, createVerificationResult } from "@naqsh/schemas";
import { App } from "../App.js";
import * as apiClient from "../api/client.js";
import type { ExecutionReport } from "../chat/workflowEvents.js";

/**
 * Part 12/13/17 verification for the chat-embedded engineering workflow.
 * Exactly like `OnlineChat.test.tsx`, this mocks the HTTP TRANSPORT
 * (`api/client.ts`), never the UI's own decision-making -- every card
 * rendered here is driven by data shaped exactly like what the real
 * `apps/api` server actually returns (`engineeringWorkflow.test.ts`
 * exercises that server-side shape against a real, schema-validated fake
 * ModelProvider). A live end-to-end run through an actual Gemini call was
 * not possible in this sandbox (no `GEMINI_API_KEY` configured, and the
 * deterministic mock provider's zero-config default responder does not
 * produce schema-valid structured output for plan/proposal generation --
 * see `mock-model-provider.ts`'s own doc comment) -- this test is the
 * honest substitute: real component tree, real event handlers, real
 * fetch-shaped responses.
 */

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

function renderApp(): ReturnType<typeof render> {
  window.localStorage.setItem("naqsh.onboarding.completed", "true");
  return render(
    <MemoryRouter>
      <App />
    </MemoryRouter>
  );
}

const PLAN = createPlan({
  projectId: "proj_live",
  projectVersion: 1,
  observationId: "obs_1",
  objectiveSummary: "Reduce bracket mass while keeping the load requirement satisfied.",
  steps: [
    {
      title: "Reduce bracket thickness",
      description: "Reduce the seed bracket's thickness while keeping it within load limits.",
      purpose: "Meet the lightweight objective.",
      relevantObjectIds: ["envobj_1"]
    }
  ],
  risks: [{ description: "Reduced thickness may reduce strength margin.", impact: "Could fail the load requirement.", severity: "medium" }]
});

const PROPOSAL = createProposal({
  projectId: "proj_live",
  projectVersion: 1,
  planId: PLAN.id,
  planStepId: PLAN.steps[0]!.id,
  objectiveSummary: "Reduce bracket thickness to 4 mm.",
  toolName: "modify_environment_object",
  toolTarget: "environment",
  target: { entityType: "object", entityId: "envobj_1" },
  input: { objectId: "envobj_1", propertyKey: "thicknessMm", value: 4 },
  rationale: "Reducing thickness saves mass while remaining above the minimum load-bearing thickness.",
  expectedEffect: "thicknessMm becomes 4."
});

function buildExecutionReport(): ExecutionReport {
  const check = createCheck({ kind: "numeric_comparison", description: "thicknessMm equals the requested value after execution", objectId: "envobj_1", property: "thicknessMm", operator: "eq", expectedValue: 4 });
  const result = createVerificationResult({
    checkId: check.id,
    checkKind: check.kind,
    status: "pass",
    reasonKind: "satisfied",
    message: "thicknessMm is 4, matching the requested value.",
    expected: 4,
    actual: 4,
    projectId: "proj_live",
    projectVersion: 2
  });
  const objective = createObjectiveSatisfactionResult({
    projectId: "proj_live",
    projectVersion: 2,
    status: "satisfied",
    reason: "The only verification check for this proposal passed.",
    conditions: [{ checkId: check.id, required: true, verificationResultId: result.id, effectiveStatus: "pass", reasonKind: "satisfied", message: "thicknessMm equals the requested value after execution." }]
  });
  return {
    execution: { status: "success", message: "Execution completed.", checkpointId: "checkpoint_1", propertyChanges: [{ key: "thicknessMm", before: 6, after: 4 }] },
    verification: { status: "passed", results: [result], checks: [check] },
    objective: { status: "satisfied", result: objective },
    discrepancy: { detected: false, description: "No discrepancy detected." }
  };
}

describe("engineering workflow cards inside the real chat, wired to the real HTTP client", () => {
  it("renders a real Plan card and Proposal card for a design-intent message, then Approve drives real approve+execute calls to a passed verification/objective result", async () => {
    vi.spyOn(apiClient, "checkApiHealth").mockResolvedValue({ geminiConfigured: true });
    vi.spyOn(apiClient, "apiCreateProject").mockResolvedValue({ id: "proj_live", name: "New project", createdAt: "t0", updatedAt: "t0", requirementCount: 1, version: 1, environmentKind: "mock_cad" });
    vi.spyOn(apiClient, "apiCreateConversation").mockResolvedValue({ id: "conv_live", projectId: "proj_live", title: "New conversation", createdAt: "t0", updatedAt: "t0" });
    vi.spyOn(apiClient, "apiSendMessageStream").mockResolvedValue({
      userMessage: { id: "msg_u1", conversationId: "conv_live", role: "user", text: "Design this.", createdAt: "t1" },
      assistantMessage: { id: "msg_a1", conversationId: "conv_live", role: "assistant", text: "I have enough information. I've prepared a design proposal — take a look below.", createdAt: "t2" },
      requirementOutcome: null,
      workflowEvents: [
        { kind: "plan_created", plan: PLAN },
        { kind: "proposal_created", proposal: PROPOSAL, approvalId: "approval_1" }
      ]
    });

    const user = userEvent.setup();
    renderApp();
    await waitFor(() => expect(screen.getByText("Demo project")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /New chat/ }));
    await user.type(screen.getByLabelText("Message Naqsh"), "Design this.");
    await user.click(screen.getByRole("button", { name: "Send" }));

    // The Planning card: objective + step title, exactly what the server sent.
    expect(await screen.findByText("Reduce bracket mass while keeping the load requirement satisfied.")).toBeInTheDocument();
    expect(screen.getByText("Reduce bracket thickness")).toBeInTheDocument();

    // The Proposal card: rationale + expected effect, real Approve/Reject buttons.
    expect(screen.getByText("Reduce bracket thickness to 4 mm.")).toBeInTheDocument();
    expect(screen.getByText("Reducing thickness saves mass while remaining above the minimum load-bearing thickness.")).toBeInTheDocument();

    vi.spyOn(apiClient, "apiApproveProposal").mockResolvedValue({ proposal: { ...PROPOSAL, status: "approved" }, approval: { id: "approval_1" } as never });
    vi.spyOn(apiClient, "apiExecuteProposal").mockResolvedValue(buildExecutionReport());

    await user.click(screen.getByRole("button", { name: "Approve change" }));

    // Real execution state, then the real distinction between "Execution
    // completed" and "Objective satisfied" (never collapsed into one verdict).
    expect(await screen.findByText("Execution completed.")).toBeInTheDocument();
    expect(screen.getByText("Execution completed")).toBeInTheDocument();
    expect(screen.getByText("1 / 1 checks passed")).toBeInTheDocument();
    expect(screen.getByText("Objective satisfied.")).toBeInTheDocument();

    // The real P11 discrepancy signal (a SEPARATE check from verification --
    // did the target entity's observable state actually change).
    expect(screen.getByText("Consistency check passed")).toBeInTheDocument();
    expect(screen.getByText("No discrepancy detected.")).toBeInTheDocument();

    expect(apiClient.apiApproveProposal).toHaveBeenCalledWith(PROPOSAL.id);
    expect(apiClient.apiExecuteProposal).toHaveBeenCalledWith(PROPOSAL.id);
  });

  it("shows an honest failure banner when the backend reports workflow_failed, never a fabricated plan/proposal", async () => {
    vi.spyOn(apiClient, "checkApiHealth").mockResolvedValue({ geminiConfigured: true });
    vi.spyOn(apiClient, "apiCreateProject").mockResolvedValue({ id: "proj_live2", name: "New project", createdAt: "t0", updatedAt: "t0", requirementCount: 1, version: 1, environmentKind: "mock_cad" });
    vi.spyOn(apiClient, "apiCreateConversation").mockResolvedValue({ id: "conv_live2", projectId: "proj_live2", title: "New conversation", createdAt: "t0", updatedAt: "t0" });
    vi.spyOn(apiClient, "apiSendMessageStream").mockResolvedValue({
      userMessage: { id: "msg_u2", conversationId: "conv_live2", role: "user", text: "Design this.", createdAt: "t1" },
      assistantMessage: { id: "msg_a2", conversationId: "conv_live2", role: "assistant", text: "I couldn't generate a plan (the model's response was malformed).", createdAt: "t2" },
      requirementOutcome: null,
      workflowEvents: [{ kind: "workflow_failed", stage: "planning", message: "the model's response was malformed" }]
    });

    const user = userEvent.setup();
    renderApp();
    await waitFor(() => expect(screen.getByText("Demo project")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /New chat/ }));
    await user.type(screen.getByLabelText("Message Naqsh"), "Design this.");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("the model's response was malformed")).toBeInTheDocument();
    expect(screen.queryByText(/Approve change/)).not.toBeInTheDocument();
  });
});
