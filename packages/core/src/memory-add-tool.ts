import {
  createMemoryRecord,
  ENTITY_SOURCES,
  MEMORY_KINDS,
  MEMORY_PROVENANCE_KINDS,
  ToolError,
  WorldModelValidationError,
  createTool,
  type EntitySource,
  type MemoryKind,
  type MemoryProvenanceKind,
  type MemoryReferencesInput,
  type MemoryRecordInput,
  type Tool,
  type ToolValueSchema,
  type WorldModelState
} from "@naqsh/schemas";
import type { CandidateStore } from "./candidate-store.js";
import type { VerificationResultStore } from "./verification-result-store.js";
import type { OptimizationResultStore } from "./optimization-result-store.js";
import type { CheckpointStore } from "./checkpoint-store.js";
import type { ChangeHistory } from "./change-history.js";
import type { MemoryStore } from "./memory-store.js";
import { validateMemoryRecordSemantics } from "./memory-semantics.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * Phase 24's memory-CREATION tool -- the one place a `MemoryRecord` is ever
 * written. Mirrors `create_optimization_problem`'s (P23) exact shape: a
 * validated, stored record out of already-decided fields in (kind/title/
 * content/provenanceKind/references an agent's own reasoning or a human
 * already settled on, NOT computed by this tool).
 *
 * `projectId`/`projectVersion` are NOT caller-supplied -- read from LIVE
 * `WorldModelState`, closing the same spoofing path `create_candidate`/
 * `create_optimization_problem` already close.
 *
 * `references` is declared loosely in the input schema (an open object,
 * `additionalProperties: true`) -- `ToolValueSchema` has no way to express
 * `MemoryReferences`'s real shape at this coarse gate; the REAL validation
 * happens inside `createMemoryRecord` (schema-level: array-of-strings
 * shape, plus the confidence/provenanceKind/status consistency rules) and
 * then `validateMemoryRecordSemantics` (this file's own cross-reference
 * checks against every store a memory can point into, plus duplicate
 * detection) -- the same "coarse gate, real validation in the handler"
 * precedent every prior phase's tool uses.
 *
 * `supersedesMemoryId`, if given, is checked here to resolve to a REAL,
 * currently-`"active"` memory in the SAME project -- but this tool does
 * NOT itself apply the formal supersession transition (that stays
 * `memory_supersede`'s single responsibility, avoiding a partial-failure
 * window where a new record could be saved but the old one left
 * un-superseded). A caller that wants both steps calls `memory_add` then
 * `memory_supersede`.
 *
 * Classified `mutation: "suggest"` -- `MemoryRecord` lives in its own store
 * (`MemoryStore`), never `WorldModelState`, the same classification
 * `create_candidate`/`create_check`/`create_optimization_problem` use for
 * the identical reason.
 */

const openObjectSchema: ToolValueSchema = { type: "object", properties: {}, additionalProperties: true };

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: MEMORY_KINDS as string[] },
    title: { type: "string", description: "A short, specific summary." },
    content: { type: "string", description: "The actual finding/statement." },
    provenanceKind: { type: "string", enum: MEMORY_PROVENANCE_KINDS as string[] },
    confidence: { type: "number", nullable: true, description: "Only meaningful (and only ever kept) when provenanceKind is 'model_synthesis'." },
    references: {
      ...openObjectSchema,
      nullable: true,
      description:
        "MemoryReferences input: any of requirementIds/constraintIds/decisionIds/preferenceIds/objectIds/experimentIds/candidateIds/verificationResultIds/optimizationResultIds/researchEvidenceIds/sourceIds/checkpointIds/changeIds, each an array of real ids. Deep-validated by this tool's handler."
    },
    supersedesMemoryId: { type: "string", nullable: true, description: "Declares this memory as a replacement for an existing active memory. Does not itself apply the transition -- call memory_supersede afterward." },
    provenance: { type: "string", nullable: true, description: "Who/what is recording this memory -- one of EntitySource. Defaults to 'agent'." }
  },
  required: ["kind", "title", "content", "provenanceKind"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: { memory: openObjectSchema },
  required: ["memory"]
};

interface MemoryAddToolInput {
  kind: MemoryKind;
  title: string;
  content: string;
  provenanceKind: MemoryProvenanceKind;
  confidence: number | null;
  references: MemoryReferencesInput;
  supersedesMemoryId: string | null;
  provenance: EntitySource | null;
}

