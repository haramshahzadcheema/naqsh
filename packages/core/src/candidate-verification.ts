import type { BuildOperation, Check, CheckInput, VerificationResult } from "@naqsh/schemas";
import { executeTool } from "./execute-tool.js";
import type { VerifyCandidateContext } from "./background-job-runner.js";

/**
 * P25's `verifyCandidate` hook, filled in for real (see `background-job-
 * runner.ts`'s own doc comment: "omitted entirely means this job never
 * verifies its candidates"). Turns a candidate's already-completed
 * `BuildResult` into real `Check`/`VerificationResult` records, through the
 * SAME `create_check` -> `run_verification` tool sequence
 * `verifyExecutedProposal` (apps/api/engineeringWorkflow.ts) already uses
 * for a single proposal -- generalized here to a candidate's whole set of
 * succeeded `BuildOperation`s instead of one proposal's one property write.
 *
 * Deliberately reads ONLY `context.buildResult.operations` -- never
 * re-fetches the originating `DesignSpecification` -- so this checks
 * exactly what was ACTUALLY built (each operation's own recorded `input`/
 * `output`), not what was merely intended. A `create_environment_object`
 * operation's `output.object.id` (the real, adapter-assigned id) is used
 * as the check target; a `modify_environment_object` operation already
 * names its target `objectId` directly. `"skipped"`/`"failed"` operations
 * produce no checks (there is nothing real to verify from an operation
 * that never ran or never succeeded).
 *
 * One check per property, mirroring `verifyExecutedProposal`'s own
 * numeric-vs-property_required branch: a numeric property gets an exact
 * `numeric_comparison` (does the built object actually hold the value the
 * candidate's design specified?); anything else gets `property_required`
 * (is it set at all?). This never claims a candidate satisfies an
 * engineering REQUIREMENT -- it only proves "the build did what it says it
 * did," the same honest, narrow claim P20's `build-executor.ts` already
 * limits itself to. A caller wanting requirement-level satisfaction
 * composes this with `evaluate_objective_satisfaction` separately, exactly
 * like `verifyExecutedProposal` does.
 *
 * A single check that fails to create/run (tool error) is silently
 * skipped rather than aborting the whole candidate -- matches
 * `runBackgroundJob`'s own "failure is data, the loop continues" policy at
 * the candidate level, applied here at the per-property level so one
 * malformed operation can't blank out every other real result.
 */
export async function verifyCandidateBuild(context: VerifyCandidateContext): Promise<{ id: string }[]> {
  const results: { id: string }[] = [];

  for (const operation of context.buildResult.operations) {
    if (operation.status !== "succeeded") continue;

    for (const propertyCheck of extractPropertyChecks(operation)) {
      const checkInput = buildCheckInput(propertyCheck.objectId, propertyCheck.propertyKey, propertyCheck.value);

      const { result: checkExec } = await executeTool(context.registry, {
        toolName: "create_check",
        input: checkInput,
        source: context.source,
        target: null,
        authorize: context.authorize
      });
      if (checkExec.status !== "success") continue;
      const check = (checkExec.output as { check: Check }).check;

      const { result: verifyExec } = await executeTool(context.registry, {
        toolName: "run_verification",
        input: { checkId: check.id },
        source: context.source,
        target: null,
        authorize: context.authorize
      });
      if (verifyExec.status !== "success") continue;
      const verificationResult = (verifyExec.output as { result: VerificationResult }).result;
      results.push({ id: verificationResult.id });
    }
  }

  return results;
}

interface PropertyCheckTarget {
  objectId: string;
  propertyKey: string;
  value: unknown;
}

function extractPropertyChecks(operation: BuildOperation): PropertyCheckTarget[] {
  if (operation.toolName === "modify_environment_object") {
    const input = operation.input as { objectId?: unknown; propertyKey?: unknown; value?: unknown };
    if (typeof input.objectId !== "string" || typeof input.propertyKey !== "string") return [];
    return [{ objectId: input.objectId, propertyKey: input.propertyKey, value: input.value }];
  }

  if (operation.toolName === "create_environment_object") {
    const output = operation.output as { object?: { id?: unknown } } | null;
    const objectId = output && typeof output.object === "object" && output.object !== null && typeof output.object.id === "string" ? output.object.id : null;
    if (!objectId) return [];
    const input = operation.input as { properties?: Record<string, unknown> };
    return Object.entries(input.properties ?? {}).map(([propertyKey, value]) => ({ objectId, propertyKey, value }));
  }

  return [];
}

function buildCheckInput(objectId: string, propertyKey: string, value: unknown): CheckInput {
  if (typeof value === "number") {
    return {
      kind: "numeric_comparison",
      description: `${propertyKey} equals the value this candidate's build set, after execution`,
      objectId,
      property: propertyKey,
      operator: "eq",
      expectedValue: value,
      expectedUnit: null,
      tolerance: 0.001
    };
  }
  return {
    kind: "property_required",
    description: `${propertyKey} is set after execution`,
    objectId,
    property: propertyKey,
    requireNonNull: true
  };
}
