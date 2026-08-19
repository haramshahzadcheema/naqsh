import type { Candidate, Checkpoint, DesignSpecification, EntitySource, Experiment, ExperimentStatus, ChangeTarget } from "@naqsh/schemas";
import { ToolError } from "@naqsh/schemas";
import type { ToolRegistry } from "./tool-registry.js";
import { executeTool, type ToolAuthorizationContext, type ToolAuthorizationOutcome } from "./execute-tool.js";
import { executeBuildForDesignSpecification, type ExecuteBuildOptions } from "./build-executor.js";
import type { BuildResultStore } from "./build-result-store.js";
import type { BuildResult } from "@naqsh/schemas";

/**
 * Phase 22's EXECUTION half: `Candidate` -> real, bounded environment
 * mutations, through the EXACT SAME `executeTool`/`authorize` boundary
 * every other tool call goes through -- no bypass path, matching the P22
 * brief's own explicit requirement. Mirrors `executeBuildForDesignSpecification`
 * (P20)'s own shape exactly: a plain ORCHESTRATING core function, never a
 * registered `Tool` itself, and -- like that function -- it takes ONLY a
 * `registry` for reaching the World Model/environment, never its own
 * `getState`/`setState`/`history`.
 *
 * AUDIT FIX: an earlier version of this file called `recordTransition`
 * DIRECTLY (with its own `getState`/`setState`/`history` parameters) to
 * record `add_experiment`/`update_experiment` -- which meant those two
 * writes completely skipped the `authorize` hook, unlike every other
 * WorldModelState-touching step in this same function. That is precisely
 * the "P22 shortcut mutates state directly, skipping the Tool boundary"
 * failure mode the P22 audit explicitly calls out, and it also meant a
 * caller who wired mismatched `getState`/`setState`/`history` instances
 * here versus what the registry's OWN `create_checkpoint`/`restore_checkpoint`
 * tools close over could silently diverge into two different ChangeHistory
 * views of the same project -- `agent-loop.ts`'s own doc comment already
 * establishes the fix for this exact landmine ("there is no setState here
 * ... the handler, through its own recordTransition call and its own
 * getState/setState closure"). The fix: `add-experiment-tool.ts` and
 * `update-experiment-tool.ts` (both new, `mutation: "mutate"`, closing a
 * gap that existed since P1 -- `add_experiment` had a registered
 * `WorldModelTransition` but no `Tool` wrapper until now) now own that
 * writing, and this file calls them ONLY through `executeTool`, exactly
 * like every other step. This also directly satisfies the brief's own
 * "distinguish... proposing an experiment / approving an experiment /
 * executing an experiment" requirement: starting an experiment now
 * genuinely requires the same real P4 approval as any other World Model
 * mutation, and a model never gains extra permission merely because it is
 * running multiple candidates.
 *
 * ISOLATION (the P22 brief's central, adversarially-tested requirement):
 * this function creates a "before" `Checkpoint` by calling the EXISTING,
 * registered `create_checkpoint` TOOL (never a second checkpoint mechanism,
 * never a direct call into checkpoint-store.ts/artifact-store.ts) before
 * running anything, and records that checkpoint's id on the new
 * `Experiment.checkpointBeforeId`. This is what lets a caller PROVE
 * "Candidate B does not inherit Candidate A's mutations": run candidate A,
 * observe it fail/mutate the environment, call the EXISTING
 * `restore_checkpoint` tool with candidate A's `checkpointBeforeId` --
 * something this file deliberately does NOT do automatically -- then run
 * candidate B starting from a verified-clean baseline. Auto-restoring here
 * would hide exactly the isolation seam the brief requires tests to exercise
 * explicitly.
 *
 * BUILD SUCCESS != VERIFICATION, unchanged from P20: this function reports
 * only whether the candidate's design built successfully
 * (`BuildResult.status`), never whether it actually satisfies a requirement.
 * Running `create_check`/`run_verification`/`evaluate_objective_satisfaction`
 * against the result and recording their ids onto
 * `Experiment.verificationResultIds` is a SEPARATE, later step the caller
 * performs explicitly -- this file never invents its own notion of
 * "verified" or "optimal" (P22 brief: "Gemini may generate candidates but
 * may NOT declare them valid/verified/successful/optimal" applies equally
 * to this deterministic code).
 *
 * `Candidate` itself is never mutated: it is immutable once created (see
 * `candidate-store.ts`), and this file only ever READS it.
 */

