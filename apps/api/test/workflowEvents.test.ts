import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasDesignIntent, hasExplorationIntent, MAX_EXPLORATION_COUNT, parseExplorationCount } from "../src/workflowEvents.js";

describe("hasExplorationIntent: Section 5's example phrases, deterministically matched", () => {
  const positiveExamples = [
    "Can you try several alternatives for this bracket?",
    "Please try multiple approaches here.",
    "Explore alternatives for the mounting plate.",
    "Explore other designs for this part.",
    "Make it lighter.",
    "Make it stronger please.",
    "Can we make it cheaper?",
    "Optimize this for me.",
    "Please optimize it.",
    "Find a better design for the bracket.",
    "Give me three alternatives.",
    "Show me some options.",
    "Give me a few approaches."
  ];

  for (const text of positiveExamples) {
    it(`matches: "${text}"`, () => {
      assert.equal(hasExplorationIntent(text), true);
    });
  }

  it("does not match ordinary conversational text", () => {
    assert.equal(hasExplorationIntent("What's the current mass of the bracket?"), false);
    assert.equal(hasExplorationIntent("Thanks, that looks good."), false);
  });

  // AUDIT FIX: the original pattern only recognized "make IT/THIS
  // lighter" -- a user naming the actual part, or any of these other
  // completely natural engineering phrasings, never matched at all. This
  // is the "magic phrase" problem: a real engineer does not talk like a
  // command parser.
  const naturalLanguageVariations = [
    "make this lighter",
    "make the bracket lighter",
    "can you make the mount stronger",
    "make the bracket thinner",
    "reduce the thickness",
    "reduce the thickness of the bracket",
    "increase the strength",
    "cut the cost",
    "strengthen this bracket",
    "reinforce it",
    "lighten the mounting plate",
    "change the mounting geometry",
    "modify the geometry",
    "adjust the shape",
    "prepare this for manufacturing",
    "prepare the bracket for manufacturing",
    "make it manufacturable"
  ];

  for (const text of naturalLanguageVariations) {
    it(`matches (natural language, no magic phrase): "${text}"`, () => {
      assert.equal(hasExplorationIntent(text), true);
    });
  }

  it("still does not false-positive on unrelated uses of the same verbs", () => {
    assert.equal(hasExplorationIntent("Change my mind about the color."), false);
    assert.equal(hasExplorationIntent("I will prepare a summary for the meeting."), false);
  });

  it("does not overlap with hasDesignIntent's own phrases (each trigger owns disjoint language)", () => {
    const designPhrases = ["Design this for me.", "Prepare a design proposal.", "Create a proposal.", "Plan it.", "Propose a change."];
    for (const phrase of designPhrases) {
      assert.equal(hasExplorationIntent(phrase), false, `"${phrase}" should only match hasDesignIntent`);
      assert.equal(hasDesignIntent(phrase), true);
    }
    const explorationPhrases = ["Make it lighter.", "Explore alternatives.", "Optimize this."];
    for (const phrase of explorationPhrases) {
      assert.equal(hasDesignIntent(phrase), false, `"${phrase}" should only match hasExplorationIntent`);
      assert.equal(hasExplorationIntent(phrase), true);
    }
  });
});

describe("hasDesignIntent: 'generate'-based closing phrases (AUDIT FIX)", () => {
  // Traced from a REAL multi-turn conversation: a user answers several
  // requirement-clarification questions, then closes with "just make the
  // best choices and generate" -- and under the ORIGINAL pattern, none of
  // it (including that closing line) ever matched, so the real Plan/
  // Proposal pipeline never ran even once across the whole conversation.
  const closingPhrases = [
    "just make the best choices and generate",
    "make the best choice and generate",
    "generate it",
    "generate the design",
    "go ahead and generate",
    "just generate"
  ];

  for (const text of closingPhrases) {
    it(`matches: "${text}"`, () => {
      assert.equal(hasDesignIntent(text), true);
    });
  }

  it("does not false-positive on unrelated uses of 'generate' or on non-committal replies", () => {
    assert.equal(hasDesignIntent("please don't generate anything yet"), false);
    assert.equal(hasDesignIntent("no"), false);
    assert.equal(hasDesignIntent("decide whatever is best"), false);
    assert.equal(hasDesignIntent("proceed with capturing these as the official project requirements"), false);
  });

  // AUDIT FIX (round 2): the SAME real conversation this describe block is
  // named after continued past "make the best choices and generate" --
  // the user's VERY NEXT message was a bare "generate", with no object
  // after it, and it still fell through to plain chat under round 1's fix.
  it("matches a bare 'generate' with nothing after it", () => {
    assert.equal(hasDesignIntent("generate"), true);
    assert.equal(hasDesignIntent("Generate"), true);
    assert.equal(hasDesignIntent("Generate."), true);
  });

  it("a negated bare 'generate' is NOT read as the opposite of what it says", () => {
    assert.equal(hasDesignIntent("do not generate yet"), false);
    assert.equal(hasDesignIntent("never generate without approval"), false);
  });
});

describe("parseExplorationCount: honest, bounded, defaulted", () => {
  it("defaults to 3 when the text names no number", () => {
    assert.equal(parseExplorationCount("Make it lighter."), 3);
  });

  it("reads a digit count", () => {
    assert.equal(parseExplorationCount("Give me 5 alternatives."), 5);
    assert.equal(parseExplorationCount("Show me 2 designs."), 2);
  });

  it("reads a spelled-out number word", () => {
    assert.equal(parseExplorationCount("Give me three approaches."), 3);
    assert.equal(parseExplorationCount("Show me two options."), 2);
  });

  it("bounds an unreasonably large request to MAX_EXPLORATION_COUNT -- never a runaway batch of real Gemini calls", () => {
    assert.equal(parseExplorationCount("Give me 500 alternatives."), MAX_EXPLORATION_COUNT);
  });

  it("floors a request of zero or fewer at 1", () => {
    assert.equal(parseExplorationCount("Give me 0 alternatives."), 1);
  });
});
