import { afterEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { App } from "../App.js";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function renderApp(): ReturnType<typeof render> {
  window.localStorage.setItem("naqsh.onboarding.completed", "true");
  return render(
    <MemoryRouter>
      <App />
    </MemoryRouter>
  );
}

describe("chat-first workflow", () => {
  it("walks a new project from the + button through extraction to the understanding card and confirmation", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("button", { name: /New chat/ }));
    expect(screen.getByText("Tell me what you're trying to build.")).toBeInTheDocument();

    const composer = screen.getByLabelText("Message Naqsh");
    await user.type(composer, "I need a bracket that supports 50 kg and fits inside a 100 x 80 x 20 mm envelope.");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Load capacity")).toBeInTheDocument();
    expect(screen.getByText(/What material are you considering\?/)).toBeInTheDocument();

    await user.type(composer, "Aluminum 6061-T6");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.type(composer, "No more than 12 mm");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.type(composer, "Needs to be CNC machined.");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Here's what I understand")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Looks right" }));
    expect(await screen.findByText(/What would you like to explore first/)).toBeInTheDocument();

    // The new thread now appears in the sidebar, titled from the opening statement.
    expect(screen.getByRole("button", { name: /^I need a bracket that supports 50 kg/ })).toBeInTheDocument();
  });

  it("selecting the existing project thread seeds a structured project summary in chat", async () => {
    renderApp();
    // The demo project thread is selected by default and has no messages yet.
    await waitFor(() => expect(screen.getByText(/I've inspected the current project\./)).toBeInTheDocument());
    expect(screen.getByText(/OBJECTIVE/)).toBeInTheDocument();
    expect(screen.getByText(/CURRENT DESIGN/)).toBeInTheDocument();
  });

  it("settings panel lets you change the environment and reasoning model, and it persists", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /Gemini 3.5 Flash-Lite/ }));
    await user.click(screen.getByRole("button", { name: "Engineering" }));
    await user.click(screen.getByRole("radio", { name: /Mock Simulation/ }));

    await user.click(screen.getByRole("button", { name: "Close settings" }));

    expect(JSON.parse(window.localStorage.getItem("naqsh.settings") ?? "{}")).toMatchObject({
      environment: "mock_simulation",
      modelId: "gemini-3.5-flash-lite"
    });
  });

  it("FreeCAD is shown honestly as unavailable -- a real adapter exists, but nothing selectable pretends to connect to it", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Engineering" }));
    expect(screen.getByText("FreeCAD")).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /FreeCAD/ })).not.toBeInTheDocument();
  });
});