function toMemoryAddToolInput(rawInput: unknown): MemoryAddToolInput {
  const record = rawInput as {
    kind?: unknown;
    title?: unknown;
    content?: unknown;
    provenanceKind?: unknown;
    confidence?: unknown;
    references?: unknown;
    supersedesMemoryId?: unknown;
    provenance?: unknown;
  };
  if (!(MEMORY_KINDS as readonly string[]).includes(record.kind as string)) {
    throw new ToolError("invalid_input", `kind is required and must be one of: ${MEMORY_KINDS.join(", ")}`);
  }
  if (typeof record.title !== "string" || record.title.trim().length === 0) {
    throw new ToolError("invalid_input", "title is required and must be a non-empty string");
  }
  if (typeof record.content !== "string" || record.content.trim().length === 0) {
    throw new ToolError("invalid_input", "content is required and must be a non-empty string");
  }
  if (!(MEMORY_PROVENANCE_KINDS as readonly string[]).includes(record.provenanceKind as string)) {
    throw new ToolError("invalid_input", `provenanceKind is required and must be one of: ${MEMORY_PROVENANCE_KINDS.join(", ")}`);
  }
  if (record.references !== undefined && record.references !== null && (typeof record.references !== "object" || Array.isArray(record.references))) {
    throw new ToolError("invalid_input", "references must be an object when supplied");
  }
  if (record.provenance !== undefined && record.provenance !== null && !(ENTITY_SOURCES as readonly string[]).includes(record.provenance as string)) {
    throw new ToolError("invalid_input", `provenance must be one of: ${ENTITY_SOURCES.join(", ")}`);
  }

  return {
    kind: record.kind as MemoryKind,
    title: record.title,
    content: record.content,
    provenanceKind: record.provenanceKind as MemoryProvenanceKind,
    confidence: typeof record.confidence === "number" ? record.confidence : null,
    references: (record.references as MemoryReferencesInput | undefined) ?? {},
    supersedesMemoryId: typeof record.supersedesMemoryId === "string" ? record.supersedesMemoryId : null,
    provenance: typeof record.provenance === "string" ? (record.provenance as EntitySource) : null
  };
}

export function createMemoryAddTool(
  memoryStore: MemoryStore,
  getState: () => WorldModelState,
  dependencies: {
    candidateStore?: CandidateStore;
    verificationResultStore?: VerificationResultStore;
    optimizationResultStore?: OptimizationResultStore;
    checkpointStore?: CheckpointStore;
    changeHistory?: ChangeHistory;
  } = {}
): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "memory_add",
    description:
      "Records a new, durable MemoryRecord: a decision, lesson, failure, success, or finding, grounded in real referenced entities (requirements, candidates, experiments, verification/optimization results, research evidence, etc.). Never mutates the World Model or the environment; never itself computes an engineering fact -- it records what was already established elsewhere.",
    target: "memory",
    mutation: "suggest",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = (rawInput) => {
    const input = toMemoryAddToolInput(rawInput);
    const state = getState();

    if (input.supersedesMemoryId !== null) {
      const predecessor = memoryStore.getById(input.supersedesMemoryId);
      if (!predecessor) {
        throw new ToolError("invalid_input", `memory_not_found: no memory record "${input.supersedesMemoryId}" exists`);
      }
      if (predecessor.projectId !== state.project.id) {
        throw new ToolError(
          "invalid_input",
          `memory_wrong_project: memory record "${input.supersedesMemoryId}" belongs to project "${predecessor.projectId}", not the current project "${state.project.id}"`
        );
      }
      if (predecessor.status !== "active") {
        throw new ToolError("invalid_input", `memory_not_active: memory record "${input.supersedesMemoryId}" is "${predecessor.status}", not "active", and cannot be superseded`);
      }
    }

    const memoryInput: MemoryRecordInput = {
      projectId: state.project.id,
      projectVersion: state.project.version,
      kind: input.kind,
      title: input.title,
      content: input.content,
      provenanceKind: input.provenanceKind,
      confidence: input.confidence,
      references: input.references,
      supersedesMemoryId: input.supersedesMemoryId,
      source: input.provenance ?? "agent"
    };

    let memory;
    try {
      memory = createMemoryRecord(memoryInput);
    } catch (error) {
      if (error instanceof WorldModelValidationError) {
        throw new ToolError("invalid_input", `memory record is invalid: ${error.message}`);
      }
      throw error;
    }

    const issues = validateMemoryRecordSemantics(memory, { state, memoryStore, ...dependencies });
    if (issues.length > 0) {
      throw new ToolError("invalid_input", `memory record failed semantic validation: ${issues.map((issue) => `[${issue.code}] ${issue.message}`).join("; ")}`);
    }

    memoryStore.save(memory);
    return { memory };
  };

  return { tool, handler };
}
