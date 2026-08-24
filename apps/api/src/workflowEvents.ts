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
 * Gemini work, never fabricated. */
const DESIGN_INTENT_PATTERN = /\b(design (it|this)|prepare a (design )?proposal|create a proposal|plan (it|this)|propose a change)\b/i;

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
 * the more specific ask when both could plausibly apply. */
const EXPLORATION_INTENT_PATTERN =
  /\b(try (several|multiple|a few|different) (alternatives|approaches|options|designs)|explore (alternatives|options|other designs)|make it (lighter|stronger|cheaper|smaller|faster)|optimi[sz]e (it|this)|find a better design|(give|show) me (?:\w+\s+){0,2}(alternatives|approaches|options|designs))\b/i;

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
