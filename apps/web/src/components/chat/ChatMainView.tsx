import { useEffect, useRef, useState } from "react";
import type { EngineeringObject } from "@naqsh/schemas";
import type { ChatThread } from "../../chat/types.js";
import { formatFileSize } from "../../chat/fileImport.js";
import { CONVERSATION_SCRIPT } from "../../onboarding/extraction.js";
import type { MessageAttachment } from "../../onboarding/types.js";
import { UnderstandingCard } from "../onboarding/UnderstandingCard.js";
import { LoadingState, ErrorState } from "../common/States.js";
import { useProjectData } from "../../data/ProjectDataProvider.js";
import { useApiConnection } from "../../api/ApiConnectionProvider.js";
import { useSettings } from "../../settings/SettingsProvider.js";
import { MODEL_OPTIONS } from "../../settings/models.js";
import { STYLE_OPTIONS, type StyleId } from "../../settings/styles.js";
import { Picker, type PickerOption } from "../common/Picker.js";
import { DocumentIcon, PaperclipIcon } from "../common/Icons.js";
import { MessageText, CopyButton } from "./MessageText.js";
import { PlanCard } from "../plan/PlanCard.js";
import { ProposalCard } from "../proposal/ProposalCard.js";
import { ExecutionStatus } from "../execution/ExecutionStatus.js";
import { ExplorationCard } from "../design/ExplorationCard.js";

/** Real availability, not decoration -- a Gemini option is only ever
 * marked "Available" once the SERVER has confirmed `GEMINI_API_KEY` is
 * actually configured (`useApiConnection`'s `geminiConfigured`); when the
 * API itself is unreachable, every model can only ever drive the local
 * offline demo, whatever its own provider status would otherwise be. The
 * deterministic mock model is always genuinely usable (it's the one thing
 * that never depends on network/credentials), so it is the only entry
 * that's never anything but "Available." Never disables an option outright
 * -- selecting an unconfigured Gemini model is allowed, and surfaces its
 * own honest failure the moment it's actually used (matching this app's
 * "never fabricate success, but never block a real attempt" precedent). */
function toModelPickerOptions(apiConnected: boolean, geminiConfigured: boolean): PickerOption[] {
  return MODEL_OPTIONS.map((option) => {
    if (option.provider === "Mock") {
      return { id: option.id, label: option.label, meta: option.provider, description: option.note, statusLabel: "Always available", statusTone: "info" as const };
    }
    if (!apiConnected) {
      return { id: option.id, label: option.label, meta: option.provider, description: option.note, statusLabel: "Offline demo only", statusTone: "pending" as const };
    }
    return geminiConfigured
      ? { id: option.id, label: option.label, meta: option.provider, description: option.note, statusLabel: "Available", statusTone: "success" as const }
      : { id: option.id, label: option.label, meta: option.provider, description: option.note, statusLabel: "Not configured on server", statusTone: "warning" as const };
  });
}

function toStylePickerOptions(): PickerOption[] {
  return STYLE_OPTIONS.map((option) => ({ id: option.id, label: option.label, description: option.description }));
}

