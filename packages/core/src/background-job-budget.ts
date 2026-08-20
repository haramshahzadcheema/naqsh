import { createJobBudgetConsumption, type JobBudget, type JobBudgetConsumption, type JobStopReason } from "@naqsh/schemas";

/**
 * P25's central budget-enforcement machinery. Every dimension of
 * `JobBudget` (schemas) is checked HERE, in one place, before every
 * bounded operation `background-job-runner.ts` performs -- never left for
 * an individual step to remember to check its own limit (the brief's own
 * explicit "The budget must be enforced centrally").
 */

/**
 * A MONOTONIC clock -- the brief's own explicit "Do not rely solely on
 * wall-clock timestamps for elapsed duration." `createSystemClock`'s
 * `now()` is `performance.now()` (immune to system-clock adjustments,
 * NTP corrections, or DST changes mid-run); `createFakeClock` gives tests
 * a deterministic, manually-advanced clock so time-limit enforcement is
 * testable without a real `setTimeout`/sleep.
 */
export interface Clock {
  /** Monotonic milliseconds -- meaningful only as a DIFFERENCE between two
   * calls, never as an absolute wall-clock time. */
  now(): number;
}

export function createSystemClock(): Clock {
  return { now: () => performance.now() };
}

export interface FakeClock extends Clock {
  /** Test-only: advances the fake clock by exactly `ms`, deterministically
   * -- no real waiting, no flakiness. */
  advance(ms: number): void;
}

export function createFakeClock(startAt = 0): FakeClock {
  let current = startAt;
  return {
    now: () => current,
    advance(ms) {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new Error("FakeClock.advance requires a non-negative finite number of milliseconds");
      }
      current += ms;
    }
  };
}

/**
 * Deterministically reports WHICH budget dimension is exhausted, or `null`
 * if none is. Checked against `>=`, not `>` -- a consumption value equal to
 * its cap means the cap has been fully used and no further bounded
 * operation may proceed.
 *
 * Checking order is fixed and documented (never randomized, never
 * depends on object/Map iteration order) so that when MULTIPLE dimensions
 * are simultaneously exhausted, the SAME `JobStopReason` is always
 * reported for the same budget+consumption pair:
 *   1. `maxCandidates`  -- "have we attempted every candidate the job was
 *      scoped to" is the most specific, most immediately actionable
 *      signal (the job's own declared scope is complete).
 *   2. `maxIterations`  -- the general loop-step bound (in this phase's
 *      runner, one iteration per candidate attempt; kept as a SEPARATE
 *      dimension from `maxCandidates` because a future retry-aware runner
 *      could consume an iteration without evaluating a NEW candidate).
 *   3. `maxDurationMs`  -- wall-clock (monotonic) budget.
 *   4. `maxToolCalls`   -- every real `executeTool` call the job's
 *      wrapped `authorize` observed.
 *   5. `maxModelCalls`  -- accounted for by any caller-supplied extension
 *      hook that reports its own model usage.
 */
export function checkBudgetExhausted(budget: JobBudget, consumption: JobBudgetConsumption): JobStopReason | null {
  if (consumption.candidatesEvaluated >= budget.maxCandidates) return "candidate_limit_reached";
  if (consumption.iterationsUsed >= budget.maxIterations) return "iteration_limit_reached";
  if (consumption.durationMsUsed >= budget.maxDurationMs) return "time_limit_reached";
  if (consumption.toolCallsUsed >= budget.maxToolCalls) return "tool_call_limit_reached";
  if (consumption.modelCallsUsed >= budget.maxModelCalls) return "model_call_limit_reached";
  return null;
}

/** Every accounting helper is PURE -- takes a consumption snapshot, returns
 * a new one, never mutates its input (consumption objects are frozen by
 * `createJobBudgetConsumption` anyway, so mutation would throw). Consumption
 * only ever grows; there is no "release"/decrement operation, matching the
 * brief's own "never decremented, never reset mid-run" semantics. */
export function accountIteration(consumption: JobBudgetConsumption): JobBudgetConsumption {
  return createJobBudgetConsumption({ ...consumption, iterationsUsed: consumption.iterationsUsed + 1 });
}

export function accountCandidateEvaluated(consumption: JobBudgetConsumption): JobBudgetConsumption {
  return createJobBudgetConsumption({ ...consumption, candidatesEvaluated: consumption.candidatesEvaluated + 1 });
}

export function accountToolCall(consumption: JobBudgetConsumption): JobBudgetConsumption {
  return createJobBudgetConsumption({ ...consumption, toolCallsUsed: consumption.toolCallsUsed + 1 });
}

export function accountModelCall(consumption: JobBudgetConsumption): JobBudgetConsumption {
  return createJobBudgetConsumption({ ...consumption, modelCallsUsed: consumption.modelCallsUsed + 1 });
}

/** Duration is a recomputed TOTAL (elapsed monotonic ms since the run
 * started), never an incremental add -- unlike the counters above, which
 * genuinely accumulate one discrete event at a time. */
export function accountDuration(consumption: JobBudgetConsumption, elapsedMs: number): JobBudgetConsumption {
  return createJobBudgetConsumption({ ...consumption, durationMsUsed: Math.max(0, Math.round(elapsedMs)) });
}
