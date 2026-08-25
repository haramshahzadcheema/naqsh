import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CONVERSATION_SCRIPT, extractFromOpeningStatement } from "../onboarding/extraction.js";
import { replyTo, describeAttachments } from "./naqshReply.js";
import { loadThreads, saveThreads } from "./threadStorage.js";
import type { ChatThread } from "./types.js";
import type { ProjectSnapshot } from "../data/NaqshDataSource.js";
import { DEMO_PROJECT } from "../data/demo/demoProject.js";
import { deriveRecommendedCandidateId } from "../data/deriveRecommendedCandidate.js";
import { readFileAsAttachment, type ReadAttachment } from "./fileImport.js";
import type { ExtractionEvent, MessageAttachment } from "../onboarding/types.js";
import { useSettings } from "../settings/SettingsProvider.js";
import {
  ApiError,
  apiApproveApproval,
  apiApproveProposal,
  apiConnectEnvironment,
  apiCreateConversation,
  apiCreateProject,
  apiExecuteProposal,
  apiRegenerateMessage,
  apiRejectApproval,
  apiRejectProposal,
  apiRollback,
  apiSendMessageStream,
  apiSubmitJob,
  apiUploadFiles
} from "../api/client.js";
import type { ChatWorkflowUiEvent } from "./workflowEvents.js";

const OPENING_REPLY_PREFIX = "Got it.\n\nBefore I design anything, I need to establish a few constraints.\n\n";

function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function existingThreadSeed(): ChatThread {
  return {
    id: `thread_${DEMO_PROJECT.id}`,
    projectId: DEMO_PROJECT.id,
    kind: "existing",
    title: DEMO_PROJECT.name,
    createdAt: DEMO_PROJECT.createdAt,
    messages: [],
    scriptStep: 0,
    extractions: [],
    requirements: [],
    constraints: [],
    understandingConfirmed: true,
    workflowEvents: [],
    executions: {}
  };
}

/** Normalizes a thread loaded from localStorage -- persisted threads may
 * predate `workflowEvents`/`executions` (added for Part 12/13), so a raw
 * `JSON.parse` result could be missing them entirely. */
function normalizeThread(thread: ChatThread): ChatThread {
  return { ...thread, workflowEvents: thread.workflowEvents ?? [], executions: thread.executions ?? {} };
}

function currentDesignSummary(snapshot: ProjectSnapshot): string {
  const currentId = deriveRecommendedCandidateId(snapshot.candidates, snapshot.experiments);
  const current = currentId ? snapshot.candidates.find((candidate) => candidate.id === currentId) : undefined;
  const design = current ? snapshot.designSpecifications.find((spec) => spec.id === current.designSpecificationId) : undefined;
  return design?.description ?? "No design has been established yet.";
}

function buildExistingProjectSummaryText(snapshot: ProjectSnapshot): string {
  const openQuestions = snapshot.clarifications.filter((c) => c.status === "pending");
  const lines = [
    "I've inspected the current project.",
    "",
    "OBJECTIVE",
    snapshot.plan?.objectiveSummary ?? "No objective recorded yet.",
    "",
    "CURRENT DESIGN",
    currentDesignSummary(snapshot),
    "",
    "CONSTRAINTS",
    snapshot.constraints.length > 0 ? snapshot.constraints.map((c) => `• ${c.description}`).join("\n") : "None recorded.",
    "",
    "OPEN QUESTIONS",
    openQuestions.length > 0 ? openQuestions.map((c) => `• ${c.question}`).join("\n") : "None right now."
  ];
  return lines.join("\n");
}

/** Extraction from attached text files is independent of the guided
 * script -- it always runs the general pattern matcher (never the
 * narrow, positional "material"/"thickness"/"manufacturing" extractors,
 * which expect a short direct answer, not a whole document). */
function extractFromAttachments(attachments: ReadAttachment[], messageId: string): ExtractionEvent[] {
  return attachments.flatMap((attachment) => (attachment.textContent ? extractFromOpeningStatement(attachment.textContent) : [])).map((event) => ({ ...event, messageId }));
}

