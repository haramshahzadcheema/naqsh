import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { onboardingReducer } from "./onboardingReducer.js";
import { initialOnboardingState } from "./types.js";
import { OnboardingControlContext } from "./OnboardingControlContext.js";
import { useReducedMotion } from "../hooks/useReducedMotion.js";
import { NaqshOpening } from "../components/onboarding/NaqshOpening.js";
import { clearOnboardingCompleted, readOnboardingCompleted, writeOnboardingCompleted } from "./persistence.js";

/** Purely the visual duration of the fade-over-already-mounted-workspace
 * veil -- `children` are mounted the instant the "entering" stage begins,
 * never held back by this. */
const ENTER_VEIL_MS = 320;
/** A deterministic fallback: if nothing else ever advances the opening
 * (a stalled animation, an unusual environment, a test harness that
 * doesn't simulate a click), this guarantees it is never a dead end.
 * Comfortably longer than NaqshOpening's own ~2.6s auto-advance, so a
 * normal visitor never actually experiences this timer firing. */
const FALLBACK_ENTER_MS = 6000;

/**
 * The opening's explicit state machine (see types.ts's own doc comment
 * for the full BOOT -> LOADING_IDENTITY -> opening -> entering ->
 * workspace conceptual ordering). `readOnboardingCompleted()` is called
 * synchronously here, in the `useReducer` lazy initializer -- guarded
 * against corrupted/blocked storage (persistence.ts), so a returning
 * visitor's very FIRST paint already shows the workspace (via "entering"),
 * and a first-time visitor's very first paint already shows the opening:
 * there is no intermediate frame for either to flash through.
 */
export function OnboardingExperience({ children }: { children: ReactNode }): JSX.Element {
  const returning = useRef(readOnboardingCompleted());
  const [state, dispatch] = useReducer(onboardingReducer, returning.current ? { stage: "entering" as const } : initialOnboardingState);
  const reducedMotion = useReducedMotion();
  const [veilVisible, setVeilVisible] = useState(() => state.stage === "entering");

  // "entering" -> "workspace": the veil (if any) fades for ENTER_VEIL_MS,
  // then the stage resolves to steady-state. The SAME transition serves
  // both a returning visitor's instant skip and a first-time visitor's
  // just-confirmed opening -- one real stage, not two ad-hoc code paths.
  useEffect(() => {
    if (state.stage !== "entering") return;
    setVeilVisible(true);
    const holdMs = reducedMotion ? 0 : ENTER_VEIL_MS;
    const veilTimer = window.setTimeout(() => setVeilVisible(false), holdMs);
    const resolveTimer = window.setTimeout(() => dispatch({ type: "ENTERED" }), holdMs);
    return () => {
      window.clearTimeout(veilTimer);
      window.clearTimeout(resolveTimer);
    };
  }, [state.stage, reducedMotion]);

  // Deterministic fallback: the opening can never be a dead end.
  useEffect(() => {
    if (state.stage !== "opening") return;
    const timer = window.setTimeout(() => confirm(), FALLBACK_ENTER_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.stage]);

  /** The human/timeout confirmation IS the completion moment -- persisted
   * synchronously, right here, rather than deferred to the veil finishing
   * (which is a cosmetic detail independent of whether onboarding is
   * "done"). Guarded (persistence.ts): a blocked/full store degrades to
   * "replays the opening next visit," never a crash. */
  const confirm = useCallback(() => {
    writeOnboardingCompleted();
    dispatch({ type: "CONFIRM" });
  }, []);

  const replayIntro = useCallback(() => {
    clearOnboardingCompleted();
    returning.current = false;
    dispatch({ type: "RESTART" });
  }, []);

  return (
    <OnboardingControlContext.Provider value={{ replayIntro }}>
      {state.stage === "opening" ? (
        <div className="onboarding-screen">
          <NaqshOpening onComplete={confirm} />
        </div>
      ) : (
        <>
          {children}
          {veilVisible ? <div className="returning-veil" aria-hidden="true" data-testid="returning-veil" /> : null}
        </>
      )}
    </OnboardingControlContext.Provider>
  );
}
