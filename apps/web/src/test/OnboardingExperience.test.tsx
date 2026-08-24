import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OnboardingExperience } from "../onboarding/OnboardingExperience.js";
import { useOnboardingControl } from "../onboarding/OnboardingControlContext.js";

function mockReducedMotion(reduced: boolean): void {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: reduced && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  })) as unknown as typeof window.matchMedia;
}

function ReplayButton(): JSX.Element {
  const control = useOnboardingControl();
  return (
    <button type="button" onClick={() => control?.replayIntro()}>
      Replay intro
    </button>
  );
}

function Harness(): JSX.Element {
  return (
    <OnboardingExperience>
      <div>
        <h1>WORKSPACE</h1>
        <ReplayButton />
      </div>
    </OnboardingExperience>
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  // Reset to a safe default rather than vi.restoreAllMocks() -- that
  // clears vi.fn()'s own mockImplementation (it wasn't created via
  // vi.spyOn), leaving window.matchMedia callable but returning
  // `undefined`, which crashes the next test's render.
  mockReducedMotion(false);
});

describe("OnboardingExperience", () => {
  it("a first-time visitor sees the opening, not the workspace", () => {
    render(<Harness />);
    expect(screen.queryByText("WORKSPACE")).not.toBeInTheDocument();
    expect(screen.getByTestId("naqsh-opening-cta")).toBeInTheDocument();
  });

  it("completing the opening reveals the workspace and persists completion", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId("naqsh-opening-cta"));
    expect(screen.getByText("WORKSPACE")).toBeInTheDocument();
    expect(window.localStorage.getItem("naqsh.onboarding.completed")).toBe("true");
  });

  it("a returning user (onboarding already completed) goes straight to the workspace", () => {
    window.localStorage.setItem("naqsh.onboarding.completed", "true");
    render(<Harness />);
    expect(screen.getByText("WORKSPACE")).toBeInTheDocument();
    expect(screen.queryByTestId("naqsh-opening-cta")).not.toBeInTheDocument();
  });

  it("a fresh visitor with prefers-reduced-motion still sees the opening surface, not an instant bypass to the workspace -- the root cause of the reported 'sometimes skipped' bug", () => {
    mockReducedMotion(true);
    render(<Harness />);
    expect(screen.queryByText("WORKSPACE")).not.toBeInTheDocument();
    expect(screen.getByTestId("naqsh-opening-cta")).toBeInTheDocument();
    expect(screen.getAllByText("NAQSH").length).toBeGreaterThan(0);
  });

  it("replaying the intro from the workspace clears completion and restarts the opening", async () => {
    window.localStorage.setItem("naqsh.onboarding.completed", "true");
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByText("WORKSPACE")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Replay intro" }));

    expect(screen.queryByText("WORKSPACE")).not.toBeInTheDocument();
    expect(screen.getByTestId("naqsh-opening-cta")).toBeInTheDocument();
    expect(window.localStorage.getItem("naqsh.onboarding.completed")).toBeNull();
  });

  it("the workspace is never mounted underneath the opening -- not merely visually hidden, genuinely absent from the DOM", () => {
    render(<Harness />);
    expect(screen.getByTestId("naqsh-opening-cta")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("WORKSPACE");
  });

  it("survives a corrupted localStorage read (throws instead of returning a string) -- falls back to showing the opening, never crashes", () => {
    const getItemSpy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("corrupted", "SecurityError");
    });
    expect(() => render(<Harness />)).not.toThrow();
    expect(screen.getByTestId("naqsh-opening-cta")).toBeInTheDocument();
    getItemSpy.mockRestore();
  });

  it("survives a blocked localStorage write (setItem throws, e.g. private-browsing quota) -- still completes onboarding and reaches the workspace", async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "QuotaExceededError");
    });
    const user = userEvent.setup();
    render(<Harness />);
    await expect(user.click(screen.getByTestId("naqsh-opening-cta"))).resolves.not.toThrow();
    expect(screen.getByText("WORKSPACE")).toBeInTheDocument();
    setItemSpy.mockRestore();
  });

  it("a deterministic fallback timeout advances past the opening even with no user interaction at all -- the opening can never be a dead end", () => {
    vi.useFakeTimers();
    try {
      render(<Harness />);
      expect(screen.queryByText("WORKSPACE")).not.toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(6001);
      });
      expect(screen.getByText("WORKSPACE")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a simulated page refresh (unmount + remount) after completing once goes straight back to the workspace, deterministically", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness />);
    await user.click(screen.getByTestId("naqsh-opening-cta"));
    expect(screen.getByText("WORKSPACE")).toBeInTheDocument();
    unmount();

    render(<Harness />);
    expect(screen.getByText("WORKSPACE")).toBeInTheDocument();
    expect(screen.queryByTestId("naqsh-opening-cta")).not.toBeInTheDocument();
  });
});
