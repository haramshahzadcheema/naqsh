import { createBuildOperation, createBuildResult, type BuildOperation, type BuildResult, type ChangeTarget, type DesignSpecification, type EntitySource } from "@naqsh/schemas";
import type { ToolRegistry } from "./tool-registry.js";
import { executeTool, type ToolAuthorizationContext, type ToolAuthorizationOutcome } from "./execute-tool.js";
import { planBuildOperations } from "./build-operations.js";
import type { BuildResultStore } from "./build-result-store.js";

/**
 * `DesignSpecification` -> bounded, real environment mutations, through the
 * EXISTING P3/P4 boundary -- never a new execution mechanism (P20 brief
 * Step 11's own explicit requirement). Mirrors `agent-loop.ts`'s (P11)
 * architecture, not a registered `Tool` itself: an ORCHESTRATOR that calls
 * `executeTool` once per planned operation, with the SAME `authorize` hook
 * a caller would give any other `executeTool` call -- P4 is never
 * bypassed, and this file introduces no second permission system (Step 16).
 *
 * BUILD SUCCESS != VERIFICATION (Step 14's own central distinction): this
 * function ONLY ever claims "the requested operation(s) executed
 * successfully" (`BuildResult.buildSuccess`/`.status`). It never runs a
 * `Check` (P16), never computes objective satisfaction (P17), and never
 * claims either. A caller who wants to know whether the built object
 * actually satisfies an engineering requirement must separately call
 * `create_check`/`run_verification`/`evaluate_objective_satisfaction` --
 * unchanged, unautomated by this file.
 *
 * FAILS SAFELY: operations run in `planBuildOperations`'s array order;
 * the FIRST failure stops the build -- every subsequent operation is
 * recorded as `"skipped"` (never attempted, never silently treated as
 * succeeded), and the aggregate `status` becomes `"failed"`. Every
 * operation that DID succeed before the failure keeps its own real
 * result, never discarded (Step 20's "never silently continue after a
 * critical build failure" + "the system must fail explicitly").
 */

/** An empty `expectedOutputs` list (a `DesignSpecification` that names no
 * concrete output) can never be reported `"completed"` -- mirrors P17's
 * identical `EMPTY_CONDITIONS_REASON` safety default: "nothing was built"
 * is not success, it is exactly the silent-success failure mode this
 * phase exists to prevent. */
export const EMPTY_BUILD_REASON = "DesignSpecification has no expectedOutputs -- there is nothing to build, which is never reported as a successful build.";

export interface ExecuteBuildOptions {
  source?: EntitySource;
  target?: ChangeTarget | null;
  authorize?: (context: ToolAuthorizationContext) => ToolAuthorizationOutcome | Promise<ToolAuthorizationOutcome>;
}

export async function executeBuildForDesignSpecification(
  registry: ToolRegistry,
  design: DesignSpecification,
  buildResultStore: BuildResultStore,
  options: ExecuteBuildOptions = {}
): Promise<BuildResult> {
  const startedAt = new Date().toISOString();
  const plannedOperations = planBuildOperations(design);

  if (plannedOperations.length === 0) {
    const result = createBuildResult({
      projectId: design.projectId,
      projectVersion: design.projectVersion,
      designSpecificationId: design.id,
      status: "failed",
      operations: [],
      startedAt,
      completedAt: new Date().toISOString(),
      source: options.source ?? "agent",
      metadata: { reason: EMPTY_BUILD_REASON }
    });
    buildResultStore.save(result);
    return result;
  }

  const operations: BuildOperation[] = [];
  let hasFailed = false;

  for (const planned of plannedOperations) {
    if (hasFailed) {
      operations.push(createBuildOperation({ ...planned, status: "skipped" }));
      continue;
    }

    const { result: toolResult } = await executeTool(registry, {
      toolName: planned.toolName,
      input: planned.input,
      source: options.source ?? "agent",
      target: options.target ?? { entityType: "object", entityId: null },
      authorize: options.authorize
    });

    if (toolResult.status === "success") {
      operations.push(createBuildOperation({ ...planned, status: "succeeded", output: toolResult.output }));
    } else {
      operations.push(
        createBuildOperation({
          ...planned,
          status: "failed",
          error: { kind: toolResult.error?.kind ?? "execution_failure", message: toolResult.error?.message ?? "build operation failed" }
        })
      );
      hasFailed = true;
    }
  }

  const result = createBuildResult({
    projectId: design.projectId,
    projectVersion: design.projectVersion,
    designSpecificationId: design.id,
    status: hasFailed ? "failed" : "completed",
    operations,
    startedAt,
    completedAt: new Date().toISOString(),
    source: options.source ?? "agent"
  });
  buildResultStore.save(result);
  return result;
}
