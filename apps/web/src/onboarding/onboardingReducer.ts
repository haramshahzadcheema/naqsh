import { initialOnboardingState, type OnboardingAction, type OnboardingState } from "./types.js";

export function onboardingReducer(state: OnboardingState, action: OnboardingAction): OnboardingState {
  switch (action.type) {
    case "CONFIRM":
      return state.stage === "opening" ? { stage: "entering" } : state;
    case "ENTERED":
      return { stage: "workspace" };
    case "RESTART":
      return { ...initialOnboardingState };
    default:
      return state;
  }
}