export interface UseChatThreads {
  threads: ChatThread[];
  activeThreadId: string | null;
  activeThread: ChatThread | null;
  selectThread: (id: string) => void;
  createNewThread: () => string;
  /** Unlike every other thread, a FreeCAD-backed project can't defer
   * creation to "whenever the first message is sent" -- the adapter needs
   * a real `documentPath` up front (see `POST /projects`'s own
   * validation), so this creates the real backend project IMMEDIATELY and
   * returns the new thread already wired to it. Rethrows the real error
   * (e.g. a 503 if FreeCAD stopped being reachable between discovery and
   * this call, or a 400 for a bad path) so the caller can show it honestly
   * rather than silently landing on a broken thread. */
  connectFreecadProject: (name: string, documentPath: string) => Promise<string>;
  sendMessage: (threadId: string, text: string, files?: File[]) => Promise<void>;
  confirmUnderstanding: (threadId: string) => void;
  dismissUnderstanding: (threadId: string) => void;
  seedExistingThreadIntro: (threadId: string, snapshot: ProjectSnapshot) => void;
  renameThread: (threadId: string, title: string) => void;
  deleteThread: (threadId: string) => void;
  /** Real, in-memory session state (same as rename/delete) -- moves a
   * thread into/out of the sidebar's "Pinned" group. */
  togglePinThread: (threadId: string) => void;
  /** Toggles archived; an archived thread leaves the main date-grouped
   * list but stays reachable in a real, expandable "Archived" section --
   * never a one-way dead end. */
  toggleArchiveThread: (threadId: string) => void;
  /** Part 10: the live text of a reply currently streaming in for a
   * thread, or undefined when nothing is streaming. Rendered as an
   * in-progress assistant bubble; becomes a real message once the stream
   * resolves. */
  streamingText: Record<string, string>;
  /** Part 10: a genuine stop -- aborts the real in-flight fetch. Whatever
   * text already arrived stays on screen as the final message; nothing
   * about this pretends the model was cut off mid-thought more gracefully
   * than it actually was. */
  stopGeneration: (threadId: string) => void;
  /** Part 6/7: the human's real Approve/Reject click -- never a bare
   * frontend boolean. Approving immediately follows through to real
   * execution (Part 11's dialogue: "[Approve] -> [Executing...] ->
   * [Verifying...] -> [Result]"); rejecting stops here. */
  decideProposal: (threadId: string, proposalId: string, decision: "approved" | "rejected") => Promise<void>;
  /** Part 9: the human clicking "Restore previous state" through the
   * real checkpoint mechanism -- never automatic. */
  restoreCheckpoint: (threadId: string, checkpointId: string) => Promise<void>;
  /** Phase C: a real "Regenerate" for the LAST assistant reply in a
   * real-backend thread -- see `apps/api/src/chatWorkflow.ts`'s
   * `regenerateChatReply` doc comment for exactly what it will and won't
   * do. A no-op for the offline/demo path and for any thread with no real
   * backend conversation yet (there's nothing real to re-run). */
  regenerateReply: (threadId: string) => Promise<void>;
  /** Section 5: the human's real Approve/Reject click on one of an
   * exploration's pending Approvals (never a bare frontend boolean, same
   * discipline as `decideProposal`). */
  decideExplorationApproval: (threadId: string, eventId: string, approvalId: string, decision: "approved" | "rejected") => Promise<void>;
  /** Submits the real background job (`POST /projects/:id/jobs`) for an
   * exploration's candidates -- only meaningful once every one of its
   * `pendingApprovals` is actually approved (ExplorationCard enforces
   * this in the UI; the backend enforces it for real via `evaluateToolAuthorization`
   * regardless). */
  startExploration: (threadId: string, eventId: string) => Promise<void>;
}

