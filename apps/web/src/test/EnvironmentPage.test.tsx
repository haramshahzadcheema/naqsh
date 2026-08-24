import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import * as apiClient from "../api/client.js";
import { EnvironmentPage } from "../routes/EnvironmentPage.js";
import { ProjectDataProvider } from "../data/ProjectDataProvider.js";
import { ApiConnectionProvider } from "../api/ApiConnectionProvider.js";
import { SettingsProvider } from "../settings/SettingsProvider.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderPage(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <ApiConnectionProvider>
        <SettingsProvider>
          <ProjectDataProvider>
            <EnvironmentPage connectFreecadProject={vi.fn()} onConnected={vi.fn()} />
          </ProjectDataProvider>
        </SettingsProvider>
      </ApiConnectionProvider>
    </MemoryRouter>
  );
}

// No active real project id was set (`setActiveProjectId` is only ever
// called by MainShell, which isn't rendered here), so `ProjectDataProvider`
// serves the seeded offline demo -- exactly like every unauthenticated
// render of this app. `demoDataSource.getEnvironmentStatus` returns real,
// honest values (the mock_cad adapter's actual capability list, the demo
// project's own name as its document name), so this still exercises the
// real rendering logic end-to-end, just through the demo seam rather than
// a mocked HTTP call.
describe("EnvironmentPage: Engineering context", () => {
  it("shows the real document name and real capabilities of the connected demo environment -- never a fabricated 'current selection'/'current operation'", async () => {
    vi.spyOn(apiClient, "apiDiscoverEnvironments").mockResolvedValue({ environments: [] });

    renderPage();

    expect(await screen.findByText("Motor Mounting Bracket", { selector: "dd" })).toBeInTheDocument();
    expect(screen.getByText("Observe · Create · Modify · Delete · Save · Save checkpoints")).toBeInTheDocument();
    expect(screen.queryByText(/current selection/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/current operation/i)).not.toBeInTheDocument();
  });
});

describe("HttpDataSource.getEnvironmentStatus: the real backend wiring", () => {
  it("passes the real documentName and capabilities through, never discarding them", async () => {
    const { createHttpDataSource } = await import("../data/HttpDataSource.js");
    vi.spyOn(apiClient, "apiGetEnvironment").mockResolvedValue({
      kind: "freecad",
      name: "FreeCAD",
      status: "connected",
      capabilities: ["modify", "save", "checkpoint"],
      documentName: "Motor Mount v12.FCStd"
    });

    const status = await createHttpDataSource().getEnvironmentStatus("proj_1");
    expect(status).toEqual({
      kind: "freecad",
      name: "FreeCAD",
      status: "connected",
      capabilities: ["modify", "save", "checkpoint"],
      documentName: "Motor Mount v12.FCStd"
    });
  });

  it("returns null documentName and empty capabilities, never fabricated ones, when no project is selected", async () => {
    const { createHttpDataSource } = await import("../data/HttpDataSource.js");
    const status = await createHttpDataSource().getEnvironmentStatus();
    expect(status.documentName).toBeNull();
    expect(status.capabilities).toEqual([]);
  });
});
