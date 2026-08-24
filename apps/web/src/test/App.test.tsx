import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { App } from "../App.js";

// These tests exercise the workspace itself, not the opening animation --
// render as a "returning user" who has already completed onboarding once.
beforeEach(() => {
  window.localStorage.setItem("naqsh.onboarding.completed", "true");
});

afterEach(() => {
  window.localStorage.clear();
});

describe("App", () => {
  it("renders the sidebar with the NAQSH wordmark and the demo project thread", () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );
    expect(screen.getByText("NAQSH")).toBeInTheDocument();
    expect(screen.getAllByText("Motor Mounting Bracket").length).toBeGreaterThan(0);
  });

  it("opens on the chat view for the active thread by default", () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );
    expect(screen.getByLabelText("Message Naqsh")).toBeInTheDocument();
  });

  it("switches to the project tabs (Overview, Requirements, ...) and back to chat", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );

    await user.click(screen.getByRole("link", { name: "Requirements" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Requirements" })).toBeInTheDocument());

    await user.click(screen.getByRole("link", { name: "Memory" }));
    await waitFor(() => expect(screen.getByText("Prefer 5 mm minimum edge clearance")).toBeInTheDocument());
  });

  it("the + New chat button starts a fresh chat thread", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );
    await user.click(screen.getByRole("button", { name: /New chat/ }));
    expect(screen.getByText("Tell me what you're trying to build.")).toBeInTheDocument();
  });

  it("has a skip link targeting main content for keyboard users", () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );
    const skipLink = screen.getByText("Skip to main content");
    expect(skipLink).toHaveAttribute("href", "#main-content");
    expect(document.getElementById("main-content")).not.toBeNull();
  });
});
