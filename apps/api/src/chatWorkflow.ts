import { createId } from "@naqsh/schemas";
import type { ConversationRecord, FileRecord, MessageRecord, MessageRepository, FileRepository, ProjectRecord } from "./db/repositories.js";
import type { ProjectRuntime, RequirementCaptureOutcome } from "./projectRuntime.js";
import { captureRequirementFromStatement } from "./projectRuntime.js";
import type { ModelProvider } from "@naqsh/core";
import { generateChatReply, type AiStyle } from "./chatReply.js";
import { generateProjectPlan, generateProjectProposal, prepareExploration } from "./engineeringWorkflow.js";
import { hasDesignIntent, hasExplorationIntent, parseExplorationCount, type ChatWorkflowEvent } from "./workflowEvents.js";
import { describeModelError } from "./modelErrors.js";

/**
 * Part 32's "no business logic in routes" requirement, applied to the one
 * handler that used to violate it the most: `POST /conversations/:id/
 * messages` (server.ts) previously inlined requirement capture, the
 * design-intent trigger, plan/proposal generation, and plain chat reply
 * generation directly in the route body. This function is that entire
 * decision tree, extracted -- server.ts's handler is now parse request ->
 * load records -> call this -> persist + respond, nothing else.
 */
/**
 * The most recent plan that still has unfinished work, or null.
 *
 * "Resumable" means it has at least one step that is still pending --
 * a fully completed plan is finished, and a genuinely new objective
 * should get a new plan rather than resurrecting an old one.
 */
