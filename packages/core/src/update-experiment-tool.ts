import { createTool, EXPERIMENT_STATUSES, ToolError, type ExperimentInput, type ExperimentStatus, type Tool, type ToolValueSchema, type WorldModelState } from "@naqsh/schemas";
import type { ChangeHistory } from "./change-history.js";
import { recordTransition } from "./record-transition.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * The other half of the gap `add-experiment-tool.ts` closes: `update_experiment`
 * (P22, new transition) had no `Tool` wrapper either. Classified `mutation:
 * "mutate"` for the identical reason `add_experiment` is -- `Experiment`
 * lives in `Project.experiments`.
 *
 * The patchable field set is DELIBERATELY narrower than `ExperimentInput`
 * (which is `Partial<Experiment>`, i.e. every field): only `status`,
 * `result`, `conclusion`, `buildResultId`, `verificationResultIds`, and
 * `checkpointAfterId` are exposed here. `id`/`objective`/`hypothesis`/
 * `candidateId`/`checkpointBeforeId`/`source`/`createdAt` are NOT
 * accepted -- an experiment's identity, what it originally set out to test,
 * which candidate it belongs to, its isolation baseline, who recorded it,
 * and when are established at CREATION time and must stay that way for the
 * traceability chain to mean anything; letting this tool patch them would
 * let a later call quietly rewrite which candidate an experiment "really"
 * tested. The rejected fields are never silently ignored if the caller
 * supplies them in `patch` -- `toUpdateExperimentInput` only ever reads the
 * allowlisted keys off the raw input, so anything else in the input object
 * has no effect and is not spread into the transition.
 *
 * Verifies `experimentId` resolves to a real experiment in the CURRENT
 * project before recording the transition (`experiment_not_found`) --
 * `update_experiment`'s own reducer silently no-ops on an unknown id
 * (matching `update_requirement`'s established, unmodified P1 behavior),
 * so this tool-level check is what turns a caller's mistake into a real
 * error instead of a silently-ignored no-op, the same "don't let a
 * mismatch dissolve into deceptive success" precedent `create-check-tool.ts`'s
 * `requirement_not_found` check already established.
 */

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    experimentId: { type: "string", description: "The Experiment to update." },
    status: { type: "string", enum: EXPERIMENT_STATUSES as string[], nullable: true },
    result: { type: "object", properties: {}, additionalProperties: true, nullable: true },
    conclusion: { type: "string", nullable: true },
    buildResultId: { type: "string", nullable: true },
    verificationResultIds: { type: "array", items: { type: "string" }, nullable: true },
    checkpointAfterId: { type: "string", nullable: true }
  },
  required: ["experimentId"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: { experiment: { type: "object", properties: {}, additionalProperties: true } },
  required: ["experiment"]
};

interface UpdateExperimentToolInput {
  experimentId: string;
  patch: ExperimentInput;
}

function toUpdateExperimentToolInput(rawInput: unknown): UpdateExperimentToolInput {
  const record = rawInput as {
    experimentId?: unknown;
    status?: unknown;
    result?: unknown;
    conclusion?: unknown;
    buildResultId?: unknown;
    verificationResultIds?: unknown;
    checkpointAfterId?: unknown;
  };
  if (typeof record.experimentId !== "string" || record.experimentId.trim().length === 0) {
    throw new ToolError("invalid_input", "experimentId is required and must be a non-empty string");
  }
  if (record.status !== undefined && record.status !== null && !(EXPERIMENT_STATUSES as readonly string[]).includes(record.status as string)) {
    throw new ToolError("invalid_input", `status must be one of: ${EXPERIMENT_STATUSES.join(", ")}`);
  }
  if (record.verificationResultIds !== undefined && record.verificationResultIds !== null) {
    if (!Array.isArray(record.verificationResultIds) || !record.verificationResultIds.every((id) => typeof id === "string")) {
      throw new ToolError("invalid_input", "verificationResultIds must be an array of strings when supplied");
    }
  }

  const patch: ExperimentInput = {};
  if (record.status !== undefined) patch.status = record.status as ExperimentStatus;
  if (record.result !== undefined) patch.result = record.result;
  if (record.conclusion !== undefined) patch.conclusion = record.conclusion as string | null;
  if (record.buildResultId !== undefined) patch.buildResultId = record.buildResultId as string | null;
  if (record.verificationResultIds !== undefined) patch.verificationResultIds = record.verificationResultIds as string[];
  if (record.checkpointAfterId !== undefined) patch.checkpointAfterId = record.checkpointAfterId as string | null;

  return { experimentId: record.experimentId, patch };
}

export function createUpdateExperimentTool(getState: () => WorldModelState, setState: (next: WorldModelState) => void, history: ChangeHistory): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "update_experiment",
    description:
      "Updates an EXISTING Experiment's outcome (status, result, conclusion, buildResultId, verificationResultIds, checkpointAfterId) -- never its identity, objective, hypothesis, candidateId, checkpointBeforeId, source, or createdAt. This is a real mutation: it is recorded as an audited Change and requires approval like any other.",
    target: "world_model",
    mutation: "mutate",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = (rawInput) => {
    const input = toUpdateExperimentToolInput(rawInput);
    const state = getState();

    if (!state.project.experiments.some((experiment) => experiment.id === input.experimentId)) {
      throw new ToolError("invalid_input", `experiment_not_found: no experiment "${input.experimentId}" exists in the current project`);
    }

    const { state: nextState } = recordTransition(
      history,
      state,
      { kind: "update_experiment", experimentId: input.experimentId, patch: input.patch },
      { source: "agent", cause: { kind: "tool_execution", description: `update_experiment: "${input.experimentId}"` } }
    );
    setState(nextState);

    const updated = nextState.project.experiments.find((experiment) => experiment.id === input.experimentId);
    if (!updated) {
      throw new ToolError("execution_failure", "experiment unexpectedly missing after being updated");
    }
    return { experiment: updated };
  };

  return { tool, handler };
}
