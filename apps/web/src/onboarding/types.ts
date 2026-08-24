import type { Constraint, Requirement } from "@naqsh/schemas";

/** Metadata for a file attached to a message. Only plain-text files
 * (.txt/.md/.json/.csv or any `text/*` MIME type) ever have their
 * content actually read -- binary/CAD files (e.g. `.FCStd`) are attached
 * as a labeled reference only, never pretended to be inspected, since
 * there is no live environment connection in the browser to open them
 * with. See `chat/fileImport.ts`. */
export interface MessageAttachment {
  id: string;
  name: string;
  size: number;
  type: string;
  kind: "text" | "binary";
}

export interface ConversationMessage {
  id: string;
  role: "naqsh" | "user";
  text: string;
  attachments?: MessageAttachment[];
  /** Phase C: true only for a locally-fabricated placeholder ("Stopped
   * before any reply arrived" / "Something went wrong talking to the
   * server: ...") -- never a real backend message id, since the failure
   * happened before (or independent of) whatever the server actually
   * saved. `Regenerate` refuses these (there's nothing real on the
   * backend to regenerate); `retryText`, when set, is the original user
   * text a "Retry" affordance can resend as a fresh turn instead. */
  synthetic?: boolean;
  retryText?: string;
}

/** One inline "conversation → structured engineering state" moment — the
 * UI's visual proof that free text is becoming real, validated
 * `@naqsh/schemas` records, not just being echoed back. */
export interface ExtractionEvent {
  id: string;
  label: string;
  requirement?: Requirement;
  constraint?: Constraint;
  /** The chat message that produced this extraction — lets the chat view
   * show the "REQUIREMENTS UPDATED" chip directly beneath the message
   * that caused it. */
  messageId?: string;
}

/**
 * Onboarding is just the cinematic opening — everything that used to be a
 * forced multi-step wizard (choose environment, existing/new project,
 * guided requirements conversation) now happens inside the chat-first
 * workspace itself (see `chat/useChatThreads.ts` and `settings/`),
 * matching a ChatGPT/Claude-style "start typing" flow rather than a form
 * wizard blocking the way in.
 *
 * An explicit state machine (not ad-hoc booleans/timers scattered across
 * components) -- conceptually:
 *   BOOT / LOADING_IDENTITY -- resolved SYNCHRONOUSLY, before first paint,
 *     inside `OnboardingExperience`'s `useReducer` initializer (a guarded
 *     localStorage read -- see `persistence.ts`). Never rendered as a
 *     visible state: a returning visitor's first paint already shows
 *     "workspace" via `entering`, and a first-time visitor's first paint
 *     already shows "opening" -- there is nothing to flash between.
 *   "opening"   -- `NaqshOpening` is mounted and interactive (the NAQSH
 *                  wordmark settling in, or already static under reduced
 *                  motion).
 *                  The workspace is NEVER mounted underneath this stage.
 *   "entering"  -- the human confirmed (click/Enter/Space) or the
 *                  deterministic fallback timeout fired. The workspace is
 *                  mounted immediately underneath a brief fading veil --
 *                  the SAME transition a returning visitor's instant skip
 *                  uses, unified into one real stage rather than two
 *                  separate ad-hoc code paths.
 *   "workspace" -- steady state; the veil (if any) has finished fading.
 */
export type OnboardingStage = "opening" | "entering" | "workspace";

export interface OnboardingState {
  stage: OnboardingStage;
}

export type OnboardingAction = { type: "CONFIRM" } | { type: "ENTERED" } | { type: "RESTART" };

export const initialOnboardingState: OnboardingState = { stage: "opening" };