function findResumablePlan(runtime: ProjectRuntime) {
  const plans = [...runtime.plans.values()].filter((plan) => plan.steps.some((step) => step.status === "pending"));
  if (plans.length === 0) return null;
  return plans.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

export interface SendChatMessageInput {
  conversation: ConversationRecord;
  project: ProjectRecord;
  runtime: ProjectRuntime;
  provider: ModelProvider;
  modelId: string;
  style: AiStyle;
  text: string;
  fileIds: string[];
  messages: MessageRepository;
  files: FileRepository;
  /** Optional: incremental delivery of the PLAIN-CHAT-REPLY branch only
   * (see chatReply.ts's own doc comment) -- the design-intent branch
   * (plan/proposal generation) requires a complete, schema-valid
   * structured response before it means anything, so it is never
   * streamed; a caller that passed `onChunk` simply receives zero chunks
   * when that branch runs, then the complete result once this resolves. */
  onChunk?: (deltaText: string) => void;
}

export interface SendChatMessageResult {
  userMessage: MessageRecord;
  assistantMessage: MessageRecord;
  requirementOutcome: RequirementCaptureOutcome | null;
  workflowEvents: ChatWorkflowEvent[];
}

export async function sendChatMessage(input: SendChatMessageInput): Promise<SendChatMessageResult> {
  const { conversation, runtime, provider, modelId, style, text, fileIds, messages, files, onChunk } = input;

  const userMessage: MessageRecord = { id: createId("msg"), conversationId: conversation.id, role: "user", text, createdAt: new Date().toISOString(), fileIds };
  messages.save(userMessage);

  // Attached text files become part of what's actually being interpreted,
  // exactly like typed text does -- never a decorative chip disconnected
  // from what the model actually sees.
  const attachedText = fileIds
    .map((id) => files.get(id))
    .filter((f): f is FileRecord => f !== null && f.extractionStatus === "success" && f.extractedText !== null)
    .map((f) => `[${f.filename}]\n${f.extractedText}`)
    .join("\n\n");
  const interpretationInput = [text, attachedText].filter(Boolean).join("\n\n");

  let requirementOutcome: RequirementCaptureOutcome | null = null;
  if (interpretationInput.trim()) {
    requirementOutcome = await captureRequirementFromStatement(runtime, provider, interpretationInput, { modelId });
  }

  // Part 11: natural language driving the engineering workflow. A simple,
  // honest, deterministic trigger (see workflowEvents.ts) -- everything it
  // causes (planning, proposal generation) is real backend/Gemini work,
  // never fabricated.
  const workflowEvents: ChatWorkflowEvent[] = [];
  let assistantText: string | null = null;
  let assistantError: { kind: string; message: string } | undefined;

  // Checked BEFORE hasDesignIntent: "make it lighter"/"explore alternatives"
  // is a more specific ask than "design this" and the two patterns don't
  // overlap today, but exploration should win if that ever changes.
  if (hasExplorationIntent(text)) {
    if (runtime.getState().project.requirements.length === 0) {
      assistantText = "I don't have enough information yet -- tell me the requirements (load, dimensions, material, etc.) before I explore alternatives.";
    } else {
      const count = parseExplorationCount(text);
      const explorationOutcome = await prepareExploration(runtime, provider, { modelId }, count);
      if (explorationOutcome.status === "error") {
        workflowEvents.push({ kind: "workflow_failed", stage: "exploration", message: explorationOutcome.error.message });
        assistantText = `I couldn't explore alternatives (${explorationOutcome.error.message}).`;
      } else {
        const { exploration } = explorationOutcome;
        workflowEvents.push({
          kind: "exploration_prepared",
          planId: exploration.planId,
          planStepId: exploration.planStepId,
          candidates: exploration.candidates,
          failures: exploration.failures,
          pendingApprovals: exploration.pendingApprovals,
          allowedTools: exploration.allowedTools
        });
        assistantText = `I've generated ${exploration.candidates.length} alternative design${exploration.candidates.length === 1 ? "" : "s"}. Approve the actions below to build, verify, and compare them.`;
      }
    }
  } else if (hasDesignIntent(text)) {
    if (runtime.getState().project.requirements.length === 0) {
      assistantText = "I don't have enough information yet -- tell me the requirements (load, dimensions, material, etc.) before I design anything.";
    } else {
      // CONTINUE an existing plan rather than replacing it.
      //
      // This branch used to call generateProjectPlan unconditionally, so
      // every design-intent message threw away the plan in progress and
      // built a fresh one -- and since a proposal always realizes the
      // FIRST pending step, step 2 was unreachable. Observed live: a plan
      // whose step 2 was "Create LowerBody Box" re-proposed its step-1
      // verification forever, so no geometry could ever be built through
      // chat regardless of how many approvals were given.
      //
      // Combined with executeProposal now marking a step complete, saying
      // "generate" again genuinely advances: step 1, then 2, then 3.
      const existingPlan = findResumablePlan(runtime);
      let planId: string | null = null;

      if (existingPlan) {
        planId = existingPlan.id;
        workflowEvents.push({ kind: "plan_created", plan: existingPlan });
      } else {
        const planOutcome = await generateProjectPlan(runtime, provider, { modelId });
        if (planOutcome.status === "error") {
          workflowEvents.push({ kind: "workflow_failed", stage: "planning", message: planOutcome.error.message });
          assistantText = `I couldn't generate a plan (${planOutcome.error.message}).`;
        } else {
          planId = planOutcome.plan.id;
          workflowEvents.push({ kind: "plan_created", plan: planOutcome.plan });
        }
      }

      if (planId !== null) {
        const proposalOutcome = await generateProjectProposal(runtime, provider, planId, { modelId });
        if (proposalOutcome.status === "error") {
          workflowEvents.push({ kind: "workflow_failed", stage: "proposal", message: proposalOutcome.error.message });
          assistantText = `I planned this, but couldn't prepare a concrete proposal (${proposalOutcome.error.message}).`;
        } else {
          workflowEvents.push({ kind: "proposal_created", proposal: proposalOutcome.proposal, approvalId: proposalOutcome.approvalId });
          const step = (existingPlan ?? null)?.steps.find((candidate) => candidate.id === proposalOutcome.proposal.planStepId);
          assistantText = step
            ? `Next step: "${step.title}". I've prepared the change below -- approve it and say "generate" again to continue.`
            : "I have enough information. I've prepared a design proposal -- take a look below.";
        }
      }
    }
  }

  if (assistantText === null) {
    const history = messages
      .listForConversation(conversation.id)
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", text: m.text }));

    const reply = await generateChatReply(provider, runtime.getState(), history, text || "(see attached file)", style, { modelId }, onChunk, runtime.memory.listForProject(runtime.projectId));
    assistantText = reply.status === "success" ? reply.text || "…" : describeModelError(reply.error);
    assistantError = reply.status === "error" ? reply.error : undefined;
  }

  const assistantMessage: MessageRecord = {
    id: createId("msg"),
    conversationId: conversation.id,
    role: "assistant",
    text: assistantText,
    createdAt: new Date().toISOString(),
    error: assistantError
  };
  messages.save(assistantMessage);

  return { userMessage, assistantMessage, requirementOutcome, workflowEvents };
}

export interface RegenerateChatReplyInput {
  conversation: ConversationRecord;
  runtime: ProjectRuntime;
  provider: ModelProvider;
  modelId: string;
  style: AiStyle;
  messages: MessageRepository;
  /** The assistant message the user wants a fresh reply for. */
  targetMessageId: string;
}

export type RegenerateChatReplyOutcome = { status: "success"; assistantMessage: MessageRecord } | { status: "error"; error: { kind: string; message: string } };

/**
 * Re-runs the PLAIN-CHAT-REPLY branch only (see `generateChatReply`'s own
 * doc comment) for the most recent assistant turn, replacing it with a
 * fresh one -- never re-running requirement capture or the design-intent
 * workflow (plan/proposal generation), which already ran once for this
 * turn and would otherwise be duplicated in the project's real state.
 * Deliberately restricted to the LAST message in the conversation (no
 * mid-history branching) and refuses a target whose prompt carried design
 * intent -- an honest "not supported yet" rather than risking a duplicate
 * plan/proposal, per this codebase's "never fake a capability" rule.
 */
export async function regenerateChatReply(input: RegenerateChatReplyInput): Promise<RegenerateChatReplyOutcome> {
  const { conversation, runtime, provider, modelId, style, messages, targetMessageId } = input;
  const history = messages.listForConversation(conversation.id);
  const targetIndex = history.findIndex((m) => m.id === targetMessageId);
  if (targetIndex === -1) return { status: "error", error: { kind: "not_found", message: `No message with id "${targetMessageId}" in this conversation.` } };

  const target = history[targetIndex]!;
  if (target.role !== "assistant") return { status: "error", error: { kind: "invalid_input", message: "Only an assistant reply can be regenerated." } };
  if (targetIndex !== history.length - 1) return { status: "error", error: { kind: "invalid_input", message: "Only the most recent reply can be regenerated." } };

  const precedingUser = history[targetIndex - 1];
  if (!precedingUser || precedingUser.role !== "user") {
    return { status: "error", error: { kind: "invalid_input", message: "There's no preceding user message to regenerate a reply for." } };
  }
  if (hasDesignIntent(precedingUser.text) || hasExplorationIntent(precedingUser.text)) {
    return { status: "error", error: { kind: "unsupported", message: "Regenerating a design-workflow reply isn't supported yet -- it would risk creating a duplicate plan, proposal, or exploration." } };
  }

  const priorHistory = history
    .slice(0, targetIndex - 1)
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", text: m.text }));

  const reply = await generateChatReply(provider, runtime.getState(), priorHistory, precedingUser.text || "(see attached file)", style, { modelId }, undefined, runtime.memory.listForProject(runtime.projectId));
  const assistantText = reply.status === "success" ? reply.text || "…" : describeModelError(reply.error);
  const assistantError = reply.status === "error" ? reply.error : undefined;

  const assistantMessage: MessageRecord = {
    id: createId("msg"),
    conversationId: conversation.id,
    role: "assistant",
    text: assistantText,
    createdAt: new Date().toISOString(),
    error: assistantError
  };
  messages.delete(target.id);
  messages.save(assistantMessage);

  return { status: "success", assistantMessage };
}
