import type { MemoryRecord, MemoryKind, MemoryProvenanceKind, MemoryStatus, WorldModelState } from "@naqsh/schemas";
import type { CandidateStore } from "./candidate-store.js";
import type { VerificationResultStore } from "./verification-result-store.js";
import type { OptimizationResultStore } from "./optimization-result-store.js";
import type { CheckpointStore } from "./checkpoint-store.js";
import type { ChangeHistory } from "./change-history.js";
import type { MemoryStore } from "./memory-store.js";

/**
 * Deterministic SEMANTIC validation + retrieval for `MemoryRecord` (P24) --
 * mirrors `validateOptimizationProblemSemantics`'s (P23) exact shape and
 * reasoning: shape validation (`assertMemoryRecord`, schemas) only knows a
 * reference field is "an array of strings," never whether any of those
 * strings name something real. This is what makes "a memory can never
 * silently cite a requirement/candidate/verification result/etc. that does
 * not exist" an enforced fact a caller (the `memory_add` tool) can check,
 * not a convention.
 *
 * Every dependency (`state`/`candidateStore`/`verificationResultStore`/
 * `optimizationResultStore`/`checkpointStore`/`changeHistory`/
 * `memoryStore`) is OPTIONAL -- mirrors `validateOptimizationProblemSemantics`'s
 * identical optional-dependency pattern -- so a caller validating a memory
 * before every store even exists yet still gets whichever checks its
 * available dependencies support.
 */
export type MemorySemanticIssueCode =
  | "project_mismatch"
  | "unresolved_requirement_in_project"
  | "unresolved_constraint_in_project"
  | "unresolved_decision_in_project"
  | "unresolved_preference_in_project"
  | "unresolved_object_in_project"
  | "unresolved_research_evidence_in_project"
  | "unresolved_source_in_project"
  | "unknown_candidate_reference"
  | "unknown_verification_result_reference"
  | "unknown_optimization_result_reference"
  | "unknown_checkpoint_reference"
  | "unknown_change_reference"
  | "possible_duplicate_memory";

export interface MemorySemanticIssue {
  code: MemorySemanticIssueCode;
  message: string;
}

export interface ValidateMemoryRecordSemanticsOptions {
  state?: WorldModelState;
  candidateStore?: CandidateStore;
  verificationResultStore?: VerificationResultStore;
  optimizationResultStore?: OptimizationResultStore;
  checkpointStore?: CheckpointStore;
  changeHistory?: ChangeHistory;
  /** When supplied, an ACTIVE memory record already sharing this record's
   * `(projectId, kind, title)` is reported as `possible_duplicate_memory`
   * -- the brief's own explicit "detect obvious duplicate records" via a
   * stable, deterministic identity tuple rather than a semantic/embedding
   * comparison, mirroring `Clarification`'s (P19) identical
   * `(requirementCandidateId, category)` duplicate-prevention precedent. */
  memoryStore?: MemoryStore;
}

