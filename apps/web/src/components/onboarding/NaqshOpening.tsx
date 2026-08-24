import { useEffect, useState } from "react";
import { useReducedMotion } from "../../hooks/useReducedMotion.js";

/** The wordmark, and the ONLY branding on the opening screen -- no logo,
 * no icon, no supporting mark. Rendered as one text node (no per-letter
 * animation): at this tracking/weight a unified settle reads as calm and
 * intentional, where a per-character stagger would read as decorative
 * flourish the brief explicitly asks to avoid. */
const WORD = "NAQSH";
const TAGLINE = "Engineering intelligence, working with you.";

const SETTLE_DURATION_MS = 760;
const TAGLINE_DELAY_MS = SETTLE_DURATION_MS + 220;
const AUTO_ADVANCE_MS = TAGLINE_DELAY_MS + 1500;
/** `prefers-reduced-motion` skips the ANIMATION, not the opening itself --
 * a near-instant flash reads as "the opening got skipped," especially
 * since many VMs/remote desktops/CI browsers default this media feature
 * to "reduce" whether or not a person actually asked for it. Long enough
 * to register as a deliberate moment, short enough to never feel like a
 * delay. */
const REDUCED_MOTION_HOLD_MS = 1400;

/**
 * NAQSH's cinematic-but-restrained opening: the wordmark settles into
 * place with a single, quiet fade/blur/scale, then a small English
 * tagline (and "Press Enter to begin" prompt) appear beneath it.
 * `onComplete` fires once (auto-advance after settling, or immediately on
 * click/keypress so it never becomes an obstacle on repeat visits). Fully
 * static (no animation) for `prefers-reduced-motion`.
 */
export function NaqshOpening({ onComplete }: { onComplete: () => void }): JSX.Element {
  const reducedMotion = useReducedMotion();
  const [showTagline, setShowTagline] = useState(reducedMotion);

  useEffect(() => {
    if (reducedMotion) {
      const advanceTimer = window.setTimeout(onComplete, REDUCED_MOTION_HOLD_MS);
      return () => window.clearTimeout(advanceTimer);
    }
    const taglineTimer = window.setTimeout(() => setShowTagline(true), TAGLINE_DELAY_MS);
    const advanceTimer = window.setTimeout(onComplete, AUTO_ADVANCE_MS);
    return () => {
      window.clearTimeout(taglineTimer);
      window.clearTimeout(advanceTimer);
    };
  }, [reducedMotion, onComplete]);

  const wordClassName = reducedMotion ? "naqsh-opening__word naqsh-opening__word--static" : "naqsh-opening__word naqsh-opening__word--settle";

  return (
    <div
      className="naqsh-opening"
      role="button"
      tabIndex={0}
      aria-label="NAQSH — press Enter to continue"
      data-testid="naqsh-opening-cta"
      onClick={onComplete}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onComplete();
        }
      }}
    >
      <span className={wordClassName} aria-hidden="true">
        {WORD}
      </span>
      <p className={showTagline ? "naqsh-opening__tagline naqsh-opening__tagline--visible" : "naqsh-opening__tagline"} aria-hidden="true">
        {TAGLINE}
      </p>
      <p className={showTagline ? "naqsh-opening__prompt naqsh-opening__prompt--visible" : "naqsh-opening__prompt"} aria-hidden="true">
        Press Enter to begin
      </p>
    </div>
  );
}
