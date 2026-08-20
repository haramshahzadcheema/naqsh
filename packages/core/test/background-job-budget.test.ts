import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJobBudgetConsumption, type JobBudget, type JobBudgetConsumption } from "@naqsh/schemas";
import {
  accountCandidateEvaluated,
  accountDuration,
  accountIteration,
  accountModelCall,
  accountToolCall,
  checkBudgetExhausted,
  createFakeClock,
  createSystemClock
} from "../src/background-job-budget.js";

function budget(overrides: Partial<JobBudget> = {}): JobBudget {
  return { maxIterations: 10, maxDurationMs: 10000, maxToolCalls: 10, maxModelCalls: 10, maxCandidates: 10, ...overrides };
}

describe("Clock", () => {
  it("createSystemClock reports non-decreasing values", () => {
    const clock = createSystemClock();
    const a = clock.now();
    const b = clock.now();
    assert.ok(b >= a);
  });

  it("FakeClock starts at the given value and only moves via advance()", () => {
    const clock = createFakeClock(100);
    assert.equal(clock.now(), 100);
    clock.advance(50);
    assert.equal(clock.now(), 150);
    assert.equal(clock.now(), 150, "reading now() again must not itself advance the clock");
  });

  it("FakeClock.advance rejects negative or non-finite deltas", () => {
    const clock = createFakeClock(0);
    assert.throws(() => clock.advance(-1));
    assert.throws(() => clock.advance(Number.NaN));
    assert.throws(() => clock.advance(Number.POSITIVE_INFINITY));
  });
});

describe("checkBudgetExhausted: each dimension individually", () => {
  it("returns null when nothing is exhausted", () => {
    assert.equal(checkBudgetExhausted(budget(), createJobBudgetConsumption()), null);
  });

  it("candidate_limit_reached", () => {
    assert.equal(checkBudgetExhausted(budget({ maxCandidates: 2 }), createJobBudgetConsumption({ candidatesEvaluated: 2 })), "candidate_limit_reached");
  });

  it("iteration_limit_reached", () => {
    assert.equal(checkBudgetExhausted(budget({ maxIterations: 3 }), createJobBudgetConsumption({ iterationsUsed: 3 })), "iteration_limit_reached");
  });

  it("time_limit_reached", () => {
    assert.equal(checkBudgetExhausted(budget({ maxDurationMs: 500 }), createJobBudgetConsumption({ durationMsUsed: 500 })), "time_limit_reached");
  });

  it("tool_call_limit_reached", () => {
    assert.equal(checkBudgetExhausted(budget({ maxToolCalls: 4 }), createJobBudgetConsumption({ toolCallsUsed: 4 })), "tool_call_limit_reached");
  });

  it("model_call_limit_reached", () => {
    assert.equal(checkBudgetExhausted(budget({ maxModelCalls: 1 }), createJobBudgetConsumption({ modelCallsUsed: 1 })), "model_call_limit_reached");
  });

  it("uses >= , not > -- exactly at the cap counts as exhausted, one below does not", () => {
    assert.equal(checkBudgetExhausted(budget({ maxCandidates: 5 }), createJobBudgetConsumption({ candidatesEvaluated: 4 })), null);
    assert.equal(checkBudgetExhausted(budget({ maxCandidates: 5 }), createJobBudgetConsumption({ candidatesEvaluated: 5 })), "candidate_limit_reached");
  });

  it("reports a DETERMINISTIC, fixed-order dimension when multiple are simultaneously exhausted", () => {
    const allExhausted: JobBudgetConsumption = createJobBudgetConsumption({
      candidatesEvaluated: 10,
      iterationsUsed: 10,
      durationMsUsed: 10000,
      toolCallsUsed: 10,
      modelCallsUsed: 10
    });
    // candidates is checked first, every time -- never a function of object
    // key order or which field happened to be written last.
    assert.equal(checkBudgetExhausted(budget(), allExhausted), "candidate_limit_reached");
    assert.equal(checkBudgetExhausted(budget(), allExhausted), "candidate_limit_reached");
  });
});

describe("accounting helpers: pure and immutable", () => {
  it("each helper returns a NEW object and never mutates its input", () => {
    const original = createJobBudgetConsumption();
    const afterIteration = accountIteration(original);
    assert.notEqual(afterIteration, original);
    assert.equal(original.iterationsUsed, 0);
    assert.equal(afterIteration.iterationsUsed, 1);
  });

  it("accountCandidateEvaluated/accountToolCall/accountModelCall each increment by exactly one", () => {
    let consumption = createJobBudgetConsumption();
    consumption = accountCandidateEvaluated(consumption);
    consumption = accountToolCall(consumption);
    consumption = accountToolCall(consumption);
    consumption = accountModelCall(consumption);
    assert.equal(consumption.candidatesEvaluated, 1);
    assert.equal(consumption.toolCallsUsed, 2);
    assert.equal(consumption.modelCallsUsed, 1);
  });

  it("accountDuration SETS a recomputed total rather than incrementing", () => {
    let consumption = createJobBudgetConsumption({ durationMsUsed: 999 });
    consumption = accountDuration(consumption, 50);
    assert.equal(consumption.durationMsUsed, 50);
  });

  it("accountDuration floors negative elapsed values at 0 and rounds fractional ms", () => {
    assert.equal(accountDuration(createJobBudgetConsumption(), -5).durationMsUsed, 0);
    assert.equal(accountDuration(createJobBudgetConsumption(), 12.6).durationMsUsed, 13);
  });

  it("returned consumption objects are frozen", () => {
    const consumption = accountIteration(createJobBudgetConsumption());
    assert.throws(() => {
      (consumption as { iterationsUsed: number }).iterationsUsed = 999;
    });
  });
});
