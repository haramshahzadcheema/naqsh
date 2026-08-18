import type { EntitySource } from "./types.js";

/**
 * Phase 21: EXTERNAL KNOWLEDGE -> RESEARCH -> STRUCTURED EVIDENCE ->
 * TRACEABLE SOURCE -> ENGINEERING CONTEXT -> REASONING -> REQUIREMENTS /
 * DECISIONS / PLAN.
 *
 * Five distinct concepts, deliberately never collapsed into one text field
 * (P21 brief Section 4):
 *   `Source`           -- WHERE information came from (a datasheet, a
 *                          standard, a web page, a user upload). World
 *                          Model state (lives in `Project.sources`).
 *   `ResearchEvidence`  -- ONE specific claim a `Source` supports, plus a
 *                          bounded excerpt -- never the whole document.
 *                          Also World Model state (`Project.researchEvidence`).
 *                          Named `ResearchEvidence`, not `Evidence`, because
 *                          `Evidence` already means something different in
 *                          this codebase: P16's `Evidence` (verification-types.ts)
 *                          is the OBSERVED FACTS gathered while running a
 *                          deterministic `Check` against an environment
 *                          object (objectId/observedValue/propertyExists) --
 *                          a completely different concept that happens to
 *                          share the word "evidence" in English. Reusing
 *                          that name here would either collide at the
 *                          schemas barrel (`export *`) or force a confusing
 *                          re-read of which "Evidence" a given import means.
 *   `ResearchRequest`   -- the ACT of asking for research (why, what query,
 *                          which requirement it's for) -- a candidate/
 *                          process record, NOT World Model state, mirroring
 *                          `Plan`/`Proposal`'s identical "describes a
 *                          proposed/attempted action, not accepted project
 *                          content" split.
 *   `ResearchSourceCandidate` / `ResearchFetchContent` -- what a
 *                          `ResearchProvider` (core) actually returns before
 *                          anything is accepted -- untrusted, unvalidated,
 *                          bounded, and NEVER directly a `Source`/
 *                          `ResearchEvidence` until a human/agent explicitly
 *                          promotes one via `add_source`/`add_evidence`
 *                          (mirrors `RequirementCandidate` -> `Requirement`
 *                          via `add_requirement`, P18).
 *   Traceability (claim -> requirement/decision) is NOT a sixth new entity.
 *   `ResearchEvidence` already carries `sourceId` (evidence -> source) and
 *   `claim` (the assertion itself); linking evidence to a `Requirement`/
 *   `Decision` reuses P8's EXISTING `EntityRelationship` mechanism (see
 *   `types.ts`'s `EntityKind`, extended here with `"source"`/
 *   `"research_evidence"`) -- P21 brief Section 8's own "do NOT create a
 *   second provenance system" instruction, applied literally. Linking
 *   evidence to a `Plan`/`PlanStep` (which are NOT `Project` entities, so
 *   `EntityRelationship` cannot reach them) instead uses nullable
 *   `relatedPlanId`/`relatedPlanStepId` fields on `ResearchRequest`,
 *   mirroring `DesignSpecification.planId`/`planStepId`'s identical
 *   "reference by id, own store" pattern (P20).
 *
 * `EntitySource` (P1) already anticipated this phase: `"research"` has been
 * a valid provenance value since P2. `ToolTarget` (P3) already anticipated
 * it too: `"research"` has been a valid tool target since P3. Neither
 * needed a single field added for P21 -- confirmed by reading both files
 * before writing this one, not assumed.
 */

// ---------------------------------------------------------------------------
// Source (World Model state)
// ---------------------------------------------------------------------------

/** Deliberately small and additive (P21 brief Section 5: "do not
 * over-engineer source classification"). */
export type SourceType =
  | "documentation"
  | "datasheet"
  | "standard"
  | "specification"
  | "academic_paper"
  | "manufacturer_documentation"
  | "web_page"
  | "user_provided"
  | "other";

