import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { AgentPanel } from "../components/agent/AgentPanel.js";
import { ProjectDataProvider } from "../data/ProjectDataProvider.js";
import { ApiConnectionProvider } from "../api/ApiConnectionProvider.js";
import { SettingsProvider } from "../settings/SettingsProvider.js";

function renderPanel(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <ApiConnectionProvider>
        <SettingsProvider>
          <ProjectDataProvider>
            <AgentPanel />
          </ProjectDataProvider>
        </SettingsProvider>
      </ApiConnectionProvider>
    </MemoryRouter>
  );
}

describe("AgentPanel", () => {
  it("is not collapsed by default", () => {
    renderPanel();
    const section = screen.getByRole("region", { name: "Agent collaborator" });
    expect(section.className).not.toContain("is-collapsed");
    expect(screen.getByRole("button", { name: "Hide" })).toBeInTheDocument();
  });

  it("collapses on click, hiding the body but keeping the header visible", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: "Hide" }));

    const section = screen.getByRole("region", { name: "Agent collaborator" });
    expect(section.className).toContain("is-collapsed");
    expect(screen.getByText("AI Collaborator")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show" })).toBeInTheDocument();
  });

  it("expands again on a second click", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: "Hide" }));
    await user.click(screen.getByRole("button", { name: "Show" }));

    const section = screen.getByRole("region", { name: "Agent collaborator" });
    expect(section.className).not.toContain("is-collapsed");
  });
});
