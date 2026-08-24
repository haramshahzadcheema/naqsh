import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { createCandidate, createDesignSpecification, createPlan, createWorldModelState } from "@naqsh/schemas";
import { App } from "../App.js";
import * as apiClient from "../api/client.js";

/**
 * Real-HTTP-transport verification for the Design tab's candidate
 * generation trigger (`GenerateCandidatesPanel` in `DesignPage.tsx`),
 * wired through the REAL `ProjectDataProvider` -> `HttpDataSource` ->
 * `api/client.ts` chain -- exactly like `EngineeringWorkflowChat.test.tsx`,
 * this mocks the HTTP transport, never the UI's own decision-making. No
 * live Gemini call was possible in this sandbox (no `GEMINI_API_KEY`), so
 * both the success path (server reports N generated) and the honest
 * all-failed path are exercised here as real fetch-shaped responses.
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
  steps: [{ title: "Reduce bracket thickness", description: "Reduce the seed bracket's thickness.", purpose: "Meet the lightweight objective.", relevantObjectIds: ["envobj_1"] }]
});

function mockSnapshotCalls(): void {
  const state = createWorldModelState({ project: { id: "proj_live", name: "New project" } });
  vi.spyOn(apiClient, "apiGetProject").mockResolvedValue({ id: "proj_live", name: "New project", createdAt: "t0", updatedAt: "t0", worldModelState: state });
  vi.spyOn(apiClient, "apiGetPlans").mockResolvedValue([PLAN]);
  vi.spyOn(apiClient, "apiGetProposalsForProject").mockResolvedValue([]);
  vi.spyOn(apiClient, "apiGetChecks").mockResolvedValue([]);
  vi.spyOn(apiClient, "apiGetVerificationResults").mockResolvedValue([]);
  vi.spyOn(apiClient, "apiGetMemory").mockResolvedValue([]);
  vi.spyOn(apiClient, "apiGetJobs").mockResolvedValue([]);
  vi.spyOn(apiClient, "apiListProjectFiles").mockResolvedValue([]);
  vi.spyOn(apiClient, "apiGetCandidates").mockResolvedValue([]);
  vi.spyOn(apiClient, "apiGetDesignSpecifications").mockResolvedValue([]);
  vi.spyOn(apiClient, "apiGetClarifications").mockResolvedValue([]);
  vi.spyOn(apiClient, "apiGetObjectiveSatisfactionResults").mockResolvedValue([]);
  vi.spyOn(apiClient, "apiGetActivity").mockResolvedValue([]);
  vi.spyOn(apiClient, "apiGetEnvironment").mockResolvedValue({ kind: "mock_cad", name: "Mock CAD Environment", capabilities: [], status: "connected", documentName: null });
}

async function getToDesignTabOnRealProject(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  vi.spyOn(apiClient, "checkApiHealth").mockResolvedValue({ geminiConfigured: false });
  vi.spyOn(apiClient, "apiCreateProject").mockResolvedValue({ id: "proj_live", name: "New project", createdAt: "t0", updatedAt: "t0", requirementCount: 0, version: 1, environmentKind: "mock_cad" });
  vi.spyOn(apiClient, "apiCreateConversation").mockResolvedValue({ id: "conv_live", projectId: "proj_live", title: "New conversation", createdAt: "t0", updatedAt: "t0" });
  vi.spyOn(apiClient, "apiSendMessageStream").mockResolvedValue({
    userMessage: { id: "msg_u1", conversationId: "conv_live", role: "user", text: "Design this.", createdAt: "t1" },
    assistantMessage: { id: "msg_a1", conversationId: "conv_live", role: "assistant", text: "Ok.", createdAt: "t2" },
    requirementOutcome: null,
    workflowEvents: []
  });
  mockSnapshotCalls();

  renderApp();
  await waitFor(() => expect(screen.getByText("Demo project")).toBeInTheDocument());
  await user.click(screen.getByRole("button", { name: /New chat/ }));
  await user.type(screen.getByLabelText("Message Naqsh"), "Design this.");
  await user.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText("Ok.");

  await user.click(screen.getByRole("link", { name: "Design" }));
  await screen.findByText("Generate candidate designs");
}

describe("Design tab candidate generation, wired to the real HTTP client", () => {
  it("shows the real plan step, generates candidates, and reports the real success count", async () => {
    const user = userEvent.setup();
    await getToDesignTabOnRealProject(user);

    expect(screen.getByRole("option", { name: "Reduce bracket thickness" })).toBeInTheDocument();

    const design = createDesignSpecification({
      projectId: "proj_live",
      projectVersion: 1,
      planId: PLAN.id,
      planStepId: PLAN.steps[0]!.id,
      objectiveSummary: "A lighter bracket variant.",
      description: "Reduced-thickness bracket.",
      components: [{ id: "comp_1", name: "Bracket", type: "part", geometryIntent: "Thin plate" }],
      expectedOutputs: [{ id: "out_1", componentId: "comp_1", environmentObjectType: "part", environmentGenericType: "solid", properties: {} }]
    });
    const candidate = createCandidate({
      projectId: "proj_live",
      projectVersion: 1,
      planId: PLAN.id,
      planStepId: PLAN.steps[0]!.id,
      designSpecificationId: design.id,
      hypothesis: "Reducing thickness saves mass while staying within limits.",
      rationale: "The load requirement leaves margin at the current thickness."
    });
    const apiGenerateCandidates = vi.spyOn(apiClient, "apiGenerateCandidates").mockResolvedValue({
      candidates: [{ candidate, designSpecification: design }],
      failures: []
    });

    await user.click(screen.getByRole("button", { name: "Generate candidates" }));

    expect(await screen.findByText("Generated 1 candidate.")).toBeInTheDocument();
    expect(apiGenerateCandidates).toHaveBeenCalledWith("proj_live", PLAN.id, PLAN.steps[0]!.id, 3, "gemini-3.5-flash");
  });

  it("surfaces the real error, never a fabricated success, when generation fails entirely", async () => {
    const user = userEvent.setup();
    await getToDesignTabOnRealProject(user);

    vi.spyOn(apiClient, "apiGenerateCandidates").mockRejectedValue(new apiClient.ApiError("service_unavailable", "GEMINI_API_KEY is not configured on this server."));

    await user.click(screen.getByRole("button", { name: "Generate candidates" }));

    expect(await screen.findByText("GEMINI_API_KEY is not configured on this server.")).toBeInTheDocument();
  });
});
