import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { createRequirement } from "@naqsh/schemas";
import { App } from "../App.js";
import * as apiClient from "../api/client.js";
import type { ApiSendMessageResult } from "../api/client.js";

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

describe("chat, wired to a REAL (mocked-transport) API connection", () => {
  it("when the API is reachable, a new chat's message goes through apiCreateProject/apiCreateConversation/apiSendMessageStream -- never the local pattern-matcher fallback", async () => {
    vi.spyOn(apiClient, "checkApiHealth").mockResolvedValue({ geminiConfigured: true });
    vi.spyOn(apiClient, "apiCreateProject").mockResolvedValue({ id: "proj_live", name: "New project", createdAt: "t0", updatedAt: "t0", requirementCount: 0, version: 1, environmentKind: "mock_cad" });
    vi.spyOn(apiClient, "apiCreateConversation").mockResolvedValue({ id: "conv_live", projectId: "proj_live", title: "New conversation", createdAt: "t0", updatedAt: "t0" });
    const realRequirement = createRequirement({ description: "Must support 50 kg.", category: "structural", value: 50, unit: "kg", source: "human" });
    vi.spyOn(apiClient, "apiSendMessageStream").mockResolvedValue({
      userMessage: { id: "msg_u1", conversationId: "conv_live", role: "user", text: "It needs to hold 50 kg.", createdAt: "t1" },
      assistantMessage: { id: "msg_a1", conversationId: "conv_live", role: "assistant", text: "Got it — recorded that as a real requirement.", createdAt: "t2" },
      requirementOutcome: { kind: "requirement_added", requirement: realRequirement },
      workflowEvents: []
    });

    const user = userEvent.setup();
    renderApp();

    await waitFor(() => expect(screen.getByText("Demo project")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /New chat/ }));
    const composer = screen.getByLabelText("Message Naqsh");
    await user.type(composer, "It needs to hold 50 kg.");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Got it — recorded that as a real requirement.")).toBeInTheDocument();
    expect(screen.getByText("Requirement")).toBeInTheDocument();
    expect(screen.getByText("50 kg")).toBeInTheDocument();

    expect(apiClient.apiCreateProject).toHaveBeenCalledTimes(1);
    expect(apiClient.apiCreateConversation).toHaveBeenCalledWith("proj_live");
    expect(apiClient.apiSendMessageStream).toHaveBeenCalledWith(
      "conv_live",
      "It needs to hold 50 kg.",
      expect.any(String),
      expect.any(String),
      [],
      expect.any(Function),
      expect.anything()
    );

    // The header badge must now say "Connected", never still "Demo project"
    // -- this thread has a real backend project behind it, which is exactly
    // what the badge is meant to distinguish (see TabBar.tsx's own doc
    // comment on why apiStatus alone isn't enough).
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.queryByText("Demo project")).not.toBeInTheDocument();
  });

  it("the environment chosen in Settings actually reaches project creation -- never a picker that silently does nothing", async () => {
    vi.spyOn(apiClient, "checkApiHealth").mockResolvedValue({ geminiConfigured: true });
    const createProjectSpy = vi
      .spyOn(apiClient, "apiCreateProject")
      .mockResolvedValue({ id: "proj_sim", name: "New project", createdAt: "t0", updatedAt: "t0", requirementCount: 0, version: 1, environmentKind: "mock_simulation" });
    vi.spyOn(apiClient, "apiCreateConversation").mockResolvedValue({ id: "conv_sim", projectId: "proj_sim", title: "New conversation", createdAt: "t0", updatedAt: "t0" });
    vi.spyOn(apiClient, "apiSendMessageStream").mockResolvedValue({
      userMessage: { id: "msg_u1", conversationId: "conv_sim", role: "user", text: "Hello", createdAt: "t1" },
      assistantMessage: { id: "msg_a1", conversationId: "conv_sim", role: "assistant", text: "Acknowledged.", createdAt: "t2" },
      requirementOutcome: null,
      workflowEvents: []
    });

    const user = userEvent.setup();
    renderApp();
    await waitFor(() => expect(screen.getByText("Demo project")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Engineering" }));
    await user.click(screen.getByRole("radio", { name: /Mock Simulation/ }));
    await user.click(screen.getByRole("button", { name: "Close settings" }));

    await user.click(screen.getByRole("button", { name: /New chat/ }));
    await user.type(screen.getByLabelText("Message Naqsh"), "Hello");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await screen.findByText("Acknowledged.");
    expect(createProjectSpy).toHaveBeenCalledWith(expect.any(String), expect.any(String), "mock_simulation");
  });

  it("Phase C: clicking Regenerate on the last reply replaces it with a fresh one via the real regenerate endpoint", async () => {
    vi.spyOn(apiClient, "checkApiHealth").mockResolvedValue({ geminiConfigured: true });
    vi.spyOn(apiClient, "apiCreateProject").mockResolvedValue({ id: "proj_regen", name: "New project", createdAt: "t0", updatedAt: "t0", requirementCount: 0, version: 1, environmentKind: "mock_cad" });
    vi.spyOn(apiClient, "apiCreateConversation").mockResolvedValue({ id: "conv_regen", projectId: "proj_regen", title: "New conversation", createdAt: "t0", updatedAt: "t0" });
    vi.spyOn(apiClient, "apiSendMessageStream").mockResolvedValue({
      userMessage: { id: "msg_u1", conversationId: "conv_regen", role: "user", text: "Hi", createdAt: "t1" },
      assistantMessage: { id: "msg_a1", conversationId: "conv_regen", role: "assistant", text: "Original reply.", createdAt: "t2" },
      requirementOutcome: null,
      workflowEvents: []
    });
    const regenerateSpy = vi.spyOn(apiClient, "apiRegenerateMessage").mockResolvedValue({
      assistantMessage: { id: "msg_a2", conversationId: "conv_regen", role: "assistant", text: "Regenerated reply.", createdAt: "t3" }
    });

    const user = userEvent.setup();
    renderApp();
    await waitFor(() => expect(screen.getByText("Demo project")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /New chat/ }));
    await user.type(screen.getByLabelText("Message Naqsh"), "Hi");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Original reply.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Regenerate" }));

    expect(await screen.findByText("Regenerated reply.")).toBeInTheDocument();
    expect(screen.queryByText("Original reply.")).not.toBeInTheDocument();
    expect(regenerateSpy).toHaveBeenCalledWith("conv_regen", "msg_a1", expect.any(String), expect.any(String));
  });

  it("Part 10: renders a reply's text as it streams in, and Stop preserves whatever arrived as the final message", async () => {
    vi.spyOn(apiClient, "checkApiHealth").mockResolvedValue({ geminiConfigured: true });
    vi.spyOn(apiClient, "apiCreateProject").mockResolvedValue({ id: "proj_stream", name: "New project", createdAt: "t0", updatedAt: "t0", requirementCount: 0, version: 1, environmentKind: "mock_cad" });
    vi.spyOn(apiClient, "apiCreateConversation").mockResolvedValue({ id: "conv_stream", projectId: "proj_stream", title: "New conversation", createdAt: "t0", updatedAt: "t0" });

    vi.spyOn(apiClient, "apiSendMessageStream").mockImplementation(
      (_conversationId: string, _text: string, _modelId: string, _style: string, _fileIds: string[], onDelta: (delta: string) => void, signal?: AbortSignal) =>
        new Promise<ApiSendMessageResult>((_resolve, reject) => {
          // Streams two real chunks, then hangs -- exactly like a real
          // in-flight generation that hasn't finished yet -- until the
          // user's Stop click fires the abort signal.
          onDelta("Hello");
          onDelta(", world");
          signal?.addEventListener("abort", () => reject(new DOMException("stopped by the user", "AbortError")));
        })
    );

    const user = userEvent.setup();
    renderApp();
    await waitFor(() => expect(screen.getByText("Demo project")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /New chat/ }));
    await user.type(screen.getByLabelText("Message Naqsh"), "Hi");
    await user.click(screen.getByRole("button", { name: "Send" }));

    // The two chunks rendered live, as one growing bubble -- not a
    // completed string revealed on a timer (there is no timer here at all).
    expect(await screen.findByText("Hello, world")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Stop" }));

    // After stopping, the exact partial text becomes the final message,
    // and the composer returns to its normal Send state.
    expect(await screen.findByText("Hello, world")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Send" })).toBeInTheDocument();
  });

  it("when the API call fails mid-flight, the user sees an honest error message, never a silently-empty or fabricated reply", async () => {
    vi.spyOn(apiClient, "checkApiHealth").mockResolvedValue({ geminiConfigured: true });
    vi.spyOn(apiClient, "apiCreateProject").mockResolvedValue({ id: "proj_live2", name: "New project", createdAt: "t0", updatedAt: "t0", requirementCount: 0, version: 1, environmentKind: "mock_cad" });
    vi.spyOn(apiClient, "apiCreateConversation").mockResolvedValue({ id: "conv_live2", projectId: "proj_live2", title: "New conversation", createdAt: "t0", updatedAt: "t0" });
    vi.spyOn(apiClient, "apiSendMessageStream").mockRejectedValue(new Error("Gemini isn't configured on this server"));

    const user = userEvent.setup();
    renderApp();
    await waitFor(() => expect(screen.getByText("Demo project")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /New chat/ }));
    const composer = screen.getByLabelText("Message Naqsh");
    await user.type(composer, "Hello");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText(/Something went wrong talking to the server/)).toBeInTheDocument();

    // Phase C: a failed send never shows Regenerate (nothing real was
    // saved server-side to regenerate) -- it shows Retry instead, which
    // resends the same original text as a fresh turn.
    expect(screen.queryByRole("button", { name: "Regenerate" })).not.toBeInTheDocument();
    vi.spyOn(apiClient, "apiSendMessageStream").mockResolvedValue({
      userMessage: { id: "msg_u2", conversationId: "conv_live2", role: "user", text: "Hello", createdAt: "t3" },
      assistantMessage: { id: "msg_a2", conversationId: "conv_live2", role: "assistant", text: "Second attempt worked.", createdAt: "t4" },
      requirementOutcome: null,
      workflowEvents: []
    });
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Second attempt worked.")).toBeInTheDocument();
    expect(apiClient.apiSendMessageStream).toHaveBeenLastCalledWith("conv_live2", "Hello", expect.any(String), expect.any(String), [], expect.any(Function), expect.anything());
  });

  it("when the API is unreachable, the app falls back to the local offline demo path and says so", async () => {
    vi.spyOn(apiClient, "checkApiHealth").mockResolvedValue(null);
    const createProjectSpy = vi.spyOn(apiClient, "apiCreateProject");
    const user = userEvent.setup();
    renderApp();

    await waitFor(() => expect(screen.getByText("Offline demo")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /New chat/ }));
    expect(screen.getByText("Tell me what you're trying to build.")).toBeInTheDocument();
    expect(createProjectSpy).not.toHaveBeenCalled();
  });
});
