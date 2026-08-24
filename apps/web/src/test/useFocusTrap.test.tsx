import { describe, expect, it } from "vitest";
import { useRef } from "react";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach } from "vitest";
import { useFocusTrap } from "../hooks/useFocusTrap.js";

afterEach(() => {
  cleanup();
});

function TestDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);
  return (
    <div ref={dialogRef} role="dialog" aria-modal="true">
      <button type="button">First</button>
      <button type="button">Middle</button>
      <button type="button">Last</button>
      <button type="button" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

function Harness({ open }: { open: boolean }): JSX.Element {
  return (
    <div>
      <button type="button">Trigger</button>
      {open ? <TestDialog onClose={() => {}} /> : null}
    </div>
  );
}

describe("useFocusTrap", () => {
  it("Tab from the last focusable element wraps to the first -- focus never escapes the dialog", async () => {
    const user = userEvent.setup();
    render(<Harness open={true} />);
    const first = screen.getByRole("button", { name: "First" });
    const close = screen.getByRole("button", { name: "Close" });

    close.focus();
    expect(document.activeElement).toBe(close);
    await user.tab();
    expect(document.activeElement).toBe(first);
  });

  it("Shift+Tab from the first focusable element wraps to the last", async () => {
    const user = userEvent.setup();
    render(<Harness open={true} />);
    const first = screen.getByRole("button", { name: "First" });
    const close = screen.getByRole("button", { name: "Close" });

    first.focus();
    expect(document.activeElement).toBe(first);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(close);
  });

  it("Tab from a MIDDLE element moves forward normally -- the trap only intervenes at the boundary", async () => {
    const user = userEvent.setup();
    render(<Harness open={true} />);
    const middle = screen.getByRole("button", { name: "Middle" });
    const last = screen.getByRole("button", { name: "Last" });

    middle.focus();
    await user.tab();
    expect(document.activeElement).toBe(last);
  });

  it("restores focus to the trigger element once the dialog unmounts", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness open={false} />);
    const trigger = screen.getByRole("button", { name: "Trigger" });
    await user.click(trigger);
    expect(document.activeElement).toBe(trigger);

    rerender(<Harness open={true} />);
    // Dialog mounted -- focus a control inside it, simulating real use.
    screen.getByRole("button", { name: "Middle" }).focus();
    expect(document.activeElement).not.toBe(trigger);

    rerender(<Harness open={false} />);
    expect(document.activeElement).toBe(trigger);
  });
});
