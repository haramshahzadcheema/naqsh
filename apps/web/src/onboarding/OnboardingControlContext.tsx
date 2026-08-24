import { createContext, useContext } from "react";

interface OnboardingControlValue {
  /** Clears the "onboarding completed" flag and restarts the full
   * cinematic opening from scratch — the brief's "provide a way to replay
   * the introduction" requirement, surfaced as a small control in the
   * header. */
  replayIntro: () => void;
}

export const OnboardingControlContext = createContext<OnboardingControlValue | null>(null);

export function useOnboardingControl(): OnboardingControlValue | null {
  return useContext(OnboardingControlContext);
}