export const SOURCE_TYPES: readonly SourceType[] = [
  "documentation",
  "datasheet",
  "standard",
  "specification",
  "academic_paper",
  "manufacturer_documentation",
  "web_page",
  "user_provided",
  "other"
];

/** Deliberately coarse (P21 brief Section 17: "DO NOT build a sophisticated
 * universal trust-ranking engine" -- that is P23's job). `"unknown"` is the
 * honest default, never silently upgraded to `"medium"`. */
export type SourceReliability = "unknown" | "low" | "medium" | "high";

export const SOURCE_RELIABILITIES: readonly SourceReliability[] = ["unknown", "low", "medium", "high"];

export type SourceStatus = "active" | "retracted";

export const SOURCE_STATUSES: readonly SourceStatus[] = ["active", "retracted"];

/**
 * A place information came from. `locator` is deliberately a bare nullable
 * string (a URL, a document identifier, a part number -- whatever
 * identifies this source), never a parsed/validated URL object: `Source` is
 * a record of provenance, not a fetchable resource descriptor (that's
 * `ResearchFetchRequest`'s job, and only for sources that genuinely have a
 * fetchable locator). `contentHash` lets two independently-retrieved copies
 * of the same source be recognized as the same source without comparing
 * full content (which NAQSH never stores here -- see `ResearchEvidence.excerpt`).
 */