export function validateMemoryRecordSemantics(record: MemoryRecord, options: ValidateMemoryRecordSemanticsOptions = {}): MemorySemanticIssue[] {
  const issues: MemorySemanticIssue[] = [];

  if (options.state && record.projectId !== options.state.project.id) {
    issues.push({
      code: "project_mismatch",
      message: `MemoryRecord belongs to project "${record.projectId}", not the current project "${options.state.project.id}"`
    });
  }

  if (options.state && record.projectId === options.state.project.id) {
    const project = options.state.project;
    const requirementIds = new Set(project.requirements.map((requirement) => requirement.id));
    const constraintIds = new Set(project.constraints.map((constraint) => constraint.id));
    const decisionIds = new Set(project.decisions.map((decision) => decision.id));
    const preferenceIds = new Set(project.preferences.map((preference) => preference.id));
    const objectIds = new Set(project.objects.map((object) => object.id));
    const researchEvidenceIds = new Set(project.researchEvidence.map((evidence) => evidence.id));
    const sourceIds = new Set(project.sources.map((source) => source.id));

    for (const id of record.references.requirementIds) {
      if (!requirementIds.has(id)) issues.push({ code: "unresolved_requirement_in_project", message: `MemoryRecord references requirement "${id}", which does not exist in the current project` });
    }
    for (const id of record.references.constraintIds) {
      if (!constraintIds.has(id)) issues.push({ code: "unresolved_constraint_in_project", message: `MemoryRecord references constraint "${id}", which does not exist in the current project` });
    }
    for (const id of record.references.decisionIds) {
      if (!decisionIds.has(id)) issues.push({ code: "unresolved_decision_in_project", message: `MemoryRecord references decision "${id}", which does not exist in the current project` });
    }
    for (const id of record.references.preferenceIds) {
      if (!preferenceIds.has(id)) issues.push({ code: "unresolved_preference_in_project", message: `MemoryRecord references preference "${id}", which does not exist in the current project` });
    }
    for (const id of record.references.objectIds) {
      if (!objectIds.has(id)) issues.push({ code: "unresolved_object_in_project", message: `MemoryRecord references object "${id}", which does not exist in the current project` });
    }
    for (const id of record.references.researchEvidenceIds) {
      if (!researchEvidenceIds.has(id)) issues.push({ code: "unresolved_research_evidence_in_project", message: `MemoryRecord references research evidence "${id}", which does not exist in the current project` });
    }
    for (const id of record.references.sourceIds) {
      if (!sourceIds.has(id)) issues.push({ code: "unresolved_source_in_project", message: `MemoryRecord references source "${id}", which does not exist in the current project` });
    }
  }

  if (options.candidateStore) {
    for (const id of record.references.candidateIds) {
      if (!options.candidateStore.getById(id)) issues.push({ code: "unknown_candidate_reference", message: `MemoryRecord references candidate "${id}", which does not exist` });
    }
  }

  if (options.verificationResultStore) {
    for (const id of record.references.verificationResultIds) {
      if (!options.verificationResultStore.getById(id)) issues.push({ code: "unknown_verification_result_reference", message: `MemoryRecord references verification result "${id}", which does not exist` });
    }
  }

  if (options.optimizationResultStore) {
    for (const id of record.references.optimizationResultIds) {
      if (!options.optimizationResultStore.getById(id)) issues.push({ code: "unknown_optimization_result_reference", message: `MemoryRecord references optimization result "${id}", which does not exist` });
    }
  }

  if (options.checkpointStore) {
    for (const id of record.references.checkpointIds) {
      if (!options.checkpointStore.getById(id)) issues.push({ code: "unknown_checkpoint_reference", message: `MemoryRecord references checkpoint "${id}", which does not exist` });
    }
  }

  if (options.changeHistory) {
    for (const id of record.references.changeIds) {
      if (!options.changeHistory.getById(id)) issues.push({ code: "unknown_change_reference", message: `MemoryRecord references change "${id}", which does not exist` });
    }
  }

  if (options.memoryStore) {
    const duplicate = options.memoryStore
      .listForProject(record.projectId)
      .find((existing) => existing.status === "active" && existing.id !== record.id && existing.kind === record.kind && existing.title === record.title);
    if (duplicate) {
      issues.push({
        code: "possible_duplicate_memory",
        message: `An active memory record "${duplicate.id}" already exists in this project with the same kind ("${record.kind}") and title ("${record.title}")`
      });
    }
  }

  return issues;
}

/** Upper bound `searchMemoryRecords` will ever return, regardless of
 * `query.limit` -- prevents an unbounded "return every memory record"
 * query for a large project (brief: "Prevent unbounded memory operations").
 * `DEFAULT_MEMORY_SEARCH_LIMIT` is the sane default when a caller doesn't
 * specify one. */
export const MAX_MEMORY_SEARCH_RESULTS = 100;
export const DEFAULT_MEMORY_SEARCH_LIMIT = 20;

