import { useEffect, type RefObject } from "react";

const FOCUSABLE_SELECTOR = ['a[href]', 'button:not([disabled])', 'textarea:not([disabled])', 'input:not([disabled])', 'select:not([disabled])', '[tabindex]:not([tabindex="-1"])'].join(",");

function focusableElements(container: HTMLElement): HTMLElement[] {
  // Deliberately no `offsetParent`-based visibility filter: JSDOM (this
  // app's test environment) never computes real layout, so `offsetParent`
  // is always `null` there regardless of actual visibility -- that check
  // would silently filter every element down to at most one, breaking the
  // trap under test. Every real caller (SettingsPanel, GlobalSearch) keeps
  // its focusable controls genuinely visible for as long as they're in the
  // DOM, so the selector's own `:not([disabled])` clauses are sufficient.
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/**
 * A real keyboard focus trap for a modal dialog (`SettingsPanel`,
 * `GlobalSearch`) -- without this, Tab/Shift+Tab silently walks a keyboard
 * user out of the open dialog into background content they can't see
 * behind the overlay, and closing the dialog leaves focus wherever it last
 * happened to land instead of back on the control that opened it. Two
 * things, both real DOM behavior, not a visual approximation:
 *
 *   1. While `containerRef`'s element is mounted, Tab at the last focusable
 *      element wraps to the first, and Shift+Tab at the first wraps to the
 *      last -- focus can never leave the dialog via keyboard.
 *   2. On unmount, focus returns to whatever element had it just before the
 *      dialog opened (normally the button that triggered it) -- the same
 *      "focus returns to the trigger" discipline `MainShell.tsx`'s mobile
 *      sidebar toggle already establishes for the one place in this app
 *      that already did this correctly.
 */
export function useFocusTrap(containerRef: RefObject<HTMLElement>): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Tab" || !container) return;
      const focusable = focusableElements(container);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;

      if (event.shiftKey) {
        if (active === first || !container.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !container.contains(active)) {
          event.preventDefault();
          first.focus();
        }
      }
    }

    container.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused && typeof previouslyFocused.focus === "function" && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
