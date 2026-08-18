import {
  assertRequirementCandidate,
  createClarification,
  createTool,
  ToolError,
  WorldModelValidationError,
  type Clarification,
  type RequirementCandidate,
  type Tool,
  type ToolValueSchema,
  type WorldModelState
} from "@naqsh/schemas";
import type { ClarificationStore } from "./clarification-store.js";
import { analyzeRequirementCandidateCompleteness, draftToClarificationInput } from "./requirement-completeness.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * The agent-facing wrapper around `analyzeRequirementCandidateCompleteness`
 * (P19) -- mirrors `interpret_requirement`'s (P18) exact shape and
 * reasoning. Classified `mutation: "suggest"` -- producing `Clarification`
 * records is a new, independent audit record (like `create_check`/
 * `create_checkpoint`), never a `WorldModelState` write; the handler has no
 * write path to the World Model at all.
 *
 * DUPLICATE-PREVENTION (Step 19): for each candidate clarification the pure
 * analyzer proposes, this handler checks `ClarificationStore` for an
 * existing record on the SAME `(requirementCandidateId, question)` pair:
 *   - an existing "pending" one with the IDENTICAL question -> reused,
 *     no duplicate created.
 *   - an existing "pending" one for the SAME category but a DIFFERENT
 *     question (the candidate was re-interpreted and the question
 *     changed) -> the old one is marked "superseded", a fresh "pending"
 *     one is created. ONLY attempted when this is the ONLY draft in the
 *     CURRENT batch carrying that category -- "make it lightweight and
 *     strong" produces TWO independent drafts that both happen to share
 *     the coarse `"missing_threshold"` category (mass, load); superseding
 *     across category alone would have the second draft's creation
 *     immediately supersede the first's freshly-created record, silently
 *     collapsing two genuinely independent clarifications into one (an
 *     audit-caught regression -- see `clarification-integration.test.ts`'s
 *     "two independent same-category clarifications" test). Category
 *     equality is only a trustworthy signal of "this is a refined version
 *     of the SAME issue" when nothing else in this batch also claims that
 *     category.
 *   - an existing "answered" one for the SAME category -> already
 *     resolved for this candidate; skipped entirely (never re-asked).
 *   - nothing existing for that category -> a new "pending" one is
 *     created.
 * This is the ENTIRE duplicate-prevention mechanism -- no elaborate
 * conversation manager, matching the brief's own "just enforce sane
 * invariants" instruction.
 */

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    candidate: { type: "object", properties: {}, additionalProperties: true, description: "The RequirementCandidate (P18) to analyze for completeness." }
  },
  required: ["candidate"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    needsClarification: { type: "boolean" },
    clarifications: { type: "array", items: { type: "object", properties: {}, additionalProperties: true } }
  },
  required: ["needsClarification", "clarifications"]
};

function toAnalyzeInput(rawInput: unknown): RequirementCandidate {
  const record = rawInput as { candidate?: unknown };
  try {
    assertRequirementCandidate(record.candidate);
  } catch (error) {
    if (error instanceof WorldModelValidationError) {
      throw new ToolError("invalid_input", `candidate is invalid: ${error.message}`);
    }
    throw error;
  }
  return record.candidate;
}

function resolveOrCreate(
  store: ClarificationStore,
  draft: ReturnType<typeof draftToClarificationInput>,
  projectId: string,
  allowSupersede: boolean
): Clarification | null {
  const existingForCandidate = store.listForCandidate(draft.requirementCandidateId);

  const identicalPending = existingForCandidate.find((c) => c.status === "pending" && c.question === draft.question);
  if (identicalPending) return identicalPending;

  const alreadyAnsweredSameCategory = existingForCandidate.find((c) => c.status === "answered" && c.category === draft.category);
  if (alreadyAnsweredSameCategory) return null; // already resolved for this candidate; do not re-ask

  const stalePendingSameCategory = allowSupersede ? existingForCandidate.find((c) => c.status === "pending" && c.category === draft.category) : undefined;

  const created = createClarification({ ...draft, projectId });
  store.save(created);

  if (stalePendingSameCategory) {
    store.supersede(stalePendingSameCategory.id, created.id);
  }

  return created;
}

export function createAnalyzeRequirementCompletenessTool(getState: () => WorldModelState, clarificationStore: ClarificationStore): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "analyze_requirement_completeness",
    description:
      "Analyzes a RequirementCandidate (P18) for missing/ambiguous/conflicting information relative to the current project, deterministically (no Gemini call). Returns needsClarification plus zero or more Clarification records -- never invents an engineering assumption to make an incomplete requirement look complete. Never mutates the World Model.",
    target: "world_model",
    mutation: "suggest",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = (rawInput) => {
    const candidate = toAnalyzeInput(rawInput);
    const state = getState();
    const analysis = analyzeRequirementCandidateCompleteness(candidate, state);

    const categoryCounts = new Map<string, number>();
    for (const draft of analysis.drafts) {
      categoryCounts.set(draft.category, (categoryCounts.get(draft.category) ?? 0) + 1);
    }

    const clarifications: Clarification[] = [];
    for (const draft of analysis.drafts) {
      const allowSupersede = categoryCounts.get(draft.category) === 1;
      const resolved = resolveOrCreate(clarificationStore, draftToClarificationInput(draft, candidate.projectId), candidate.projectId, allowSupersede);
      if (resolved) clarifications.push(resolved);
    }

    return { needsClarification: analysis.needsClarification, clarifications };
  };

  return { tool, handler };
}