export interface MemorySearchQuery {
  projectId: string;
  kind?: MemoryKind;
  status?: MemoryStatus;
  provenanceKind?: MemoryProvenanceKind;
  source?: string;
  /** Matches a memory whose ANY reference array contains this id -- e.g.
   * "every memory that mentions candidate_7", regardless of which
   * reference field it appears under. */
  referencedEntityId?: string;
  /** Case-insensitive substring match against `title` OR `content`,
   * bounded by ordinary string length (no regex, no external search
   * engine) -- deterministic, no embeddings (brief: "A clean deterministic
   * retrieval layer is preferable at P24"). */
  textQuery?: string;
  limit?: number;
}

export interface MemorySearchResult {
  records: readonly MemoryRecord[];
  /** How many records matched the filters BEFORE `limit` was applied --
   * lets a caller know whether results were truncated. */
  totalMatched: number;
  limit: number;
}

const MEMORY_REFERENCE_FIELD_NAMES = [
  "requirementIds",
  "constraintIds",
  "decisionIds",
  "preferenceIds",
  "objectIds",
  "experimentIds",
  "candidateIds",
  "verificationResultIds",
  "optimizationResultIds",
  "researchEvidenceIds",
  "sourceIds",
  "checkpointIds",
  "changeIds"
] as const;

function referencesEntity(record: MemoryRecord, entityId: string): boolean {
  return MEMORY_REFERENCE_FIELD_NAMES.some((field) => record.references[field].includes(entityId));
}

function matchesTextQuery(record: MemoryRecord, query: string): { titleMatch: boolean; contentMatch: boolean } {
  const normalized = query.toLowerCase();
  return {
    titleMatch: record.title.toLowerCase().includes(normalized),
    contentMatch: record.content.toLowerCase().includes(normalized)
  };
}

/**
 * Pure, deterministic filter + sort + bound over an already-loaded set of
 * `MemoryRecord`s -- takes a plain array (never a store) so it is testable
 * without any store/state setup, matching `compareCandidates`'s (P22)
 * identical "pure analysis function over already-fetched data" precedent.
 *
 * ALWAYS scoped by `query.projectId` first, unconditionally -- PROJECT
 * ISOLATION is not optional here (brief: "Memory from Project A must never
 * appear in Project B"). `status` defaults to `"active"` when omitted (a
 * caller wanting superseded/archived/rejected history back must ask for it
 * explicitly).
 *
 * Deterministic ordering (brief: "Given identical memory state, project,
 * query, filters, the same result set and ordering must be returned. If
 * multiple records tie, use a stable secondary ordering."):
 *   1. If `textQuery` is given, a record whose TITLE matches sorts before
 *      one that only matches CONTENT (title match is a stronger relevance
 *      signal than a body mention).
 *   2. `createdAt` descending (most recent first).
 *   3. `id` ascending -- a final, always-available tiebreak (ids are
 *      never equal for two different records), so ordering is total even
 *      when every other signal ties.
 * None of these signals depend on object/Map insertion order, random
 * values, wall-clock "now," or a model response.
 */
