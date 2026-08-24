import { describe, expect, it } from "vitest";
import { onboardingReducer } from "../onboarding/onboardingReducer.js";
import { initialOnboardingState } from "../onboarding/types.js";

describe("onboardingReducer", () => {
  it("starts on 'opening'", () => {
    expect(initialOnboardingState.stage).toBe("opening");
  });

  it("CONFIRM moves 'opening' to 'entering', not straight to 'workspace' -- the veil transition is a real stage, not skipped", () => {
    const state = onboardingReducer(initialOnboardingState, { type: "CONFIRM" });
    expect(state.stage).toBe("entering");
  });

  it("CONFIRM is a no-op once already past 'opening' -- a stray/duplicate confirm can't rewind or double-fire the transition", () => {
    const entering = onboardingReducer(initialOnboardingState, { type: "CONFIRM" });
    const again = onboardingReducer(entering, { type: "CONFIRM" });
    expect(again).toEqual(entering);
  });

  it("ENTERED moves 'entering' to 'workspace'", () => {
    const entering = onboardingReducer(initialOnboardingState, { type: "CONFIRM" });
    const state = onboardingReducer(entering, { type: "ENTERED" });
    expect(state.stage).toBe("workspace");
  });

  it("RESTART returns to 'opening' from any stage", () => {
    const state = onboardingReducer({ stage: "workspace" }, { type: "RESTART" });
    expect(state).toEqual(initialOnboardingState);
  });
});
