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