export function searchMemoryRecords(records: readonly MemoryRecord[], query: MemorySearchQuery): MemorySearchResult {
  const status = query.status ?? "active";
  const normalizedTextQuery = query.textQuery && query.textQuery.trim().length > 0 ? query.textQuery.trim() : null;

  const matched = records.filter((record) => {
    if (record.projectId !== query.projectId) return false;
    if (record.status !== status) return false;
    if (query.kind && record.kind !== query.kind) return false;
    if (query.provenanceKind && record.provenanceKind !== query.provenanceKind) return false;
    if (query.source && record.source !== query.source) return false;
    if (query.referencedEntityId && !referencesEntity(record, query.referencedEntityId)) return false;
    if (normalizedTextQuery) {
      const { titleMatch, contentMatch } = matchesTextQuery(record, normalizedTextQuery);
      if (!titleMatch && !contentMatch) return false;
    }
    return true;
  });

  const sorted = [...matched].sort((a, b) => {
    if (normalizedTextQuery) {
      const aMatch = matchesTextQuery(a, normalizedTextQuery);
      const bMatch = matchesTextQuery(b, normalizedTextQuery);
      if (aMatch.titleMatch !== bMatch.titleMatch) {
        return aMatch.titleMatch ? -1 : 1;
      }
    }
    const createdAtDiff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    if (createdAtDiff !== 0) return createdAtDiff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const requestedLimit = query.limit ?? DEFAULT_MEMORY_SEARCH_LIMIT;
  const limit = Math.max(1, Math.min(requestedLimit, MAX_MEMORY_SEARCH_RESULTS));

  return {
    records: sorted.slice(0, limit),
    totalMatched: matched.length,
    limit
  };
}

export interface RelatedMemoryEntry {
  record: MemoryRecord;
  /** Why this record was returned as related -- deterministic, explicit,
   * never an LLM's own notion of "relevant" (brief: "Do NOT use an LLM to
   * secretly decide which memory is relevant"). */
  relation: "shares_reference" | "supersedes" | "superseded_by";
}

/**
 * Pure function: given the full set of a project's memory records and one
 * record's id, returns every OTHER record that is either (a) linked via the
 * supersession chain (direct predecessor/successor only -- not the whole
 * transitive history, which a caller can walk further via repeated calls)
 * or (b) shares at least one reference id with the target record. Bounded
 * by `MAX_MEMORY_SEARCH_RESULTS` for the same "no unbounded query" reason
 * `searchMemoryRecords` is bounded.
 */
export function getRelatedMemoryRecords(records: readonly MemoryRecord[], memoryId: string): RelatedMemoryEntry[] {
  const target = records.find((record) => record.id === memoryId);
  if (!target) {
    return [];
  }

  const related: RelatedMemoryEntry[] = [];

  // Predecessors are found by searching for EVERY record whose
  // AUTHORITATIVE supersededByMemoryId (set only by MemoryStore.supersede)
  // points at this one -- NOT by trusting `target.supersedesMemoryId`,
  // which is merely the declared-at-creation forward pointer (see
  // `memory-types.ts`'s own doc comment on `supersedesMemoryId`) and is
  // never set by `MemoryStore.supersede` itself, so relying on it here
  // would silently miss every supersession applied via `memory_supersede`
  // without an accompanying `memory_add`-time declaration. Uses `.filter`,
  // not `.find` -- `MemoryStore.supersede` never limits how many DIFFERENT
  // old records can point their `supersededByMemoryId` at the SAME newer
  // one (a single newer memory legitimately consolidating several older
  // ones is valid), so a caller must see all of them, not just the first.
  const predecessors = records.filter((record) => record.supersededByMemoryId === target.id);
  for (const predecessor of predecessors) {
    related.push({ record: predecessor, relation: "supersedes" });
  }

  if (target.supersededByMemoryId) {
    const successor = records.find((record) => record.id === target.supersededByMemoryId);
    if (successor) related.push({ record: successor, relation: "superseded_by" });
  }

  const targetReferencedIds = new Set(MEMORY_REFERENCE_FIELD_NAMES.flatMap((field) => target.references[field]));
  for (const candidate of records) {
    if (candidate.id === memoryId) continue;
    if (related.some((entry) => entry.record.id === candidate.id)) continue;
    const sharesReference = MEMORY_REFERENCE_FIELD_NAMES.some((field) => candidate.references[field].some((id) => targetReferencedIds.has(id)));
    if (sharesReference) {
      related.push({ record: candidate, relation: "shares_reference" });
    }
  }

  return related
    .sort((a, b) => {
      const createdAtDiff = new Date(b.record.createdAt).getTime() - new Date(a.record.createdAt).getTime();
      if (createdAtDiff !== 0) return createdAtDiff;
      return a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0;
    })
    .slice(0, MAX_MEMORY_SEARCH_RESULTS);
}