function ExtractionChip({ events }: { events: ChatThread["extractions"] }): JSX.Element {
  return (
    <div className="extraction-chip" role="status">
      <span className="extraction-chip__title">Requirements updated</span>
      <ul className="extraction-chip__list">
        {events.map((event) => (
          <li key={event.id}>
            <span aria-hidden="true">✓</span>
            <span className="extraction-chip__label">{event.label}</span>
            <span className="extraction-chip__value mono">
              {event.requirement
                ? `${String(event.requirement.value ?? "")}${event.requirement.unit ? ` ${event.requirement.unit}` : ""}`
                : String(event.constraint?.value ?? event.constraint?.description ?? "")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AttachmentChip({ attachment }: { attachment: MessageAttachment }): JSX.Element {
  return (
    <div className="attachment-chip">
      <span className="attachment-chip__icon">{attachment.kind === "text" ? <DocumentIcon /> : <PaperclipIcon />}</span>
      <span className="attachment-chip__name">{attachment.name}</span>
      <span className="attachment-chip__size mono">{formatFileSize(attachment.size)}</span>
    </div>
  );
}

interface PendingFile {
  id: string;
  file: File;
}

/** Part 12/13: renders whatever real Plan/Proposal/failure events the
 * backend actually attached to one assistant message -- a PlanCard for
 * `plan_created`, a real ProposalCard (wired to Approve/Reject -> real
 * approve+execute calls) for `proposal_created`, and an honest failure
 * banner for `workflow_failed`. Nothing here is rendered unless the
 * matching backend event actually arrived. */
function WorkflowEvents({
  events,
  executions,
  objects,
  onDecideProposal,
  onRestoreCheckpoint,
  onDecideExplorationApproval,
  onStartExploration
}: {
  events: ChatThread["workflowEvents"];
  executions: ChatThread["executions"];
  objects: EngineeringObject[];
  onDecideProposal: (proposalId: string, decision: "approved" | "rejected") => Promise<void>;
  onRestoreCheckpoint: (checkpointId: string) => Promise<void>;
  onDecideExplorationApproval: (eventId: string, approvalId: string, decision: "approved" | "rejected") => Promise<void>;
  onStartExploration: (eventId: string) => Promise<void>;
}): JSX.Element | null {
  if (events.length === 0) return null;
  return (
    <div className="workflow-events">
      {events.map((event) => {
        if (event.kind === "plan_created") return <PlanCard key={event.id} plan={event.plan} />;
        if (event.kind === "workflow_failed") return <ErrorState key={event.id} title="Couldn't complete this" message={event.message} />;
        if (event.kind === "exploration_prepared") {
          return (
            <ExplorationCard
              key={event.id}
              event={event}
              onDecideApproval={(approvalId, decision) => onDecideExplorationApproval(event.id, approvalId, decision)}
              onStart={() => onStartExploration(event.id)}
            />
          );
        }
        const execution = executions[event.proposal.id];
        return (
          <div key={event.id} className="workflow-events__proposal">
            <ProposalCard proposal={event.proposal} objects={objects} onApprove={(p) => onDecideProposal(p.id, "approved")} onReject={(p) => onDecideProposal(p.id, "rejected")} />
            {execution ? <ExecutionStatus state={execution} onRestore={onRestoreCheckpoint} /> : null}
          </div>
        );
      })}
    </div>
  );
}

export function ChatMainView({
  thread,
  onSend,
  onConfirmUnderstanding,
  onDismissUnderstanding,
  onSeedIntro,
  onDecideProposal,
  onRestoreCheckpoint,
  onDecideExplorationApproval,
  onStartExploration,
  onRegenerate,
  streamingText,
  onStop
}: {
  thread: ChatThread;
  onSend: (text: string, files?: File[]) => Promise<void> | void;
  onConfirmUnderstanding: () => void;
  onDismissUnderstanding: () => void;
  onSeedIntro: () => void;
  onDecideProposal: (proposalId: string, decision: "approved" | "rejected") => Promise<void>;
  onRestoreCheckpoint: (checkpointId: string) => Promise<void>;
  onDecideExplorationApproval: (eventId: string, approvalId: string, decision: "approved" | "rejected") => Promise<void>;
  onStartExploration: (eventId: string) => Promise<void>;
  /** Phase C: regenerate the LAST assistant reply -- a no-op call for any
   * thread with no real backend conversation (see `useChatThreads.ts`'s
   * `regenerateReply`), so it's always safe to wire up unconditionally. */
  onRegenerate: () => Promise<void>;
  /** Part 10: live text of a reply currently streaming in for THIS
   * thread, or undefined when nothing is streaming right now. */
  streamingText?: string;
  onStop: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState("");
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [sending, setSending] = useState(false);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Counts nested dragenter/dragleave pairs -- a drag that passes over a
  // CHILD element (the textarea, the toolbar) fires dragleave on the
  // parent form even though the drag is still genuinely over the
  // composer as a whole. Only clearing the "dragging" state once this
  // count returns to zero is what stops the drop-zone overlay from
  // flickering as the cursor moves across the form's own children.
  const dragCounterRef = useRef(0);
  const { snapshot } = useProjectData();
  const apiConnection = useApiConnection();
  const { modelId, setModelId, styleId, setStyleId } = useSettings();

  // Grows with content up to the CSS max-height (chat.css), rather than
  // staying a fixed one-line box that just scrolls its own text --
  // resetting to "auto" first is what lets scrollHeight shrink back down
  // again after deleting a long paste, not just grow.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  useEffect(() => {
    if (thread.kind === "existing" && thread.messages.length === 0 && snapshot.status === "ready") {
      onSeedIntro();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.id, thread.kind, thread.messages.length, snapshot.status]);

  useEffect(() => {
    const list = listRef.current;
    if (list && typeof list.scrollTo === "function") {
      list.scrollTo({ top: list.scrollHeight });
    }
  }, [thread.messages.length, streamingText]);

  async function submit(): Promise<void> {
    const text = draft.trim();
    if (!text && pendingFiles.length === 0) return;
    setSending(true);
    try {
      await onSend(text || "(file attached)", pendingFiles.map((pending) => pending.file));
      setDraft("");
      setPendingFiles([]);
    } finally {
      setSending(false);
    }
  }

  function addFiles(fileList: FileList | null): void {
    if (!fileList) return;
    const next = Array.from(fileList).map((file) => ({ id: `${file.name}_${file.size}_${Math.random().toString(36).slice(2, 8)}`, file }));
    setPendingFiles((prev) => [...prev, ...next]);
  }

  const showUnderstanding = thread.kind === "new" && thread.scriptStep > CONVERSATION_SCRIPT.length && !thread.understandingConfirmed;
  const waitingForIntro = thread.kind === "existing" && thread.messages.length === 0;

  return (
    <div className="chat-main">
      <div className="chat-main__messages" ref={listRef}>
        {waitingForIntro ? (
          <div className="chat-main__intro-loading">
            <p className="onboarding-step__ack">I can inspect the current model before we continue.</p>
            <LoadingState label="Inspecting the current project…" />
          </div>
        ) : null}

        {thread.messages.map((message, index) => {
          const isLastMessage = index === thread.messages.length - 1;
          const canRegenerate =
            message.role === "naqsh" && !message.synthetic && isLastMessage && thread.apiConversationId !== undefined && streamingText === undefined && !thread.pending;
          const isRegenerating = thread.regeneratingMessageId === message.id;
          // A synthetic (stopped/error) placeholder was never saved to the
          // real backend, so there's nothing there to regenerate --
          // "Retry" resends the original text as a brand-new turn instead.
          const canRetry = message.role === "naqsh" && message.synthetic && message.retryText !== undefined && isLastMessage && streamingText === undefined && !thread.pending;
          return (
          <div key={message.id}>
            <div className={`conversation-message conversation-message--${message.role}`}>
              <span className="conversation-message__sender">
                {message.role === "naqsh" ? "Naqsh" : "You"}
                {message.role === "naqsh" ? <CopyButton text={message.text} /> : null}
                {canRegenerate ? (
                  <button type="button" className="conversation-message__regenerate" onClick={onRegenerate} disabled={isRegenerating}>
                    {isRegenerating ? "Regenerating…" : "Regenerate"}
                  </button>
                ) : null}
                {canRetry ? (
                  <button type="button" className="conversation-message__regenerate" onClick={() => onSend(message.retryText!)}>
                    Retry
                  </button>
                ) : null}
              </span>
              <MessageText text={message.text} />
              {message.attachments && message.attachments.length > 0 ? (
                <div className="attachment-chip-row">
                  {message.attachments.map((attachment) => (
                    <AttachmentChip key={attachment.id} attachment={attachment} />
                  ))}
                </div>
              ) : null}
            </div>
            {thread.extractions.filter((event) => event.messageId === message.id).length > 0 ? (
              <ExtractionChip events={thread.extractions.filter((event) => event.messageId === message.id)} />
            ) : null}
            <WorkflowEvents
              events={thread.workflowEvents.filter((event) => event.messageId === message.id)}
              executions={thread.executions}
              objects={snapshot.status === "ready" ? snapshot.data.objects : []}
              onDecideProposal={onDecideProposal}
              onRestoreCheckpoint={onRestoreCheckpoint}
              onDecideExplorationApproval={onDecideExplorationApproval}
              onStartExploration={onStartExploration}
            />
          </div>
          );
        })}

        {streamingText !== undefined ? (
          <div className="conversation-message conversation-message--naqsh" role="status">
            <span className="conversation-message__sender">Naqsh</span>
            {streamingText.length > 0 ? <MessageText text={streamingText} /> : <p className="conversation-message__text conversation-message__text--thinking">Thinking…</p>}
          </div>
        ) : thread.pending ? (
          <div className="conversation-message conversation-message--naqsh" role="status">
            <span className="conversation-message__sender">Naqsh</span>
            <p className="conversation-message__text conversation-message__text--thinking">Thinking…</p>
          </div>
        ) : null}

        {showUnderstanding ? (
          <UnderstandingCard
            objective={thread.messages.find((m) => m.role === "user")?.text ?? ""}
            requirements={thread.requirements}
            constraints={thread.constraints}
            extractions={thread.extractions}
            onConfirm={onConfirmUnderstanding}
            onKeepRefining={onDismissUnderstanding}
          />
        ) : null}
      </div>

      <form
        className={isDraggingFiles ? "chat-main__composer is-dragging-files" : "chat-main__composer"}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          dragCounterRef.current += 1;
          setIsDraggingFiles(true);
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
        }}
        onDragLeave={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
          if (dragCounterRef.current === 0) setIsDraggingFiles(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          dragCounterRef.current = 0;
          setIsDraggingFiles(false);
          addFiles(event.dataTransfer.files);
        }}
      >
        {isDraggingFiles ? (
          <div className="chat-main__drop-overlay" aria-hidden="true">
            <span>Drop to attach</span>
          </div>
        ) : null}

        {pendingFiles.length > 0 ? (
          <div className="attachment-chip-row attachment-chip-row--pending">
            {pendingFiles.map((pending) => (
              <div key={pending.id} className="attachment-chip attachment-chip--pending">
                <span className="attachment-chip__icon">
                  <PaperclipIcon />
                </span>
                <span className="attachment-chip__name">{pending.file.name}</span>
                <span className="attachment-chip__size mono">{formatFileSize(pending.file.size)}</span>
                <button
                  type="button"
                  className="attachment-chip__remove"
                  aria-label={`Remove ${pending.file.name}`}
                  onClick={() => setPendingFiles((prev) => prev.filter((p) => p.id !== pending.id))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <div className="chat-main__composer-row">
          <label className="visually-hidden" htmlFor="chat-composer">
            Message Naqsh
          </label>
          <textarea
            ref={textareaRef}
            id="chat-composer"
            rows={1}
            placeholder="Message Naqsh…"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
          />
        </div>

        <div className="chat-main__composer-toolbar">
          <div className="chat-main__composer-toolbar-left">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="visually-hidden"
              onChange={(event) => {
                addFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <button type="button" className="chat-main__attach-btn" aria-label="Attach files" title="Attach files" onClick={() => fileInputRef.current?.click()}>
              +
            </button>
          </div>
          <div className="chat-main__composer-toolbar-right">
            <Picker label="AI style" value={styleId} options={toStylePickerOptions()} onChange={(id) => setStyleId(id as StyleId)} triggerClassName="picker__trigger--composer picker__trigger--quiet" />
            <Picker
              label="Reasoning model"
              value={modelId}
              options={toModelPickerOptions(apiConnection.status === "connected", apiConnection.geminiConfigured)}
              onChange={setModelId}
              triggerClassName="picker__trigger--composer"
            />
            {thread.pending ? (
              <button type="button" className="btn btn--primary" onClick={onStop}>
                Stop
              </button>
            ) : (
              <button type="submit" className="btn btn--primary" disabled={sending || (!draft.trim() && pendingFiles.length === 0)}>
                {sending ? "Sending…" : "Send"}
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