export interface ExecuteExperimentForCandidateOptions {
  source?: EntitySource;
  target?: ChangeTarget | null;
  authorize?: (context: ToolAuthorizationContext) => ToolAuthorizationOutcome | Promise<ToolAuthorizationOutcome>;
  /** Passed through verbatim to the `create_checkpoint` tool call. Defaults
   * to a message naming the candidate, so a checkpoint list stays
   * self-explanatory without the caller having to supply one. */
  checkpointReason?: string;
}

export interface ExecuteExperimentForCandidateResult {
  experiment: Experiment;
  buildResult: BuildResult;
  checkpointBefore: Checkpoint;
}

function buildStatusToExperimentStatus(buildStatus: BuildResult["status"]): ExperimentStatus {
  return buildStatus === "completed" ? "complete" : "failed";
}

export async function executeExperimentForCandidate(
  registry: ToolRegistry,
  candidate: Candidate,
  design: DesignSpecification,
  buildResultStore: BuildResultStore,
  options: ExecuteExperimentForCandidateOptions = {}
): Promise<ExecuteExperimentForCandidateResult> {
  if (candidate.designSpecificationId !== design.id) {
    throw new ToolError(
      "invalid_input",
      `candidate_design_mismatch: candidate "${candidate.id}" names designSpecificationId "${candidate.designSpecificationId}", not the supplied design "${design.id}"`
    );
  }

  const source = options.source ?? "agent";

  // 1. Capture the isolation baseline -- through the real, registered tool,
  // never a direct checkpoint-store write.
  const checkpointReason = options.checkpointReason ?? `Before running experiment for candidate "${candidate.id}"`;
  const { result: checkpointResult } = await executeTool(registry, {
    toolName: "create_checkpoint",
    input: { reason: checkpointReason },
    source,
    authorize: options.authorize
  });
  if (checkpointResult.status !== "success") {
    throw new ToolError(
      "execution_failure",
      `checkpoint_before_failed: could not capture an isolation baseline before running candidate "${candidate.id}" -- ${checkpointResult.error?.message ?? "unknown error"}`
    );
  }
  const checkpointBefore = (checkpointResult.output as { checkpoint: Checkpoint }).checkpoint;

  // 2. Record the experiment as RUNNING, referencing the candidate and the
  // isolation baseline, before any build operation is attempted -- through
  // the registered add_experiment TOOL (mutate/world_model), the same
  // authorize gate every other World Model write goes through.
  const { result: addExperimentResult } = await executeTool(registry, {
    toolName: "add_experiment",
    input: {
      objective: design.objectiveSummary,
      hypothesis: candidate.hypothesis,
      candidateId: candidate.id,
      checkpointBeforeId: checkpointBefore.id,
      status: "running",
      provenance: source
    },
    source,
    target: { entityType: "experiment", entityId: null },
    authorize: options.authorize
  });
  if (addExperimentResult.status !== "success") {
    throw new ToolError(
      addExperimentResult.error?.kind ?? "execution_failure",
      `add_experiment_failed: could not record an experiment for candidate "${candidate.id}" -- ${addExperimentResult.error?.message ?? "unknown error"}`
    );
  }
  const experiment = (addExperimentResult.output as { experiment: Experiment }).experiment;

  // 3. Run the candidate's build through the EXISTING P20 executor -- the
  // exact same `executeTool`/`authorize` boundary, never a shortcut.
  const buildOptions: ExecuteBuildOptions = { source, target: options.target, authorize: options.authorize };
  const buildResult = await executeBuildForDesignSpecification(registry, design, buildResultStore, buildOptions);

  // 4. Update the experiment with the outcome -- through the registered
  // update_experiment TOOL, same authorize gate.
  const { result: updateExperimentResult } = await executeTool(registry, {
    toolName: "update_experiment",
    input: {
      experimentId: experiment.id,
      buildResultId: buildResult.id,
      status: buildStatusToExperimentStatus(buildResult.status),
      result: { buildStatus: buildResult.status },
      conclusion: buildResult.status === "completed" ? "Build completed successfully." : "Build failed -- see the linked BuildResult for details."
    },
    source,
    target: { entityType: "experiment", entityId: experiment.id },
    authorize: options.authorize
  });
  if (updateExperimentResult.status !== "success") {
    throw new ToolError(
      updateExperimentResult.error?.kind ?? "execution_failure",
      `update_experiment_failed: could not record the outcome for candidate "${candidate.id}"'s experiment "${experiment.id}" -- ${updateExperimentResult.error?.message ?? "unknown error"}`
    );
  }
  const updatedExperiment = (updateExperimentResult.output as { experiment: Experiment }).experiment;

  return { experiment: updatedExperiment, buildResult, checkpointBefore };
}
