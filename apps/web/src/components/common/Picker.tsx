import { useEffect, useRef, useState } from "react";
import type { Tone } from "./StatusDot.js";

export interface PickerOption {
  id: string;
  label: string;
  /** Short qualifier shown next to the label, e.g. a provider name. */
  meta?: string;
  /** Secondary line of explanatory text under the label. */
  description?: string;
  /** A short status word (e.g. "Available", "Not configured") rendered as
   * a small tone-colored dot + label -- the same tone vocabulary
   * `StatusDot`/`Badge` already use elsewhere, so a picker's status
   * reads consistently with every other status indicator in the app. */
  statusLabel?: string;
  statusTone?: Tone;
  /** An option that exists to be seen and understood, not chosen --
   * `onChange` never fires for it, and it's excluded from keyboard
   * arrow-navigation. Matches this app's own principle that an
   * unavailable capability must never appear pickable. */
  disabled?: boolean;
}

/**
 * A single, reusable single-select popover picker -- replaces the raw
 * `<select>` elements previously used for model/style choice (never
 * capable of showing a provider, a status dot, or a description line) and
 * generalizes `ExportMenu`'s own click-outside/popover pattern into
 * something richer options (model, environment, style) can all share,
 * rather than every picker inventing its own dropdown behavior.
 *
 * Full keyboard support: ArrowDown/ArrowUp move a visual highlight across
 * only the ENABLED options, Enter/Space commits the highlighted one,
 * Escape closes and returns focus to the trigger, and clicking outside
 * closes without changing the selection. The trigger itself is a real
 * `aria-haspopup="listbox"` button; the panel is `role="listbox"` with
 * `aria-selected` on the current value, so a screen reader announces this
 * exactly like the native control it replaces, not as an unlabeled menu.
 */
export function Picker({
  label,
  value,
  options,
  onChange,
  triggerClassName
}: {
  /** Accessible name for the trigger + listbox -- never visible text by
   * itself (the trigger shows the current option's label instead), so
   * this is exposed only via `aria-label`. */
  label: string;
  value: string;
  options: PickerOption[];
  onChange: (id: string) => void;
  /** Extra class(es) merged onto the trigger button, so each call site can
   * fit its own layout (e.g. the tab bar vs. the composer toolbar) without
   * the picker itself needing to know which context it's in. */
  triggerClassName?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = options.find((option) => option.id === value) ?? null;
  const enabledOptions = options.filter((option) => !option.disabled);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(event: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setHighlightedId(selected && !selected.disabled ? selected.id : (enabledOptions[0]?.id ?? null));
    // Move real DOM focus into the listbox so arrow keys/Enter work
    // immediately, matching native <select> behavior.
    listRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function close(returnFocus: boolean): void {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  function commit(id: string): void {
    onChange(id);
    close(true);
  }

  function moveHighlight(delta: 1 | -1): void {
    if (enabledOptions.length === 0) return;
    const currentIndex = enabledOptions.findIndex((option) => option.id === highlightedId);
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + delta + enabledOptions.length) % enabledOptions.length;
    setHighlightedId(enabledOptions[nextIndex]!.id);
  }

  return (
    <div className="picker" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`picker__trigger${triggerClassName ? ` ${triggerClassName}` : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="picker__trigger-label">{selected?.label ?? label}</span>
        {selected?.statusTone ? <span className={`picker__trigger-dot picker__trigger-dot--${selected.statusTone}`} aria-hidden="true" /> : null}
        <span className="picker__trigger-caret" aria-hidden="true">
          ⌄
        </span>
      </button>
      {open ? (
        <div
          ref={listRef}
          className="picker__popover"
          role="listbox"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              moveHighlight(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              moveHighlight(-1);
            } else if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              if (highlightedId) commit(highlightedId);
            } else if (event.key === "Escape") {
              event.preventDefault();
              close(true);
            } else if (event.key === "Tab") {
              close(false);
            }
          }}
        >
          {options.map((option) => (
            <div
              key={option.id}
              role="option"
              aria-selected={option.id === value}
              aria-disabled={option.disabled || undefined}
              className={`picker__option${option.id === value ? " is-selected" : ""}${option.id === highlightedId ? " is-highlighted" : ""}${option.disabled ? " is-disabled" : ""}`}
              onMouseEnter={() => !option.disabled && setHighlightedId(option.id)}
              onClick={() => !option.disabled && commit(option.id)}
            >
              <div className="picker__option-main">
                <span className="picker__option-label">{option.label}</span>
                {option.meta ? <span className="picker__option-meta">{option.meta}</span> : null}
              </div>
              {option.description ? <p className="picker__option-description">{option.description}</p> : null}
              {option.statusLabel ? (
                <span className={`picker__option-status picker__option-status--${option.statusTone ?? "neutral"}`}>
                  <span className="picker__option-status-dot" aria-hidden="true" />
                  {option.statusLabel}
                </span>
              ) : null}
              {option.id === value ? (
                <span className="picker__option-check" aria-hidden="true">
                  ✓
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
