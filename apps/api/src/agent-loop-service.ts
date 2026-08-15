import {
  beginAgentLoopRun,
  resumeAgentLoopRunAfterApproval,
  type AgentLoopRunResult,
  type BeginAgentLoopRunInput,
  type ResumeAgentLoopRunInput
} from "@naqsh/core";

/**
 * The application/API-surface seam Phase 11 requires -- mirroring
 * `proposal-service.ts` (P10), `plan-service.ts` (P9), and
 * `observation-service.ts` (P8) exactly. Deliberately NOT an HTTP server,
 * for the same reason none of those are one: this is the exact pair of
 * functions a future HTTP handler (`POST /agent-loop/runs`,
 * `POST /agent-loop/runs/:id/resume`, or similar) would call directly,
 * already typed against `@naqsh/core`'s real agent-loop API.
 *
 * A thin, literal pass-through -- all actual behavior (observation,
 * reasoning, proposal generation, approval-gated execution, post-execution
 * observation, discrepancy detection) stays exactly where P11 put it:
 * `packages/core/src/agent-loop.ts`. This file adds no state, no caching,
 * no implicit persistence -- both entry points are exactly as safe/unsafe
 * as calling `beginAgentLoopRun`/`resumeAgentLoopRunAfterApproval` directly.
 */
export function startAgentLoopRun(input: BeginAgentLoopRunInput): Promise<AgentLoopRunResult> {
  return beginAgentLoopRun(input);
}

export function continueAgentLoopRun(input: ResumeAgentLoopRunInput): Promise<AgentLoopRunResult> {
  return resumeAgentLoopRunAfterApproval(input);
}
