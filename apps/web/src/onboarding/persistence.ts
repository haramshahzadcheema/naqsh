const STORAGE_KEY = "naqsh.onboarding.completed";

/**
 * Every localStorage access the opening lifecycle depends on, guarded
 * against the two real failure modes that used to crash the app outright:
 * a corrupted/unexpected stored value, and a blocked/unavailable store
 * (private browsing in some browsers, a full quota, a security policy
 * disabling storage entirely). `readOnboardingCompleted` was previously
 * called UNGUARDED inside `useReducer`'s lazy initializer -- a throw there
 * happens during the very first render, before React has anything to
 * recover with. Every function here fails toward the SAFE default (show
 * the opening; don't crash) rather than propagating.
 */
export function readOnboardingCompleted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeOnboardingCompleted(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, "true");
  } catch {
    // Storage is blocked/full -- the session still completes normally;
    // it will simply replay the opening again next visit, which is a far
    // better failure mode than crashing now.
  }
}

export function clearOnboardingCompleted(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to recover -- a blocked store means there was never
    // anything persisted to clear.
  }
}
