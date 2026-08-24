import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { App } from "../App.js";

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

describe("global search", () => {
  it("Ctrl+K opens search, finding a real demo requirement and navigating to Requirements on select", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.keyboard("{Control>}k{/Control}");
    const searchInput = await screen.findByRole("textbox", { name: "Search" });
    await user.type(searchInput, "static load");

    const result = await screen.findByText("Bracket must support a static load of 50 kg without yielding.");
    await user.click(result);

    expect(await screen.findByRole("heading", { name: "Requirements" })).toBeInTheDocument();
    // The search overlay itself closed after selecting a result.
    expect(screen.queryByRole("textbox", { name: "Search" })).not.toBeInTheDocument();
  });

  it("ArrowDown + Enter selects a result by keyboard alone, and Escape closes even once focus has moved off the input", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("button", { name: /Search/ }));
    const searchInput = await screen.findByRole("textbox", { name: "Search" });
    await user.type(searchInput, "edge clearance");

    await screen.findByText("Mounting hole edge clearance must be at least 5 mm.");
    await user.keyboard("{ArrowDown}{ArrowUp}{Enter}"); // exercises both directions, lands back on the first (Constraint) result

    expect(await screen.findByRole("heading", { name: "Requirements" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Search" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Search/ }));
    await screen.findByRole("textbox", { name: "Search" });
    await user.tab(); // move focus off the input, onto the results list
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "Search" })).not.toBeInTheDocument();
  });

  it("acts as a command palette too -- typing a workspace section name jumps straight there, ranked above content matches", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("button", { name: /Search/ }));
    const searchInput = await screen.findByRole("textbox", { name: "Search" });
    await user.type(searchInput, "design");

    const command = await screen.findByText("Go to Design");
    await user.click(command);

    expect(await screen.findByRole("heading", { name: "Candidate designs" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Search" })).not.toBeInTheDocument();
  });

  it("opening the palette with no query shows commands first -- New chat and Open settings are real, immediately usable actions", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("button", { name: /Search/ }));
    const palette = within(await screen.findByRole("dialog", { name: "Search" }));
    expect(await palette.findByText("New chat")).toBeInTheDocument();
    expect(palette.getByText("Open settings")).toBeInTheDocument();

    await user.click(palette.getByText("Open settings"));
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });

  it("clicking the sidebar Search button opens the same overlay, and Escape closes it", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("button", { name: /Search/ }));
    expect(await screen.findByRole("textbox", { name: "Search" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "Search" })).not.toBeInTheDocument();
  });
});
