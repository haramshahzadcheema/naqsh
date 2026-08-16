import { interpretRequirementFromText, type InterpretRequirementOptions, type ModelProvider, type RequirementInterpretationResult } from "@naqsh/core";
import type { WorldModelState } from "@naqsh/schemas";

/**
 * The application/API-surface seam Phase 18 requires — mirroring
 * `proposal-service.ts` (P10) and `plan-service.ts` (P9) exactly. Deliberately
 * NOT an HTTP server, for the same reason neither of those is one. What
 * this file IS: the exact function a future HTTP handler
 * (`POST /projects/:id/requirements/interpret`, or similar) would call
 * directly, already typed against `@naqsh/core`'s real interpretation API.
 *
 * A thin, literal pass-through — all actual behavior (structured-output
 * validation, ambiguity handling, candidate construction) stays exactly
 * where P18 put it: `packages/core/src/requirement-interpreter.ts`. This
 * file adds no state, no caching, no implicit persistence, and no path to
 * `executeTool`/`invokeRegisteredTool` -- it can no more mutate the World
 * Model than calling `interpretRequirementFromText` directly can.
 *
 * There is deliberately NO `acceptRequirement`/`addRequirement` wrapper
 * here: turning an accepted candidate into a real `Requirement` happens
 * through `add_requirement` (a registered, `mutation: "mutate"` tool),
 * which already has a generic, approval-gated execution surface via
 * `agent-loop-service.ts` (P11) -- a mutating tool does not get its own
 * bespoke API seam just because this phase introduced it.
 */
export function interpretUserRequirement(
  provider: ModelProvider,
  state: WorldModelState,
  statementText: string,
  options: InterpretRequirementOptions
): Promise<RequirementInterpretationResult> {
  return interpretRequirementFromText(provider, state, statementText, options);
}
