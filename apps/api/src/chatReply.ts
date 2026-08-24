import { createModelRequest } from "@naqsh/schemas";
import type { ModelProvider } from "@naqsh/core";
import type { MemoryRecord, ModelRequestConfigInput, WorldModelState } from "@naqsh/schemas";
import { describeMemoryForModel } from "./memoryContext.js";

/** MODEL selects which model answers; STYLE controls how -- kept as two
 * independent inputs into the same system instruction (Phase Q: "Model
 * ≠ Style... use a server-side controlled mapping," never letting the
 * browser inject an arbitrary system prompt). */
export type AiStyle = "balanced" | "concise" | "detailed" | "technical" | "creative";

const STYLE_INSTRUCTION: Record<AiStyle, string> = {
  balanced: "Answer clearly and evenly -- not too short, not padded.",
  concise: "Answer in as few words as possible. Prefer one short sentence.",
  detailed: "Explain your reasoning, not just the conclusion.",
  technical: "Use precise, terse engineering register. Skip pleasantries.",
  creative: "Answer with a bit more personality and colour, while staying accurate."
};

const SYSTEM_INSTRUCTION_BASE =
  "You are Naqsh, an engineering collaborator working alongside a human engineer inside a CAD/engineering workspace. " +
  "You are not a general-purpose chatbot: ground answers in the project's actual requirements/constraints when relevant. " +
  "You never claim to have modified the engineering environment or executed a tool -- you can only observe, reason, and " +
  "converse; any actual change to project state happens through this application's own structured requirement-capture " +
  "and proposal/approval mechanisms, never by you asserting that it happened.";

export interface ChatReplyOutcome {
  status: "success" | "error";
  text?: string;
  error?: { kind: string; message: string };
}

/** ONE real, plain conversational turn through the P7 `ModelProvider`
 * abstraction -- Gemini (or the deterministic mock provider) generates
 * the actual reply text; nothing here fabricates a canned string.
 *
 * `onChunk`, when supplied, is used ONLY if the provider genuinely
 * supports incremental delivery (`typeof provider.generateStream ===
 * "function"` -- feature-detected, never assumed); otherwise this
 * silently falls back to `provider.generate()` and the caller simply
 * never receives any chunks before the final result, exactly Part 10's
 * "if streaming is unavailable, fall back to normal synchronous
 * response." There is only ONE decision tree for what a chat reply IS
 * (still built right here) -- streaming is purely an augmentation of how
 * the final text is delivered, never a second, parallel implementation
 * of this function. */
export async function generateChatReply(
  provider: ModelProvider,
  state: WorldModelState,
  history: Array<{ role: "user" | "assistant"; text: string }>,
  userMessage: string,
  style: AiStyle,
  modelConfig: ModelRequestConfigInput,
  onChunk?: (deltaText: string) => void,
  memoryRecords: readonly MemoryRecord[] = []
): Promise<ChatReplyOutcome> {
  const transcript = history
    .slice(-10)
    .map((m) => `${m.role === "user" ? "User" : "Naqsh"}: ${m.text}`)
    .join("\n");

  const instruction = [
    describeMemoryForModel(memoryRecords),
    "",
    transcript.length > 0 ? `Conversation so far:\n${transcript}\n` : "",
    `User: ${userMessage}`,
    "",
    "Reply as Naqsh, in plain text (no markdown headers). Ground your answer in the project memory above when it's relevant -- e.g. don't re-propose an approach memory already records as rejected, without acknowledging that."
  ]
    .filter(Boolean)
    .join("\n");

  const request = createModelRequest({
    systemInstruction: `${SYSTEM_INSTRUCTION_BASE} ${STYLE_INSTRUCTION[style]}`,
    context: {
      projectId: state.project.id,
      projectName: state.project.name || null,
      projectSummary: state.project.description || null,
      objectiveSummary: state.project.objective.summary || null,
      requirementCount: state.project.requirements.length,
      constraintCount: state.project.constraints.length
    },
    instruction,
    tools: [],
    outputSchema: null,
    config: modelConfig,
    sessionId: null
  });

  const canStream = typeof onChunk === "function" && typeof provider.generateStream === "function";
  const result = canStream ? await provider.generateStream!(request, onChunk!) : await provider.generate(request);

  if (result.status === "error" || !result.response) {
    return { status: "error", error: result.error ?? { kind: "malformed_response", message: "Model returned no response." } };
  }

  return { status: "success", text: result.response.text ?? "" };
}