export interface Source {
  id: string;
  locator: string | null;
  title: string;
  publisher: string | null;
  sourceType: SourceType;
  reliability: SourceReliability;
  /** When NAQSH obtained this source (a research fetch, or a human
   * upload/citation) -- distinct from `publishedAt`, which is the source's
   * OWN publication date and may be much earlier, or unknown. */
  retrievedAt: string;
  publishedAt: string | null;
  contentHash: string | null;
  status: SourceStatus;
  /** Provenance of THIS RECORD (who/what added it to the project) -- reuses
   * `EntitySource` exactly like every other entity's `source` field. Note
   * this is a different thing from `Source` the entity kind: a `Source`
   * entity's own `.source` field says whether a human, research, or import
   * process created the record; `Source.sourceType` says what KIND of
   * external material it is (a datasheet, a standard, ...). */
  source: EntitySource;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface SourceInput {
  id?: string;
  locator?: string | null;
  title: string;
  publisher?: string | null;
  sourceType: SourceType;
  reliability?: SourceReliability;
  retrievedAt?: string;
  publishedAt?: string | null;
  contentHash?: string | null;
  status?: SourceStatus;
  source?: EntitySource;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// ResearchEvidence (World Model state)
// ---------------------------------------------------------------------------

export type ResearchEvidenceConfidence = "low" | "medium" | "high";

export const RESEARCH_EVIDENCE_CONFIDENCES: readonly ResearchEvidenceConfidence[] = ["low", "medium", "high"];

export type ResearchEvidenceStatus = "active" | "retracted";

export const RESEARCH_EVIDENCE_STATUSES: readonly ResearchEvidenceStatus[] = ["active", "retracted"];

/** A bounded excerpt is never allowed to become "the whole document" (P21
 * brief Section 6: "Do not store giant source documents unnecessarily
 * inside the World Model"). Enforced by `assertResearchEvidence`, not
 * merely documented -- the same "validator is authoritative" discipline
 * every prior phase's invariant already uses. Provider-side normalization
 * (core) truncates to this bound BEFORE it ever reaches evidence creation,
 * so a hostile/oversized provider response is defused at the boundary, not
 * merely rejected after the fact. */
export const MAX_RESEARCH_EVIDENCE_EXCERPT_LENGTH = 4000;

/**
 * ONE specific claim, and the (bounded) material that supports it. This is
 * the "claim" the P21 brief's Section 7 asks for -- deliberately a FIELD on
 * `ResearchEvidence`, not a separate top-level entity: the brief itself says
 * "the exact implementation may differ ... but the relationship must be
 * explicit," and a claim divorced from the evidence supporting it (a
 * separate `Claim` entity referencing `ResearchEvidence` by id) would just
 * be the same fact split across two records for no traceability benefit --
 * `sourceId` -> `claim` -> (via EntityRelationship) -> requirement/decision
 * is already a complete, explicit chain.
 */
export interface ResearchEvidence {
  id: string;
  /** The `Source.id` this evidence was drawn from. Referential integrity
   * (does this id actually resolve?) is a read-time concern, matching
   * `EntityRelationship.sourceId`/`targetId`'s identical "the reducer never
   * checks cross-entity references" precedent (P8) -- see
   * `add-evidence-tool.ts` (core) for where this IS checked, deliberately
   * kept out of the schema layer's write path. */
  sourceId: string;
  /** The specific assertion this evidence supports, e.g. "6061-T6 aluminum
   * has a yield strength of approximately 276 MPa." Required and non-empty
   * -- evidence with no claim is not evidence of anything. */
  claim: string;
  /** The relevant excerpt/reference FROM the source -- bounded (see
   * `MAX_RESEARCH_EVIDENCE_EXCERPT_LENGTH`), `null` when no direct excerpt
   * is available (e.g. a human-stated claim citing a source without a
   * pasted quote). */
  excerpt: string | null;
  confidence: ResearchEvidenceConfidence;
  /** Free-text note on WHY this evidence is relevant to whatever it will be
   * linked to -- not a numeric score (P21 brief Section 17: no
   * sophisticated trust-ranking engine yet). */
  relevanceNote: string | null;
  retrievedAt: string;
  status: ResearchEvidenceStatus;
  source: EntitySource;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface ResearchEvidenceInput {
  id?: string;
  sourceId: string;
  claim: string;
  excerpt?: string | null;
  confidence?: ResearchEvidenceConfidence;
  relevanceNote?: string | null;
  retrievedAt?: string;
  status?: ResearchEvidenceStatus;
  source?: EntitySource;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// ResearchRequest (process/candidate record -- own store, NOT Project state)
// ---------------------------------------------------------------------------

export type ResearchRequestStatus = "pending" | "completed" | "failed" | "cancelled";

export const RESEARCH_REQUEST_STATUSES: readonly ResearchRequestStatus[] = ["pending", "completed", "failed", "cancelled"];

/**
 * WHY research is being performed, not just what to search for (P21 brief
 * Section 12: avoid "search the web," prefer "Find the manufacturer-stated
 * yield strength for material X to evaluate requirement R-14"). `purpose`
 * is therefore required and non-empty, exactly like `query`.
 */
export interface ResearchRequest {
  id: string;
  projectId: string;
  projectVersion: number;
  query: string;
  purpose: string;
  relatedRequirementIds: string[];
  relatedConstraintIds: string[];
  /** The `Plan.id`/`PlanStep.id` this research supports, or `null` when
   * this research is not tied to a specific plan step (P21 brief Section
   * 25: "Only represent the relationship when it exists"). */
  relatedPlanId: string | null;
  relatedPlanStepId: string | null;
  preferredSourceTypes: SourceType[];
  maxResults: number;
  /** How fresh a source must be to satisfy this request, in days, or `null`
   * for no freshness requirement -- deliberately a plain number (not a
   * structured recency policy), matching `Constraint.value`'s "keep it a
   * plain field until a real second use case demands more" discipline. */
  freshnessRequirementDays: number | null;
  status: ResearchRequestStatus;
  source: EntitySource;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface ResearchRequestInput {
  id?: string;
  projectId: string;
  projectVersion: number;
  query: string;
  purpose: string;
  relatedRequirementIds?: string[];
  relatedConstraintIds?: string[];
  relatedPlanId?: string | null;
  relatedPlanStepId?: string | null;
  preferredSourceTypes?: SourceType[];
  maxResults?: number;
  freshnessRequirementDays?: number | null;
  status?: ResearchRequestStatus;
  source?: EntitySource;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// ResearchProvider wire contract (core defines the interface; this file
// defines the data both sides pass across it) -- mirrors ModelRequest/
// ModelResponse/ModelInvocationResult (P7) exactly.
// ---------------------------------------------------------------------------

export interface ResearchProviderDescriptor {
  providerId: string;
  name: string;
  version: string;
  metadata: Record<string, unknown>;
}

export interface ResearchSearchRequest {
  id: string;
  query: string;
  maxResults: number;
  preferredSourceTypes: SourceType[];
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface ResearchSearchRequestInput {
  id?: string;
  query: string;
  maxResults?: number;
  preferredSourceTypes?: SourceType[];
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

/** ONE candidate result from a search call -- UNTRUSTED, unvalidated
 * provider output. Deliberately NOT a `Source`: no `id`, no `status`, no
 * `source` provenance field yet, because nothing has decided this candidate
 * is worth keeping. `snippet` is bounded the same way `ResearchEvidence.excerpt`
 * is (enforced where candidates are normalized, not here -- see
 * `research-normalization.ts`). */
export interface ResearchSourceCandidate {
  locator: string | null;
  title: string;
  publisher: string | null;
  sourceType: SourceType;
  publishedAt: string | null;
  snippet: string;
}

export type ResearchProviderErrorKind =
  | "provider_unavailable"
  | "timeout"
  | "rate_limit"
  | "invalid_request"
  | "malformed_result"
  | "blocked_locator"
  | "provider_error";

export const RESEARCH_PROVIDER_ERROR_KINDS: readonly ResearchProviderErrorKind[] = [
  "provider_unavailable",
  "timeout",
  "rate_limit",
  "invalid_request",
  "malformed_result",
  "blocked_locator",
  "provider_error"
];

export interface ResearchProviderError {
  kind: ResearchProviderErrorKind;
  message: string;
}

export type ResearchInvocationStatus = "success" | "error";

/** Mirrors `ModelInvocationResult`'s exact shape and reasoning -- never a
 * thrown exception for an expected failure (provider down, rate-limited,
 * malformed result), always a returned, inspectable record. */
export interface ResearchSearchInvocationResult {
  id: string;
  requestId: string;
  providerId: string;
  status: ResearchInvocationStatus;
  results: ResearchSourceCandidate[] | null;
  error: ResearchProviderError | null;
  startedAt: string;
  completedAt: string;
  metadata: Record<string, unknown>;
}

export interface ResearchSearchInvocationResultInput {
  id?: string;
  requestId: string;
  providerId: string;
  status: ResearchInvocationStatus;
  results?: ResearchSourceCandidate[] | null;
  error?: ResearchProviderError | null;
  startedAt: string;
  completedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface ResearchFetchRequest {
  id: string;
  /** The specific candidate's `locator` to retrieve content for --
   * required, unlike `Source.locator` (which may be `null` for a source
   * with no fetchable address, e.g. a verbally-cited standard). */
  locator: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface ResearchFetchRequestInput {
  id?: string;
  locator: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

/** The normalized content for ONE source after a fetch -- `excerpt` is
 * ALREADY bounded/truncated by the provider boundary (core) before this
 * reaches anywhere near evidence creation; never the raw fetched document. */
export interface ResearchFetchContent {
  locator: string;
  title: string;
  publisher: string | null;
  sourceType: SourceType;
  publishedAt: string | null;
  retrievedAt: string;
  excerpt: string;
  contentHash: string | null;
}

export interface ResearchFetchInvocationResult {
  id: string;
  requestId: string;
  providerId: string;
  status: ResearchInvocationStatus;
  content: ResearchFetchContent | null;
  error: ResearchProviderError | null;
  startedAt: string;
  completedAt: string;
  metadata: Record<string, unknown>;
}

export interface ResearchFetchInvocationResultInput {
  id?: string;
  requestId: string;
  providerId: string;
  status: ResearchInvocationStatus;
  content?: ResearchFetchContent | null;
  error?: ResearchProviderError | null;
  startedAt: string;
  completedAt?: string;
  metadata?: Record<string, unknown>;
}