export function useChatThreads(apiConnected: boolean): UseChatThreads {
  const { styleId, modelId, environment } = useSettings();
  const [threads, setThreads] = useState<ChatThread[]>(() => {
    const stored = loadThreads();
    if (stored && stored.length > 0) return stored.map(normalizeThread);
    return [existingThreadSeed()];
  });
  const [activeThreadId, setActiveThreadId] = useState<string | null>(() => threads[0]?.id ?? null);
  const threadsRef = useRef(threads);
  threadsRef.current = threads;

  /** Part 10: the live, in-progress text of a streaming reply, keyed by
   * thread id -- deliberately NOT part of `threads`/`saveThreads` (it
   * would mean a localStorage write and a full thread re-render on every
   * token). Cleared once the reply either completes or is stopped, at
   * which point the REAL final text is appended to `thread.messages`
   * exactly like a non-streamed reply always was. */
  const [streamingText, setStreamingText] = useState<Record<string, string>>({});
  const abortControllersRef = useRef<Record<string, AbortController>>({});

  const stopGeneration = useCallback((threadId: string) => {
    abortControllersRef.current[threadId]?.abort();
  }, []);

  useEffect(() => {
    saveThreads(threads);
  }, [threads]);

  useEffect(() => {
    if (activeThreadId === null || !threads.some((thread) => thread.id === activeThreadId)) {
      setActiveThreadId(threads[0]?.id ?? null);
    }
  }, [threads, activeThreadId]);

  const selectThread = useCallback((id: string) => setActiveThreadId(id), []);

  const createNewThread = useCallback(() => {
    const thread: ChatThread = {
      id: makeId("thread"),
      projectId: null,
      kind: "new",
      title: "New project",
      createdAt: new Date().toISOString(),
      messages: [{ id: makeId("msg"), role: "naqsh", text: "Tell me what you're trying to build." }],
      scriptStep: 0,
      extractions: [],
      requirements: [],
      constraints: [],
      understandingConfirmed: false,
      workflowEvents: [],
      executions: {}
    };
    setThreads((prev) => [thread, ...prev]);
    setActiveThreadId(thread.id);
    return thread.id;
  }, []);

  const connectFreecadProject = useCallback(async (name: string, documentPath: string) => {
    const project = await apiCreateProject(name || "FreeCAD project", `Connected to ${documentPath}`, "freecad", documentPath);
    // AUDIT FIX: this used to create the project (real) and then print a
    // hardcoded "Connected to the real FreeCAD document" message WITHOUT
    // ever calling the real connect endpoint -- so the chat honestly
    // looked successful even when FreeCAD wasn't reachable, the document
    // path was wrong, or the subprocess failed, while the Environment
    // tab's own badge (which DOES check real session state) correctly
    // showed "disconnected". Reproduced live. `apiConnectEnvironment`
    // throws a real ApiError on failure -- letting it propagate here
    // means the caller's existing try/catch (ConnectFreecadForm) shows
    // the genuine error instead of a thread ever being created for a
    // connection that didn't actually happen.
    const session = await apiConnectEnvironment(project.id);
    const conversation = await apiCreateConversation(project.id);
    const thread: ChatThread = {
      id: makeId("thread"),
      projectId: null,
      kind: "new",
      title: project.name,
      createdAt: new Date().toISOString(),
      messages: [
        {
          id: makeId("msg"),
          role: "naqsh",
          text: `Connected to the real FreeCAD document at ${session.session.documentName}. Tell me what you're trying to build, or ask me what's in the document.`
        }
      ],
      scriptStep: CONVERSATION_SCRIPT.length + 1,
      extractions: [],
      requirements: [],
      constraints: [],
      understandingConfirmed: true,
      workflowEvents: [],
      executions: {},
      apiProjectId: project.id,
      apiConversationId: conversation.id
    };
    setThreads((prev) => [thread, ...prev]);
    setActiveThreadId(thread.id);
    return thread.id;
  }, []);

  const updateThread = useCallback((threadId: string, update: (thread: ChatThread) => ChatThread) => {
    setThreads((prev) => prev.map((thread) => (thread.id === threadId ? update(thread) : thread)));
  }, []);

  const renameThread = useCallback(
    (threadId: string, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      updateThread(threadId, (thread) => ({ ...thread, title: trimmed }));
    },
    [updateThread]
  );

  const deleteThread = useCallback((threadId: string) => {
    setThreads((prev) => {
      const remaining = prev.filter((thread) => thread.id !== threadId);
      return remaining.length > 0 ? remaining : [existingThreadSeed()];
    });
  }, []);

  const togglePinThread = useCallback(
    (threadId: string) => {
      updateThread(threadId, (thread) => ({ ...thread, pinned: !thread.pinned }));
    },
    [updateThread]
  );

  const toggleArchiveThread = useCallback(
    (threadId: string) => {
      updateThread(threadId, (thread) => ({ ...thread, archived: !thread.archived }));
    },
    [updateThread]
  );

  /** New-project threads, while the real API is reachable, run through
   * the ACTUAL backend (Phase B/C/I/J): a real project + conversation get
   * created lazily on the thread's first message (never eagerly, so
   * clicking "+ New chat" without ever typing anything doesn't litter the
   * server with empty projects), then every message is a real
   * `POST /conversations/:id/messages` call -- real Gemini (or an honest
   * "not configured" error), real requirement capture, real activity log.
   * `naqshReply.ts`/`extraction.ts` remain exactly as they were: the
   * offline/demo fallback used when the API isn't reachable, never the
   * production path when it is. */
  const sendOnline = useCallback(
    async (threadId: string, text: string, files: File[]) => {
      const userMessageId = makeId("msg");
      updateThread(threadId, (thread) => {
        const title = thread.title === "New project" && text.trim().length > 0 ? text.slice(0, 48) + (text.length > 48 ? "…" : "") : thread.title;
        return { ...thread, title, pending: true, messages: [...thread.messages, { id: userMessageId, role: "user", text }] };
      });

      // Declared here (not inside the try block) so the catch block below
      // can still read whatever streamed in before a stop/failure -- a
      // plain closure variable, always current within this one call,
      // unlike reading back `streamingText` state (which could be stale
      // relative to the exact moment this particular invocation started).
      let accumulated = "";

      try {
        let current = threadsRef.current.find((t) => t.id === threadId);
        let apiProjectId = current?.apiProjectId;
        let apiConversationId = current?.apiConversationId;

        if (!apiProjectId || !apiConversationId) {
          const project = await apiCreateProject(current?.title ?? "New project", text.slice(0, 500), environment);
          const conversation = await apiCreateConversation(project.id);
          apiProjectId = project.id;
          apiConversationId = conversation.id;
          updateThread(threadId, (thread) => ({ ...thread, apiProjectId, apiConversationId }));
        }

        let fileIds: string[] = [];
        let attachmentMeta: MessageAttachment[] = [];
        if (files.length > 0) {
          const uploaded = await apiUploadFiles(apiProjectId, files);
          fileIds = uploaded.map((f) => f.id);
          attachmentMeta = uploaded.map((f) => ({ id: f.id, name: f.filename, size: f.size, type: f.mimeType, kind: f.extractionStatus === "success" ? "text" : "binary" }));
          updateThread(threadId, (thread) => ({
            ...thread,
            messages: thread.messages.map((m) => (m.id === userMessageId ? { ...m, attachments: attachmentMeta } : m))
          }));
        }

        const controller = new AbortController();
        abortControllersRef.current[threadId] = controller;
        setStreamingText((prev) => ({ ...prev, [threadId]: "" }));

        let result;
        try {
          result = await apiSendMessageStream(
            apiConversationId,
            text,
            modelId,
            styleId,
            fileIds,
            (delta) => {
              accumulated += delta;
              setStreamingText((prev) => ({ ...prev, [threadId]: accumulated }));
            },
            controller.signal
          );
        } finally {
          delete abortControllersRef.current[threadId];
          setStreamingText((prev) => {
            if (!(threadId in prev)) return prev;
            const next = { ...prev };
            delete next[threadId];
            return next;
          });
        }

        updateThread(threadId, (thread) => {
          const assistantMessage = {
            id: result.assistantMessage.id,
            role: "naqsh" as const,
            text: result.assistantMessage.text
          };
          let extractions = thread.extractions;
          let requirements = thread.requirements;
          if (result.requirementOutcome?.kind === "requirement_added") {
            const requirement = result.requirementOutcome.requirement;
            const event: ExtractionEvent = { id: makeId("ext"), label: "Requirement", messageId: userMessageId, requirement };
            extractions = [...extractions, event];
            requirements = [...requirements, requirement];
          }
          // Part 11/13: real Plan/Proposal/failure events the backend
          // actually produced for this message -- anchored here, never
          // fabricated locally.
          const workflowEvents: ChatWorkflowUiEvent[] = result.workflowEvents.map((event) => ({
            ...event,
            id: makeId("wf"),
            messageId: assistantMessage.id,
            ...(event.kind === "exploration_prepared" ? { submittedJobId: null } : {})
          })) as ChatWorkflowUiEvent[];
          return {
            ...thread,
            pending: false,
            messages: [...thread.messages, assistantMessage],
            extractions,
            requirements,
            workflowEvents: [...thread.workflowEvents, ...workflowEvents]
          };
        });
      } catch (error) {
        delete abortControllersRef.current[threadId];
        setStreamingText((prev) => {
          if (!(threadId in prev)) return prev;
          const next = { ...prev };
          delete next[threadId];
          return next;
        });
        // Phase C: `retryText` is only offered when there were no
        // attachments -- a retry resends plain text as a brand-new turn
        // (see `ChatMainView.tsx`'s Retry button), and silently dropping
        // an attachment the user doesn't realize wasn't resent would be
        // exactly the kind of quiet misrepresentation the rest of this
        // codebase avoids.
        const retryText = files.length === 0 ? text : undefined;
        const stopped = error instanceof DOMException && error.name === "AbortError";
        if (stopped) {
          updateThread(threadId, (thread) => ({
            ...thread,
            pending: false,
            messages: [...thread.messages, { id: makeId("msg"), role: "naqsh", text: accumulated.length > 0 ? accumulated : "(Stopped before any reply arrived.)", synthetic: true, retryText }]
          }));
          return;
        }
        const message = error instanceof Error ? error.message : "The request failed.";
        updateThread(threadId, (thread) => ({
          ...thread,
          pending: false,
          messages: [...thread.messages, { id: makeId("msg"), role: "naqsh", text: `Something went wrong talking to the server: ${message}`, synthetic: true, retryText }]
        }));
      }
    },
    [updateThread, modelId, styleId, environment]
  );

  const sendOffline = useCallback(
    async (threadId: string, text: string, files: File[]) => {
      const attachments = await Promise.all(files.map((file) => readFileAsAttachment(file)));
      updateThread(threadId, (thread) => {
        const userMessage = { id: makeId("msg"), role: "user" as const, text, attachments: attachments.length > 0 ? attachments.map((a) => a.meta) : undefined };
        const title = thread.kind === "new" && thread.title === "New project" && text.trim().length > 0 ? text.slice(0, 48) + (text.length > 48 ? "…" : "") : thread.title;
        const attachmentExtractions = extractFromAttachments(attachments, userMessage.id);
        const attachmentLine = describeAttachments(
          attachments.map((a) => a.meta),
          attachmentExtractions.length > 0
        );

        function withAttachmentLine(replyText: string): string {
          return attachmentLine ? `${replyText}\n\n${attachmentLine}` : replyText;
        }

        // scriptStep 0: the opening statement (new-project threads only) --
        // establishes the objective and asks the first scripted question.
        if (thread.kind === "new" && thread.scriptStep === 0) {
          const extractions = [...extractFromOpeningStatement(text).map((event) => ({ ...event, messageId: userMessage.id })), ...attachmentExtractions];
          const naqshReply = { id: makeId("msg"), role: "naqsh" as const, text: withAttachmentLine(`${OPENING_REPLY_PREFIX}${CONVERSATION_SCRIPT[0]!.question}`) };
          return {
            ...thread,
            title,
            messages: [...thread.messages, userMessage, naqshReply],
            scriptStep: 1,
            extractions: [...thread.extractions, ...extractions],
            requirements: [...thread.requirements, ...extractions.flatMap((e) => (e.requirement ? [e.requirement] : []))],
            constraints: [...thread.constraints, ...extractions.flatMap((e) => (e.constraint ? [e.constraint] : []))]
          };
        }

        // scriptStep 1..CONVERSATION_SCRIPT.length: answers to each
        // scripted question in turn. Once scriptStep exceeds the script
        // length, every question has been asked and answered.
        if (thread.kind === "new" && thread.scriptStep >= 1 && thread.scriptStep <= CONVERSATION_SCRIPT.length) {
          const stepIndex = thread.scriptStep - 1;
          const step = CONVERSATION_SCRIPT[stepIndex];
          const extractions = [...(step ? step.extract(text) : []).map((event) => ({ ...event, messageId: userMessage.id })), ...attachmentExtractions];
          const isLastStep = thread.scriptStep >= CONVERSATION_SCRIPT.length;
          const nextMessages = [...thread.messages, userMessage];
          if (!isLastStep) {
            nextMessages.push({ id: makeId("msg"), role: "naqsh", text: withAttachmentLine(CONVERSATION_SCRIPT[thread.scriptStep]!.question) });
          } else if (attachmentLine) {
            nextMessages.push({ id: makeId("msg"), role: "naqsh", text: attachmentLine });
          }
          return {
            ...thread,
            title,
            messages: nextMessages,
            scriptStep: thread.scriptStep + 1,
            extractions: [...thread.extractions, ...extractions],
            requirements: [...thread.requirements, ...extractions.flatMap((e) => (e.requirement ? [e.requirement] : []))],
            constraints: [...thread.constraints, ...extractions.flatMap((e) => (e.constraint ? [e.constraint] : []))]
          };
        }

        // Free-form chat: script finished (or this is the existing-project thread).
        const { reply, extractions: rawExtractions } = replyTo(text, styleId);
        const extractions = [...rawExtractions.map((event) => ({ ...event, messageId: userMessage.id })), ...attachmentExtractions];
        const naqshReply = { id: makeId("msg"), role: "naqsh" as const, text: withAttachmentLine(reply) };
        return {
          ...thread,
          title,
          messages: [...thread.messages, userMessage, naqshReply],
          extractions: [...thread.extractions, ...extractions],
          requirements: [...thread.requirements, ...extractions.flatMap((e) => (e.requirement ? [e.requirement] : []))],
          constraints: [...thread.constraints, ...extractions.flatMap((e) => (e.constraint ? [e.constraint] : []))]
        };
      });
    },
    [updateThread, styleId]
  );

  const sendMessage = useCallback(
    async (threadId: string, text: string, files: File[] = []) => {
      const thread = threadsRef.current.find((t) => t.id === threadId);
      const useOnline = apiConnected && thread?.kind === "new";
      if (useOnline) {
        await sendOnline(threadId, text, files);
      } else {
        await sendOffline(threadId, text, files);
      }
    },
    [apiConnected, sendOnline, sendOffline]
  );

  const confirmUnderstanding = useCallback(
    (threadId: string) => {
      updateThread(threadId, (thread) => ({
        ...thread,
        understandingConfirmed: true,
        messages: [...thread.messages, { id: makeId("msg"), role: "naqsh", text: "Great — I'll keep this updated as we go. What would you like to explore first?" }]
      }));
    },
    [updateThread]
  );

  const dismissUnderstanding = useCallback(
    (threadId: string) => {
      updateThread(threadId, (thread) => ({ ...thread, understandingConfirmed: true }));
    },
    [updateThread]
  );

  const seedExistingThreadIntro = useCallback(
    (threadId: string, snapshot: ProjectSnapshot) => {
      updateThread(threadId, (thread) => {
        if (thread.messages.length > 0) return thread;
        return { ...thread, messages: [{ id: makeId("msg"), role: "naqsh", text: buildExistingProjectSummaryText(snapshot) }] };
      });
    },
    [updateThread]
  );

  const decideProposal = useCallback(
    async (threadId: string, proposalId: string, decision: "approved" | "rejected") => {
      try {
        const outcome = decision === "approved" ? await apiApproveProposal(proposalId) : await apiRejectProposal(proposalId);
        updateThread(threadId, (thread) => ({
          ...thread,
          workflowEvents: thread.workflowEvents.map((event) => (event.kind === "proposal_created" && event.proposal.id === proposalId ? { ...event, proposal: outcome.proposal } : event))
        }));

        if (decision === "rejected") return;

        updateThread(threadId, (thread) => ({ ...thread, executions: { ...thread.executions, [proposalId]: { status: "executing" } } }));
        try {
          const report = await apiExecuteProposal(proposalId);
          updateThread(threadId, (thread) => ({ ...thread, executions: { ...thread.executions, [proposalId]: { status: "done", report } } }));
        } catch (error) {
          const kind = error instanceof ApiError ? error.kind : "execution_failed";
          const message = error instanceof Error ? error.message : "Execution failed.";
          updateThread(threadId, (thread) => ({ ...thread, executions: { ...thread.executions, [proposalId]: { status: "error", kind, message } } }));
        }
      } catch (error) {
        const kind = error instanceof ApiError ? error.kind : "decision_failed";
        const message = error instanceof Error ? error.message : "Could not record the decision.";
        updateThread(threadId, (thread) => ({ ...thread, executions: { ...thread.executions, [proposalId]: { status: "error", kind, message } } }));
      }
    },
    [updateThread]
  );

  const decideExplorationApproval = useCallback(
    async (threadId: string, eventId: string, approvalId: string, decision: "approved" | "rejected") => {
      const thread = threadsRef.current.find((t) => t.id === threadId);
      if (!thread?.apiProjectId) return;
      const updated = decision === "approved" ? await apiApproveApproval(thread.apiProjectId, approvalId) : await apiRejectApproval(thread.apiProjectId, approvalId);
      updateThread(threadId, (t) => ({
        ...t,
        workflowEvents: t.workflowEvents.map((event) =>
          event.kind === "exploration_prepared" && event.id === eventId
            ? { ...event, pendingApprovals: event.pendingApprovals.map((approval) => (approval.id === approvalId ? updated : approval)) }
            : event
        )
      }));
    },
    [updateThread]
  );

  const startExploration = useCallback(
    async (threadId: string, eventId: string) => {
      const thread = threadsRef.current.find((t) => t.id === threadId);
      if (!thread?.apiProjectId) throw new Error("This thread has no real backend project to run an exploration job against.");
      const event = thread.workflowEvents.find((e) => e.id === eventId);
      if (!event || event.kind !== "exploration_prepared") throw new Error("No exploration to start.");

      const job = await apiSubmitJob(thread.apiProjectId, {
        objective: `Explore ${event.candidates.length} alternative${event.candidates.length === 1 ? "" : "s"} for plan step "${event.planStepId}"`,
        candidateIds: event.candidates.map((c) => c.candidate.id),
        autonomyLevel: "approved_modify",
        allowedTools: event.allowedTools,
        budget: { maxIterations: 10, maxDurationMs: 120_000, maxToolCalls: 200, maxModelCalls: 20, maxCandidates: Math.max(event.candidates.length, 1) }
      });
      updateThread(threadId, (t) => ({
        ...t,
        workflowEvents: t.workflowEvents.map((e) => (e.kind === "exploration_prepared" && e.id === eventId ? { ...e, submittedJobId: job.id } : e))
      }));
    },
    [updateThread]
  );

  const restoreCheckpoint = useCallback(
    async (threadId: string, checkpointId: string) => {
      const thread = threadsRef.current.find((t) => t.id === threadId);
      if (!thread?.apiProjectId) throw new Error("This thread has no real backend project to restore against.");
      await apiRollback(thread.apiProjectId, checkpointId, "Restored from chat after a failed verification.");
    },
    []
  );

  const regenerateReply = useCallback(
    async (threadId: string) => {
      const thread = threadsRef.current.find((t) => t.id === threadId);
      if (!thread?.apiConversationId) return; // offline/demo path, or no real backing yet -- nothing real to re-run.
      const lastMessage = thread.messages[thread.messages.length - 1];
      if (!lastMessage || lastMessage.role !== "naqsh") return;

      updateThread(threadId, (t) => ({ ...t, regeneratingMessageId: lastMessage.id }));
      try {
        const result = await apiRegenerateMessage(thread.apiConversationId, lastMessage.id, modelId, styleId);
        updateThread(threadId, (t) => ({
          ...t,
          regeneratingMessageId: undefined,
          messages: t.messages.map((m) => (m.id === lastMessage.id ? { id: result.assistantMessage.id, role: "naqsh" as const, text: result.assistantMessage.text } : m))
        }));
      } catch (error) {
        const message = error instanceof ApiError ? error.message : error instanceof Error ? error.message : "Could not regenerate this reply.";
        updateThread(threadId, (t) => ({
          ...t,
          regeneratingMessageId: undefined,
          messages: [...t.messages, { id: makeId("msg"), role: "naqsh" as const, text: `Couldn't regenerate that reply: ${message}` }]
        }));
      }
    },
    [updateThread, modelId, styleId]
  );

  const activeThread = useMemo(() => threads.find((thread) => thread.id === activeThreadId) ?? null, [threads, activeThreadId]);

  return {
    threads,
    activeThreadId,
    activeThread,
    selectThread,
    createNewThread,
    connectFreecadProject,
    sendMessage,
    confirmUnderstanding,
    dismissUnderstanding,
    seedExistingThreadIntro,
    renameThread,
    deleteThread,
    togglePinThread,
    toggleArchiveThread,
    decideProposal,
    restoreCheckpoint,
    regenerateReply,
    decideExplorationApproval,
    startExploration,
    streamingText,
    stopGeneration
  };
}
