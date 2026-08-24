import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NaqshOpening } from "../components/onboarding/NaqshOpening.js";

function mockMatchMedia(reducedMotion: boolean): void {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: reducedMotion && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("NaqshOpening", () => {
  it("renders the NAQSH wordmark in English -- the only branding on the opening screen", () => {
    mockMatchMedia(false);
    render(<NaqshOpening onComplete={vi.fn()} />);
    const word = screen.getByText("NAQSH", { selector: ".naqsh-opening__word" });
    expect(word).not.toHaveAttribute("lang", "ur");
    expect(word).not.toHaveAttribute("dir", "rtl");
  });

  it("shows an English tagline beneath the wordmark", () => {
    mockMatchMedia(false);
    render(<NaqshOpening onComplete={vi.fn()} />);
    const tagline = screen.getByText("Engineering intelligence, working with you.");
    expect(tagline).not.toHaveAttribute("lang", "ur");
    expect(tagline).not.toHaveAttribute("dir", "rtl");
  });

  it("completes immediately on click, without waiting for the auto-advance timer", async () => {
    mockMatchMedia(false);
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<NaqshOpening onComplete={onComplete} />);
    await user.click(screen.getByTestId("naqsh-opening-cta"));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("completes on Enter key for keyboard users", async () => {
    mockMatchMedia(false);
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<NaqshOpening onComplete={onComplete} />);
    screen.getByTestId("naqsh-opening-cta").focus();
    await user.keyboard("{Enter}");
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("renders the word statically (no settle-in animation class) when prefers-reduced-motion is set", () => {
    mockMatchMedia(true);
    render(<NaqshOpening onComplete={vi.fn()} />);
    const word = screen.getByText("NAQSH", { selector: ".naqsh-opening__word" });
    expect(word.className).toContain("naqsh-opening__word--static");
    expect(word.className).not.toContain("naqsh-opening__word--settle");
  });

  it("shows a 'Press Enter to begin' prompt in English once the tagline appears", async () => {
    vi.useFakeTimers();
    mockMatchMedia(true); // reduced motion -> the prompt is visible immediately, no timer dependency
    render(<NaqshOpening onComplete={vi.fn()} />);
    const prompt = screen.getByText("Press Enter to begin");
    expect(prompt).not.toHaveAttribute("lang", "ur");
    vi.useRealTimers();
  });

  it("plays the settle animation by default (motion not reduced)", () => {
    mockMatchMedia(false);
    render(<NaqshOpening onComplete={vi.fn()} />);
    const word = screen.getByText("NAQSH", { selector: ".naqsh-opening__word" });
    expect(word.className).toContain("naqsh-opening__word--settle");
  });

  it("exposes a single English accessible name for the opening's interactive surface", () => {
    mockMatchMedia(false);
    render(<NaqshOpening onComplete={vi.fn()} />);
    const cta = screen.getByTestId("naqsh-opening-cta");
    expect(cta).toHaveAttribute("aria-label", "NAQSH — press Enter to continue");
  });
});
