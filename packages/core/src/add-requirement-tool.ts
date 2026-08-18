import { assertRequirementCandidate, createTool, ToolError, WorldModelValidationError, type RequirementCandidate, type Tool, type ToolValueSchema, type WorldModelState } from "@naqsh/schemas";
import type { ChangeHistory } from "./change-history.js";
import { recordTransition } from "./record-transition.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * RequirementCandidate -> real, audited `Requirement` (P18's second new
 * tool). Mirrors `modify_object`'s (P11) exact shape and reasoning: this is
 * a real `mutation: "mutate"` tool, gated by the same P3/P4 approval
 * boundary every other World Model mutation goes through -- interpreting
 * text (`interpret_requirement`) never bypasses that boundary just because
 * "it's only text": a Requirement is engineering state, and adding one is
 * exactly as consequential as any other World Model write.
 *
 * REJECTS an `"ambiguous"` candidate outright (`ambiguous_candidate`) --
 * this is the deterministic backstop Phase 18 exists to guarantee: a
 * requirement never becomes authoritative merely because Gemini produced
 * something plausible-shaped. Resolving the ambiguity (a clarifying
 * question) is P19's job; this tool's only options for an ambiguous
 * candidate are "reject" or "reject," never "accept with an invented
 * value."
 *
 * REJECTS a candidate from a DIFFERENT project (`cross_project_forbidden`)
 * -- the same cross-project isolation check the P17 audit added to
 * `evaluateObjectiveSatisfaction` after finding the gap there, applied
 * proactively here from the start.
 *
 * The World Model changes ONLY through the EXISTING `add_requirement`
 * `WorldModelTransition` (P1/P2, unchanged) via `recordTransition` -- never
 * a direct array push onto `project.requirements`, never a second write path. The
 * candidate's `operator` (P16's `NumericComparisonOperator` vocabulary,
 * which `Requirement` itself has no dedicated field for) and the original
 * `statementText` are preserved in the accepted Requirement's `metadata`
 * -- the existing, already-JSON-validated extension mechanism every entity
 * already has -- rather than adding a new field to the already-audited P1
 * `Requirement` schema for a single phase's need. The candidate's OWN
 * `metadata` is spread in first (P19's `answer_clarification` stamps
 * `resolvedClarificationId`/`originalRequirementCandidateId`/
 * `originalStatementText` there) so a later phase's provenance is never
 * silently dropped on the floor just because THIS tool didn't know about
 * it -- P18's own three fields still take precedence on any key collision.
 *
 * DUPLICATE SUBMISSION is intentionally NOT deduplicated: accepting the
 * same candidate twice (or two candidates from the same statement) creates
 * two separate, independently audited `Requirement`s sharing the same
 * `requirementCandidateId` in metadata. No existing requirement is ever
 * overwritten, no id collides (`createRequirement` always mints a fresh
 * one), and no transition is skipped -- this tool simply has no concept of
 * "already added." A global deduplication/merge policy is deferred rather
 * than half-built here.
 */

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    candidate: {
      type: "object",
      properties: {},
      additionalProperties: true,
      description: "The RequirementCandidate (P18) to accept. Deep-validated by this tool's handler."
    }
  },
  required: ["candidate"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    description: { type: "string" },
    category: { type: "string" },
    value: { type: ["string", "number", "boolean"], nullable: true },
    unit: { type: "string", nullable: true },
    priority: { type: "string" },
    status: { type: "string" },
    source: { type: "string" },
    metadata: { type: "object", properties: {}, additionalProperties: true }
  },
  required: ["id", "description", "category", "value", "unit", "priority", "status", "source", "metadata"]
};

function toAddRequirementInput(input: unknown): RequirementCandidate {
  const record = input as { candidate?: unknown };
  try {
    assertRequirementCandidate(record.candidate);
  } catch (error) {
    if (error instanceof WorldModelValidationError) {
      throw new ToolError("invalid_input", `candidate is invalid: ${error.message}`);
    }
    throw error;
  }
  return record.candidate;
}

export function createAddRequirementTool(getState: () => WorldModelState, setState: (next: WorldModelState) => void, history: ChangeHistory): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "add_requirement",
    description:
      "Accepts a 'specific' RequirementCandidate (P18) and adds it to the current project's World Model as a real, audited Requirement. Rejects any candidate whose interpretationStatus is 'ambiguous' outright -- an underspecified natural-language statement never becomes an authoritative requirement through this tool. This is a real mutation: it is recorded as an audited Change and requires approval like any other.",
    target: "world_model",
    mutation: "mutate",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = (rawInput) => {
    const candidate = toAddRequirementInput(rawInput);
    const state = getState();

    if (candidate.projectId !== state.project.id) {
      throw new ToolError(
        "invalid_input",
        `cross_project_forbidden: Requirement candidate "${candidate.id}" belongs to project "${candidate.projectId}", not the current project "${state.project.id}"`
      );
    }
    if (candidate.interpretationStatus === "ambiguous") {
      throw new ToolError(
        "invalid_input",
        `ambiguous_candidate: Requirement candidate "${candidate.id}" is ambiguous (${candidate.ambiguityReason}) -- it cannot become an authoritative requirement without clarification`
      );
    }

    const { state: nextState } = recordTransition(
      history,
      state,
      {
        kind: "add_requirement",
        requirement: {
          description: candidate.description,
          category: candidate.category,
          value: candidate.value,
          unit: candidate.unit,
          priority: candidate.priority,
          source: candidate.source,
          metadata: {
            ...candidate.metadata,
            requirementCandidateId: candidate.id,
            statementText: candidate.statementText,
            operator: candidate.operator
          }
        }
      },
      {
        source: "agent",
        cause: { kind: "tool_execution", description: `add_requirement: from candidate "${candidate.id}" ("${candidate.statementText}")` }
      }
    );
    setState(nextState);

    const added = [...nextState.project.requirements].reverse().find((requirement) => requirement.metadata.requirementCandidateId === candidate.id);
    if (!added) {
      throw new ToolError("execution_failure", "requirement unexpectedly missing after being added");
    }
    return added;
  };

  return { tool, handler };
}
