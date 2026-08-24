import { createExecuteToolAuthorizer, executeTool } from "@naqsh/core";
import type { MemoryKind, MemoryRecord, MemoryReferencesInput, ResearchEvidence, ResearchFetchContent, Source, SourceType } from "@naqsh/schemas";
import type { ProjectRuntime } from "./projectRuntime.js";

/**
 * Part J/K's service layer: research (P21) and memory (P24), wired to the
 * real HTTP surface for the first time (see the audit that found both
 * genuinely unreachable from any route). Mirrors `engineeringWorkflow.ts`'s
 * own "orchestration + activity logging only, never a second
 * implementation" discipline -- every mutation still goes through
 * `executeTool`.
 *
 * Uses `autonomyLevel: "autonomous"` (not `engineeringWorkflow.ts`'s
 * `authorizerFor`, which is `approved_modify`) for the SAME reason
 * `captureRequirementFromStatement`/`syncEnvironmentObjectsIntoWorldModel`
 * do: `add_source`/`add_evidence`/`memory_add` are pre-authorized via
 * `grantChatRequirementCaptureAutonomy`'s `AutonomyGrant`
 * (projectRuntime.ts), and `evaluateToolAuthorization` only ever consults
 * an `AutonomyGrant` when the caller's autonomyLevel is literally
 * `"autonomous"` -- anything else falls through to requiring a real
 * per-call `Approval`, which this bookkeeping deliberately doesn't need.
 */

export interface WorkflowFailure {
  kind: string;
  message: string;
}

function autonomousAuthorizer(runtime: ProjectRuntime) {
  return createExecuteToolAuthorizer({ autonomyLevel: "autonomous", approvals: runtime.approvals, autonomyGrants: runtime.autonomyGrants });
}

export type FetchLocatorOutcome = { status: "success"; content: ResearchFetchContent } | { status: "error"; error: WorkflowFailure };

/** Real, SSRF-guarded fetch of ONE specific locator -- see
 * `http-research-provider.ts`. Never writes anything to the World Model by
 * itself; a caller decides separately whether to `acceptResearchSource`. */
export async function fetchResearchLocator(runtime: ProjectRuntime, locator: string): Promise<FetchLocatorOutcome> {
  runtime.logActivity("observed", "Fetching source", locator);
  const executed = await executeTool(runtime.registry, { toolName: "research_fetch", input: { locator }, source: "agent", target: null, authorize: autonomousAuthorizer(runtime) });
  if (executed.result.status === "error") {
    const message = executed.result.error?.message ?? "Could not fetch this locator.";
    runtime.logActivity("note", "Fetch failed", message);
    return { status: "error", error: { kind: executed.result.error?.kind ?? "fetch_failed", message } };
  }
  const content = (executed.result.output as { content: ResearchFetchContent }).content;
  runtime.logActivity("observed", "Fetched source", `"${content.title}" (${content.excerpt.length} chars)`);
  return { status: "success", content };
}

export interface AcceptSourceInput {
  locator: string | null;
  title: string;
  publisher: string | null;
  sourceType: SourceType;
  publishedAt: string | null;
  contentHash: string | null;
  provenance?: "research" | "human";
}

export type AcceptSourceOutcome = { status: "success"; source: Source } | { status: "error"; error: WorkflowFailure };

/** Turns an already-fetched (or human-supplied) candidate into a real,
 * audited `Source` -- the ONLY thing that makes it citable project
 * knowledge (P21's own boundary: neither `search()` nor `fetch()` ever
 * mints a `Source` by itself). */
export async function acceptResearchSource(runtime: ProjectRuntime, input: AcceptSourceInput): Promise<AcceptSourceOutcome> {
  const executed = await executeTool(runtime.registry, {
    toolName: "add_source",
    input: { ...input, reliability: null },
    source: "agent",
    target: null,
    authorize: autonomousAuthorizer(runtime)
  });
  if (executed.result.status === "error") {
    const message = executed.result.error?.message ?? "Could not record this source.";
    runtime.logActivity("note", "Could not record source", message);
    return { status: "error", error: { kind: executed.result.error?.kind ?? "add_source_failed", message } };
  }
  const source = executed.result.output as Source;
  runtime.logActivity("recommendation", "Source recorded", source.title);
  return { status: "success", source };
}

export interface AddEvidenceInput {
  sourceId: string;
  claim: string;
  excerpt?: string | null;
  confidence?: string | null;
  relevanceNote?: string | null;
  provenance?: "research" | "human";
}

export type AddEvidenceOutcome = { status: "success"; evidence: ResearchEvidence } | { status: "error"; error: WorkflowFailure };

export async function addResearchEvidence(runtime: ProjectRuntime, input: AddEvidenceInput): Promise<AddEvidenceOutcome> {
  const executed = await executeTool(runtime.registry, { toolName: "add_evidence", input, source: "agent", target: null, authorize: autonomousAuthorizer(runtime) });
  if (executed.result.status === "error") {
    const message = executed.result.error?.message ?? "Could not record this evidence.";
    runtime.logActivity("note", "Could not record evidence", message);
    return { status: "error", error: { kind: executed.result.error?.kind ?? "add_evidence_failed", message } };
  }
  const evidence = executed.result.output as ResearchEvidence;
  runtime.logActivity("recommendation", "Evidence recorded", evidence.claim);
  return { status: "success", evidence };
}

export interface AddMemoryInput {
  kind: MemoryKind;
  title: string;
  content: string;
  references: MemoryReferencesInput | null;
}

export type AddMemoryOutcome = { status: "success"; memory: MemoryRecord } | { status: "error"; error: WorkflowFailure };

/** A human explicitly recording something worth remembering -- always
 * `provenanceKind: "user_statement"` here (an agent-synthesized memory
 * would use a different provenanceKind, a capability this pass doesn't
 * add -- see the final report's "remaining limitations"). */
export async function addMemoryRecord(runtime: ProjectRuntime, input: AddMemoryInput): Promise<AddMemoryOutcome> {
  const executed = await executeTool(runtime.registry, {
    toolName: "memory_add",
    input: { ...input, provenanceKind: "user_statement", provenance: "human" },
    source: "human",
    target: null,
    authorize: autonomousAuthorizer(runtime)
  });
  if (executed.result.status === "error") {
    const message = executed.result.error?.message ?? "Could not record this memory.";
    runtime.logActivity("note", "Could not record memory", message);
    return { status: "error", error: { kind: executed.result.error?.kind ?? "memory_add_failed", message } };
  }
  const memory = (executed.result.output as { memory: MemoryRecord }).memory;
  runtime.logActivity("recommendation", "Memory recorded", memory.title);
  return { status: "success", memory };
}
