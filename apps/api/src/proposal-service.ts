import {
  generateProposal,
  type GenerateProposalOptions,
  type ModelProvider,
  type ProposalGenerationResult,
  type ToolRegistry
} from "@naqsh/core";
import type { Plan } from "@naqsh/schemas";

/**
 * The application/API-surface seam Phase 10 requires — mirroring
 * `plan-service.ts` (P9) and `observation-service.ts` (P8) exactly.
 * Deliberately NOT an HTTP server, for the same reason neither of those
 * is one. What this file IS: the exact function a future HTTP handler
 * (`POST /plans/:id/steps/:stepId/proposals`, or similar) would call
 * directly, already typed against `@naqsh/core`'s real proposal API.
 *
 * A thin, literal pass-through — all actual behavior (structured-output
 * validation, semantic validation, tool cross-checking) stays exactly
 * where P10 put it: `packages/core/src/proposal-generator.ts`/
 * `proposal-semantics.ts`. Generating a proposal through this seam is
 * EXACTLY as non-executing as calling `generateProposal` directly — this
 * file adds no state, no caching, no implicit persistence, and — like
 * every other P10 file — no path to `executeTool`/`invokeRegisteredTool`.
 */
export function generatePlanStepProposal(
  registry: ToolRegistry,
  provider: ModelProvider,
  plan: Plan,
  planStepId: string,
  options: GenerateProposalOptions
): Promise<ProposalGenerationResult> {
  return generateProposal(provider, registry, plan, planStepId, options);
}
