import { createTool, ENTITY_SOURCES, EXPERIMENT_STATUSES, ToolError, type EntitySource, type ExperimentStatus, type Tool, type ToolValueSchema, type WorldModelState } from "@naqsh/schemas";
import type { ChangeHistory } from "./change-history.js";
import { recordTransition } from "./record-transition.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * PRE-EXISTING GAP CLOSED BY P22: `add_experiment` has been a registered
 * `WorldModelTransition` since P1, but no `Tool` ever wrapped it -- nothing
 * in P1-P21 needed to record an experiment at RUNTIME (only tests called
 * `recordTransition({kind: "add_experiment", ...})` directly). P22's
 * `experiment-executor.ts` is the first PRODUCTION code that needs to
 * record one, and it originally did so by calling `recordTransition`
 * directly with its own `getState`/`setState`/`history` -- exactly the
 * "P22 shortcut mutates state directly, skipping the Tool/authorization
 * boundary" problem the P22 audit brief explicitly warns against. This tool
 * closes that gap the same way every other Project-array write already
 * works.
 *
 * Classified `mutation: "mutate"` (not "suggest") -- `Experiment` lives in
 * `Project.experiments`, exactly like `Requirement`/`Source`, NOT in its
 * own process store like `Check`/`Checkpoint`/`Candidate`. Every other
 * entity that lives in `Project` is gated `mutate` (`add_requirement`,
 * `add_source`); an `Experiment` is no exception merely because P22 is the
 * one that finally needs to create one. This also directly answers the
 * brief's AUDIT #7 ("distinguish... proposing an experiment / approving an
 * experiment / executing an experiment"): starting an experiment now
 * genuinely requires the same real approval any other World Model mutation
 * does -- a model never gains extra permission merely because it is
 * running multiple candidates.
 *
 * The World Model changes ONLY through the EXISTING `add_experiment`
 * `WorldModelTransition` (P1, unchanged) via `recordTransition` -- never a
 * direct array push onto `project.experiments`.
 */

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    objective: { type: "string", description: "What this experiment is trying to determine." },
    hypothesis: { type: "string", description: "What this experiment predicts/claims." },
    inputs: { type: "array", items: { type: "object", properties: {}, additionalProperties: true }, nullable: true },
    candidateId: { type: "string", nullable: true, description: "The Candidate (P22) this experiment tests, if any." },
    checkpointBeforeId: { type: "string", nullable: true, description: "The Checkpoint the environment was restored to (or already at) immediately before this experiment runs." },
    status: { type: "string", enum: EXPERIMENT_STATUSES as string[], nullable: true, description: 'Initial status. Defaults to "planned"; P22 candidate execution passes "running".' },
    provenance: { type: "string", nullable: true, description: "Who/what is recording this experiment -- one of EntitySource. Defaults to 'agent'." }
  },
  required: ["objective", "hypothesis"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: { experiment: { type: "object", properties: {}, additionalProperties: true } },
  required: ["experiment"]
};

interface AddExperimentToolInput {
  objective: string;
  hypothesis: string;
  inputs: unknown[];
  candidateId: string | null;
  checkpointBeforeId: string | null;
  status: ExperimentStatus | null;
  provenance: EntitySource | null;
}

function toAddExperimentToolInput(rawInput: unknown): AddExperimentToolInput {
  const record = rawInput as { objective?: unknown; hypothesis?: unknown; inputs?: unknown; candidateId?: unknown; checkpointBeforeId?: unknown; status?: unknown; provenance?: unknown };
  if (typeof record.objective !== "string" || record.objective.trim().length === 0) {
    throw new ToolError("invalid_input", "objective is required and must be a non-empty string");
  }
  if (typeof record.hypothesis !== "string" || record.hypothesis.trim().length === 0) {
    throw new ToolError("invalid_input", "hypothesis is required and must be a non-empty string");
  }
  if (record.status !== undefined && record.status !== null && !(EXPERIMENT_STATUSES as readonly string[]).includes(record.status as string)) {
    throw new ToolError("invalid_input", `status must be one of: ${EXPERIMENT_STATUSES.join(", ")}`);
  }
  if (record.provenance !== undefined && record.provenance !== null && !(ENTITY_SOURCES as readonly string[]).includes(record.provenance as string)) {
    throw new ToolError("invalid_input", `provenance must be one of: ${ENTITY_SOURCES.join(", ")}`);
  }
  return {
    objective: record.objective,
    hypothesis: record.hypothesis,
    inputs: Array.isArray(record.inputs) ? record.inputs : [],
    candidateId: typeof record.candidateId === "string" ? record.candidateId : null,
    checkpointBeforeId: typeof record.checkpointBeforeId === "string" ? record.checkpointBeforeId : null,
    status: typeof record.status === "string" ? (record.status as ExperimentStatus) : null,
    provenance: typeof record.provenance === "string" ? (record.provenance as EntitySource) : null
  };
}

export function createAddExperimentTool(getState: () => WorldModelState, setState: (next: WorldModelState) => void, history: ChangeHistory): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "add_experiment",
    description:
      "Records a new Experiment in the current project's World Model -- optionally referencing the Candidate (P22) it tests and the Checkpoint the environment was at immediately before it runs. This is a real mutation: it is recorded as an audited Change and requires approval like any other.",
    target: "world_model",
    mutation: "mutate",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = (rawInput) => {
    const input = toAddExperimentToolInput(rawInput);
    const state = getState();

    const experimentInput = {
      objective: input.objective,
      hypothesis: input.hypothesis,
      inputs: input.inputs,
      candidateId: input.candidateId,
      checkpointBeforeId: input.checkpointBeforeId,
      status: input.status ?? undefined,
      source: input.provenance ?? "agent"
    };

    const { state: nextState } = recordTransition(
      history,
      state,
      { kind: "add_experiment", experiment: experimentInput },
      { source: "agent", cause: { kind: "tool_execution", description: `add_experiment: "${input.objective}"` } }
    );
    setState(nextState);

    const added = nextState.project.experiments.at(-1);
    if (!added) {
      throw new ToolError("execution_failure", "experiment unexpectedly missing after being added");
    }
    return { experiment: added };
  };

  return { tool, handler };
}
