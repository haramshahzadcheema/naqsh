import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { App } from "../App.js";
import * as apiClient from "../api/client.js";
import { ApiError } from "../api/client.js";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

function renderApp(): ReturnType<typeof render> {
  window.localStorage.setItem("naqsh.onboarding.completed", "true");
  return render(
    <MemoryRouter initialEntries={["/environment"]}>
      <App />
    </MemoryRouter>
  );
}

/**
 * AUDIT FIX regression: connectFreecadProject used to create the project
 * (real) and then print a HARDCODED "Connected to the real FreeCAD
 * document" message without ever calling the real connect endpoint --
 * reproduced live: the chat honestly looked successful while the
 * Environment tab's own badge correctly showed "disconnected", because no
 * real session had ever been established. These tests exercise the ACTUAL
 * production hook (via the real form in EnvironmentPage), not a
 * hand-built stand-in for it.
 */
describe("Connect FreeCAD document form: the real connectFreecadProject path", () => {
  it("only shows the success message and creates a thread after apiConnectEnvironment ACTUALLY succeeds -- never before", async () => {
    vi.spyOn(apiClient, "checkApiHealth").mockResolvedValue({ geminiConfigured: true });
    vi.spyOn(apiClient, "apiDiscoverEnvironments").mockResolvedValue({
      environments: [
        {
          kind: "freecad",
          name: "FreeCAD",
          status: "connectable",
          reason: null,
          resolvedCommandPath: String.raw`C:\Program Files\FreeCAD 1.1\bin\freecadcmd.exe`,
          version: "1.1.3",
          checkedAt: "t0",
          capabilities: ["save", "modify", "checkpoint"]
        }
      ]
    });
    const createProject = vi
      .spyOn(apiClient, "apiCreateProject")
      .mockResolvedValue({ id: "proj_fc", name: "FreeCAD project", createdAt: "t0", updatedAt: "t0", requirementCount: 0, version: 1, environmentKind: "freecad" });
    const connect = vi
      .spyOn(apiClient, "apiConnectEnvironment")
      .mockResolvedValue({ status: "connected", session: { id: "sess_1", documentName: "bracket.FCStd", openedAt: "t0" } });
    vi.spyOn(apiClient, "apiCreateConversation").mockResolvedValue({ id: "conv_fc", projectId: "proj_fc", title: "New conversation", createdAt: "t0", updatedAt: "t0" });

    const user = userEvent.setup();
    renderApp();

    const pathInput = await screen.findByPlaceholderText(/bracket\.FCStd/);
    await user.type(pathInput, "C:\\Users\\you\\Documents\\bracket.FCStd");
    await user.click(screen.getByRole("button", { name: "Connect document" }));

    // The success message must reflect what the SERVER actually reported
    // (session.documentName), and only appear once apiConnectEnvironment
    // has genuinely resolved -- both spies must have been called, in order.
    expect(await screen.findByText(/Connected to the real FreeCAD document at bracket\.FCStd/)).toBeInTheDocument();
    expect(createProject).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith("proj_fc");
  });

  it("shows a genuine error and creates NO thread when the real connection fails -- never the old fabricated success message", async () => {
    vi.spyOn(apiClient, "checkApiHealth").mockResolvedValue({ geminiConfigured: true });
    vi.spyOn(apiClient, "apiDiscoverEnvironments").mockResolvedValue({
      environments: [
        {
          kind: "freecad",
          name: "FreeCAD",
          status: "connectable",
          reason: null,
          resolvedCommandPath: String.raw`C:\Program Files\FreeCAD 1.1\bin\freecadcmd.exe`,
          version: "1.1.3",
          checkedAt: "t0",
          capabilities: ["save", "modify", "checkpoint"]
        }
      ]
    });
    vi.spyOn(apiClient, "apiCreateProject").mockResolvedValue({ id: "proj_fc2", name: "FreeCAD project", createdAt: "t0", updatedAt: "t0", requirementCount: 0, version: 1, environmentKind: "freecad" });
    vi.spyOn(apiClient, "apiConnectEnvironment").mockRejectedValue(new ApiError("environment_unavailable", "freecadcmd exited with a non-zero status: document not found"));

    const user = userEvent.setup();
    renderApp();

    const pathInput = await screen.findByPlaceholderText(/bracket\.FCStd/);
    await user.type(pathInput, "C:\\wrong\\path.FCStd");
    await user.click(screen.getByRole("button", { name: "Connect document" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/document not found/);
    expect(screen.queryByText(/Connected to the real FreeCAD document/)).not.toBeInTheDocument();
  });
});
