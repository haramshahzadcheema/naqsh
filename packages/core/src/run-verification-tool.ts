import { createTool, ToolError, type EnvironmentObject, type EnvironmentSession, type Tool, type ToolValueSchema, type WorldModelState } from "@naqsh/schemas";
import type { CheckStore } from "./check-store.js";
import type { VerificationResultStore } from "./verification-result-store.js";
import type { EnvironmentAdapter } from "./environment-adapter.js";
import { buildEvidenceFromEnvironmentObject } from "./evidence.js";
import { evaluateCheck } from "./verify.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * Phase 16's EVALUATION half: locates a `Check`, observes the CURRENT
 * environment state through the existing `EnvironmentAdapter.inspectObject`
 * boundary (P5/P13 -- never a second, independent environment-access
 * path), builds `Evidence` from that observation, hands both to the PURE
 * `evaluateCheck` (verify.ts), and persists the resulting
 * `VerificationResult`.
 *
 * Classified `mutation: "verify"` -- the exact classification P3/P4
 * reserved for this purpose from the start (`ToolMutationKind` already
 * included `"verify"`, and `authorization.ts`'s `MINIMUM_LEVEL_FOR_
 * MUTATION` already grouped it with `"suggest"`, both since before this
 * phase existed). This tool never mutates the World Model, the
 * environment, or a checkpoint -- observing is read-only, and persisting a
 * NEW `VerificationResult` is exactly the same "writes an independent new
 * record" shape `create_checkpoint`/`create_check` already have.
 *
 * If no environment session is connected, or the observation genuinely
 * fails (not "object not found" -- a real `object_not_found` response IS
 * usable evidence, see evidence.ts), evidence is `null` and `evaluateCheck`
 * naturally reports `inconclusive`/`evidence_missing` -- no special-casing
 * needed here; the pure verifier already knows how to handle absent
 * evidence honestly.
 */

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    checkId: { type: "string", description: "The Check to evaluate." }
  },
  required: ["checkId"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    result: { type: "object", properties: {}, additionalProperties: true }
  },
  required: ["result"]
};

interface RunVerificationInput {
  checkId: string;
}

function toRunVerificationInput(input: unknown): RunVerificationInput {
  const record = input as { checkId?: unknown };
  if (typeof record.checkId !== "string" || record.checkId.trim().length === 0) {
    throw new ToolError("invalid_input", "checkId is required and must be a non-empty string");
  }
  return { checkId: record.checkId };
}

export function createRunVerificationTool(
  getState: () => WorldModelState,
  getSession: () => EnvironmentSession | null,
  adapter: EnvironmentAdapter,
  checkStore: CheckStore,
  verificationResultStore: VerificationResultStore
): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "run_verification",
    description:
      "Deterministically evaluates a previously defined Check against freshly observed evidence from the connected environment, producing PASS, FAIL, or INCONCLUSIVE -- never Gemini's judgment, never a tool's own reported success. Read-only against the World Model and the environment; persists a new, immutable VerificationResult.",
    target: "verification",
    mutation: "verify",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = async (rawInput) => {
    const input = toRunVerificationInput(rawInput);

    const check = checkStore.getById(input.checkId);
    if (!check) {
      throw new ToolError("invalid_input", `check_not_found: No check with id "${input.checkId}" exists`);
    }

    const state = getState();
    const session = getSession();

    let observedObject: EnvironmentObject | null = null;
    let observationFailed = false;
    if (session) {
      const inspectResult = await adapter.inspectObject(session, check.objectId);
      if (inspectResult.status === "success") {
        observedObject = inspectResult.data as EnvironmentObject;
      } else if (inspectResult.error?.kind === "object_not_found") {
        observedObject = null; // a definitive, usable "it doesn't exist"
      } else {
        observationFailed = true; // a genuine observation failure -- no usable evidence
      }
    }

    const property = "property" in check ? check.property : null;
    const evidence =
      session && !observationFailed
        ? buildEvidenceFromEnvironmentObject(check.objectId, property, observedObject, {
            stateVersion: state.project.version,
            environmentKind: session.environmentKind
          })
        : null;

    const result = evaluateCheck(check, evidence, {
      projectId: state.project.id,
      projectVersion: state.project.version,
      environmentKind: session?.environmentKind ?? null,
      documentName: session?.documentName ?? null
    });

    verificationResultStore.save(result);

    return { result };
  };

  return { tool, handler };
}
