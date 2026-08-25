import type { Approval, Plan, Proposal } from "@naqsh/schemas";
import type { GeneratedCandidate, WorkflowFailure } from "./engineeringWorkflow.js";

/**
 * Part 13: typed events the chat endpoint can embed alongside its normal
 * conversational reply, so the frontend renders a real Planning/Proposal
 * card instead of dumping raw internal objects into the message text.
 */
export type ChatWorkflowEvent =
  | { kind: "plan_created"; plan: Plan }
  | { kind: "proposal_created"; proposal: Proposal; approvalId: string }
  | {
      kind: "exploration_prepared";
      planId: string;
      planStepId: string;
      candidates: GeneratedCandidate[];
      failures: WorkflowFailure[];
      pendingApprovals: Approval[];
      allowedTools: string[];
    }
  | { kind: "workflow_failed"; stage: "planning" | "proposal" | "exploration"; message: string };

/** A simple, honest, deterministic trigger -- not an LLM intent
 * classifier. Recognizing "design this" as design intent is exactly the
 * same class of pattern-matching this codebase already uses for
 * extraction (`onboarding/extraction.ts` on the frontend); everything the
 * trigger *causes* (planning, proposal generation) is 100% real backend/
 * Gemini work, never fabricated.
 *
 * AUDIT FIX: a real multi-turn conversation was traced end-to-end (a user
 * answering several requirement-clarification questions, then closing
 * with "just make the best choices and generate") and NONE of it ever
 * matched this pattern -- every reply fell through to plain chat, so
 * Gemini narrated elaborate-sounding "I will submit these to the
 * workspace" prose without the real Plan/Proposal pipeline ever running.
 * Added the "generate"-based closing phrases a user naturally reaches
 * for once they're done answering questions and just want the design
 * produced -- verified against that same real transcript, plus every
 * pre-existing phrase (all still match) and non-trigger text like "no"/
 * "decide whatever is best" (still correctly does not match). */
const DESIGN_INTENT_PATTERN =
  /\b(design (it|this)|prepare a (design )?proposal|create a proposal|plan (it|this)|propose a change|generate (it|this|the design)|go ahead and generate|just generate|make the best choices? and generate)\b/i;

export function hasDesignIntent(text: string): boolean {
  return DESIGN_INTENT_PATTERN.test(text);
}

/** Section 5's example phrases, matched the same deterministic way
 * DESIGN_INTENT_PATTERN is -- never an LLM classifying its own trigger.
 * "make it lighter"/"optimize this" are real engineering requests that
 * only make sense as MULTI-candidate exploration (there is no single
 * "correct" lighter design without comparing tradeoffs), so this pattern
 * is deliberately checked BEFORE hasDesignIntent in chatWorkflow.ts --
 * neither pattern matches the other's phrases today, but exploration is
 * the more specific ask when both could plausibly apply.
 *
 * AUDIT FIX: the original version of this pattern only recognized "make
 * IT/THIS lighter" -- a real user naming the actual part ("make the
 * bracket lighter", "can you make the mount stronger") never matched at
 * all, nor did other completely natural engineering phrasings ("reduce
 * the thickness", "strengthen this bracket", "change the mounting
 * geometry", "prepare this for manufacturing"). OBJECT_REF generalizes
 * "it"/"this"/"that" to also accept "the <noun phrase>" (up to three
 * words), and five more clause shapes cover the property-change/DFM
 * phrasings a real engineer actually uses. Still 100% deterministic
 * regex, zero extra model calls or latency -- verified against every
 * pre-existing positive example (all still match) plus the new phrasings
 * (workflowEvents.test.ts). */
const OBJECT_REF = "(?:it|this|that|the \\w+(?:\\s\\w+){0,2})";
const EXPLORATION_INTENT_PATTERN = new RegExp(
  "\\b(" +
    "try (several|multiple|a few|different) (alternatives|approaches|options|designs)" +
    "|explore (alternatives|options|other designs)" +
    `|make ${OBJECT_REF} (lighter|stronger|cheaper|smaller|faster|thinner|thicker)` +
    `|optimi[sz]e ${OBJECT_REF}` +
    "|find a better design" +
    "|(give|show) me (?:\\w+\\s+){0,2}(alternatives|approaches|options|designs)" +
    "|(reduce|increase|decrease|lower|raise|cut|improve) the (thickness|weight|mass|size|cost|strength)" +
    `|(strengthen|reinforce|lighten|thin out|thin) ${OBJECT_REF}` +
    "|(change|modify|adjust|update) the (mounting( geometry)?|geometry|shape|dimensions)" +
    `|prepare ${OBJECT_REF} for manufacturing|make ${OBJECT_REF} manufacturable` +
    ")\\b",
  "i"
);

export function hasExplorationIntent(text: string): boolean {
  return EXPLORATION_INTENT_PATTERN.test(text);
}

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };

/** The number of candidates requested, honestly bounded (never a runaway
 * "give me 500 alternatives" triggering 500 real Gemini calls) --
 * defaults to 3 when the text names no number, matching the same
 * "reasonable default, not zero, not unbounded" convention `POST
 * /plans/:planId/candidates`'s own `count` handling already uses
 * (server.ts). */
const DEFAULT_EXPLORATION_COUNT = 3;
export const MAX_EXPLORATION_COUNT = 6;

export function parseExplorationCount(text: string): number {
  const digitMatch = /\b(\d+)\s*(alternatives|approaches|options|designs|candidates|variations)\b/i.exec(text);
  if (digitMatch) return Math.min(Math.max(Number(digitMatch[1]), 1), MAX_EXPLORATION_COUNT);

  const wordMatch = /\b(one|two|three|four|five|six|seven|eight)\s*(alternatives|approaches|options|designs|candidates|variations)\b/i.exec(text);
  if (wordMatch) return Math.min(NUMBER_WORDS[wordMatch[1]!.toLowerCase()]!, MAX_EXPLORATION_COUNT);

  return DEFAULT_EXPLORATION_COUNT;
}
