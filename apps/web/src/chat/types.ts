import type { Constraint, Requirement } from "@naqsh/schemas";
import type { ConversationMessage, ExtractionEvent } from "../onboarding/types.js";
import type { ChatWorkflowUiEvent, ExecutionUiState } from "./workflowEvents.js";

export type ThreadKind = "existing" | "new";

/** One entry in the sidebar / one chat. `projectId` is the REAL demo
 * project id for the "existing" thread (so its Overview/Requirements/
 * Design/etc. tabs can reuse the real `ProjectDataProvider` snapshot
 * unchanged) and `null` for a "new" thread created from the `+` button --
 * a fresh idea typed into chat has no backend project behind it yet, so
 * it never pretends to have proposals/verification/experiments that only
 * a real (or the one seeded demo) project actually has. */
export interface ChatThread {
  id: string;
  projectId: string | null;
  kind: ThreadKind;
  title: string;
  createdAt: string;
  messages: ConversationMessage[];
  scriptStep: number;
  extractions: ExtractionEvent[];
  requirements: Requirement[];
  constraints: Constraint[];
  understandingConfirmed: boolean;
  /** Sidebar organization -- both real, in-memory client state (rename/
   * delete already work exactly this way for a "new" thread, see
   * `useChatThreads.ts`'s `updateThread`), not just a visual toggle:
   * pinning moves a thread out of its date bucket into its own "Pinned"
   * group (`groupThreads.ts`), and archiving hides it from the main list
   * while keeping it reachable in a real, expandable "Archived" section
   * -- never a dead end with no way back. */
  pinned?: boolean;
  archived?: boolean;
  /** Part 12/13: real Plan/Proposal/failure events the backend actually
   * produced for a "design this"-type message, anchored to the assistant
   * message that produced them (mirrors `extractions`' own
   * `messageId`-keyed pattern). Empty for the offline/demo fallback --
   * that path never talks to the real engineering workflow. */
  workflowEvents: ChatWorkflowUiEvent[];
  /** The live, real approve/execute state for each proposal id this
   * thread has seen -- never a fabricated progress animation; each state
   * corresponds to an actual backend call currently in flight or
   * resolved (see `ExecutionStatus.tsx`). */
  executions: Record<string, ExecutionUiState>;
  /** Set once this thread is backed by a REAL `@naqsh/api` project +
   * conversation (see `chat/useChatThreads.ts`'s `provisionApiBacking`).
   * `undefined` means this thread is running the local, clearly-labeled
   * demo/offline fallback -- either because the API isn't reachable, or
   * because backing hasn't finished provisioning yet. */
  apiProjectId?: string;
  apiConversationId?: string;
  /** True only while a real API call for this thread is in flight --
   * lets the UI show a genuine "thinking" state instead of an instant,
   * suspiciously-fast reply once a real network round trip is involved. */
  pending?: boolean;
  /** Phase C: the id of the assistant message currently being
   * regenerated, if any -- real backend round trip in flight, same
   * honesty rule as `pending`. Always the CURRENT (about-to-be-replaced)
   * message id, so the UI can key its "Regenerating…" state off it even
   * though that message's own id changes once the call resolves. */
  regeneratingMessageId?: string;
}
