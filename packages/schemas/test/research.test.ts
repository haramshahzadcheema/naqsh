import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createEntityRelationship,
  createProject,
  createResearchEvidence,
  createResearchFetchContent,
  createResearchFetchInvocationResult,
  createResearchFetchRequest,
  createResearchProviderDescriptor,
  createResearchRequest,
  createResearchSearchInvocationResult,
  createResearchSearchRequest,
  createResearchSourceCandidate,
  createSource,
  deserializeResearchEvidence,
  deserializeResearchRequest,
  deserializeSource,
  MAX_RESEARCH_EVIDENCE_EXCERPT_LENGTH,
  serializeResearchEvidence,
  serializeResearchRequest,
  serializeSource,
  WorldModelValidationError,
  type ResearchEvidenceInput,
  type ResearchRequestInput,
  type SourceInput
} from "../src/index.js";

function sourceInput(overrides: Partial<SourceInput> = {}): SourceInput {
  return {
    locator: "https://example.com/datasheet-6061-t6.pdf",
    title: "6061-T6 Aluminum Datasheet",
    publisher: "Acme Metals",
    sourceType: "datasheet",
    ...overrides
  };
}

function evidenceInput(sourceId: string, overrides: Partial<ResearchEvidenceInput> = {}): ResearchEvidenceInput {
  return {
    sourceId,
    claim: "6061-T6 aluminum has a yield strength of approximately 276 MPa.",
    excerpt: "Typical yield strength: 276 MPa (40 ksi).",
    ...overrides
  };
}

function requestInput(overrides: Partial<ResearchRequestInput> = {}): ResearchRequestInput {
  return {
    projectId: "proj_1",
    projectVersion: 1,
    query: "6061-T6 aluminum yield strength",
    purpose: "Find the manufacturer-stated yield strength for material X to evaluate requirement R-14.",
    ...overrides
  };
}

describe("Source: creation and validation", () => {
  it("creates a valid source with defaults", () => {
    const source = createSource(sourceInput());
    assert.equal(source.status, "active");
    assert.equal(source.reliability, "unknown");
    assert.equal(source.source, "research");
    assert.ok(source.id.length > 0);
    assert.ok(source.retrievedAt.length > 0);
  });

  it("is frozen (immutable) after creation", () => {
    const source = createSource(sourceInput());
    assert.throws(() => {
      (source as { title: string }).title = "tampered";
    });
  });

  it("rejects an empty title", () => {
    assert.throws(() => createSource(sourceInput({ title: "" })), WorldModelValidationError);
  });

  it("rejects an invalid sourceType", () => {
    assert.throws(() => createSource({ ...sourceInput(), sourceType: "not_a_real_type" as never }), WorldModelValidationError);
  });

  it("rejects an invalid reliability", () => {
    assert.throws(() => createSource({ ...sourceInput(), reliability: "extremely_high" as never }), WorldModelValidationError);
  });

  it("accepts a null locator -- a source need not have a fetchable address", () => {
    const source = createSource(sourceInput({ locator: null }));
    assert.equal(source.locator, null);
  });

  it("serialization round-trips", () => {
    const source = createSource(sourceInput());
    const restored = deserializeSource(serializeSource(source));
    assert.deepEqual(restored, source);
  });

  it("rejects corrupted JSON on deserialize", () => {
    assert.throws(() => deserializeSource("{not json"), SyntaxError);
  });

  it("rejects a well-formed but invalid object on deserialize", () => {
    assert.throws(() => deserializeSource(JSON.stringify({ not: "a source" })), WorldModelValidationError);
  });
});

describe("ResearchEvidence: creation and validation", () => {
  it("creates valid evidence referencing a source, with defaults", () => {
    const source = createSource(sourceInput());
    const evidence = createResearchEvidence(evidenceInput(source.id));
    assert.equal(evidence.sourceId, source.id);
    assert.equal(evidence.status, "active");
    assert.equal(evidence.confidence, "medium");
    assert.equal(evidence.source, "research");
  });

  it("rejects an empty claim -- evidence with no claim is not evidence of anything", () => {
    assert.throws(() => createResearchEvidence(evidenceInput("src_1", { claim: "" })), WorldModelValidationError);
  });

  it("rejects an excerpt exceeding MAX_RESEARCH_EVIDENCE_EXCERPT_LENGTH -- never store a giant document in the World Model", () => {
    const tooLong = "x".repeat(MAX_RESEARCH_EVIDENCE_EXCERPT_LENGTH + 1);
    assert.throws(() => createResearchEvidence(evidenceInput("src_1", { excerpt: tooLong })), WorldModelValidationError);
  });

  it("accepts an excerpt at exactly the bound", () => {
    const atBound = "x".repeat(MAX_RESEARCH_EVIDENCE_EXCERPT_LENGTH);
    const evidence = createResearchEvidence(evidenceInput("src_1", { excerpt: atBound }));
    assert.equal(evidence.excerpt!.length, MAX_RESEARCH_EVIDENCE_EXCERPT_LENGTH);
  });

  it("accepts a null excerpt -- a claim may be recorded without a pasted quote", () => {
    const evidence = createResearchEvidence(evidenceInput("src_1", { excerpt: null }));
    assert.equal(evidence.excerpt, null);
  });

  it("rejects an invalid confidence", () => {
    assert.throws(() => createResearchEvidence(evidenceInput("src_1", { confidence: "extreme" as never })), WorldModelValidationError);
  });

  it("serialization round-trips", () => {
    const evidence = createResearchEvidence(evidenceInput("src_1"));
    const restored = deserializeResearchEvidence(serializeResearchEvidence(evidence));
    assert.deepEqual(restored, evidence);
  });

  it("rejects corrupted JSON on deserialize", () => {
    assert.throws(() => deserializeResearchEvidence("{not json"), SyntaxError);
  });
});

describe("ResearchRequest: creation and validation", () => {
  it("creates a valid request with defaults", () => {
    const request = createResearchRequest(requestInput());
    assert.equal(request.status, "pending");
    assert.equal(request.maxResults, 5);
    assert.equal(request.relatedPlanId, null);
    assert.equal(request.relatedPlanStepId, null);
    assert.deepEqual(request.relatedRequirementIds, []);
    assert.deepEqual(request.preferredSourceTypes, []);
  });

  it("rejects an empty query", () => {
    assert.throws(() => createResearchRequest(requestInput({ query: "" })), WorldModelValidationError);
  });

  it("rejects an empty purpose -- research must explain WHY, not just what to search for", () => {
    assert.throws(() => createResearchRequest(requestInput({ purpose: "" })), WorldModelValidationError);
  });

  it("rejects a non-positive maxResults", () => {
    assert.throws(() => createResearchRequest(requestInput({ maxResults: 0 })), WorldModelValidationError);
  });

  it("accepts a related plan/planStep pair when a research request supports a specific plan step", () => {
    const request = createResearchRequest(requestInput({ relatedPlanId: "plan_1", relatedPlanStepId: "step_1" }));
    assert.equal(request.relatedPlanId, "plan_1");
    assert.equal(request.relatedPlanStepId, "step_1");
  });

  it("serialization round-trips", () => {
    const request = createResearchRequest(requestInput());
    const restored = deserializeResearchRequest(serializeResearchRequest(request));
    assert.deepEqual(restored, request);
  });

  it("rejects corrupted JSON on deserialize", () => {
    assert.throws(() => deserializeResearchRequest("{not json"), SyntaxError);
  });
});

describe("Project: sources/researchEvidence are real Project state", () => {
  it("a fresh project starts with empty sources/researchEvidence arrays", () => {
    const project = createProject({ name: "Bracket Study" });
    assert.deepEqual(project.sources, []);
    assert.deepEqual(project.researchEvidence, []);
  });

  it("accepts sources/researchEvidence provided at construction", () => {
    const project = createProject({
      name: "Bracket Study",
      sources: [sourceInput()],
      researchEvidence: [evidenceInput("src_1")]
    });
    assert.equal(project.sources.length, 1);
    assert.equal(project.researchEvidence.length, 1);
  });
});

describe("Traceability: evidence -> requirement/decision reuses the EXISTING EntityRelationship mechanism (P8), never a second system", () => {
  it("an EntityRelationship can link research_evidence to a requirement", () => {
    const relationship = createEntityRelationship({
      type: "supports",
      sourceType: "research_evidence",
      sourceId: "evid_1",
      targetType: "requirement",
      targetId: "req_1"
    });
    assert.equal(relationship.sourceType, "research_evidence");
    assert.equal(relationship.targetType, "requirement");
  });

  it("an EntityRelationship can link a source to a decision", () => {
    const relationship = createEntityRelationship({
      type: "cited_by",
      sourceType: "source",
      sourceId: "src_1",
      targetType: "decision",
      targetId: "dec_1"
    });
    assert.equal(relationship.sourceType, "source");
    assert.equal(relationship.targetType, "decision");
  });
});

describe("ResearchProvider wire contract: shape validation (mirrors ModelRequest/ModelResponse/ModelInvocationResult, P7)", () => {
  it("creates a valid descriptor/search request/fetch request", () => {
    const descriptor = createResearchProviderDescriptor({ providerId: "mock", name: "Mock Research Provider", version: "0.0.1" });
    assert.equal(descriptor.providerId, "mock");
    const searchRequest = createResearchSearchRequest({ query: "6061-T6 yield strength" });
    assert.equal(searchRequest.maxResults, 5);
    const fetchRequest = createResearchFetchRequest({ locator: "https://example.com/datasheet.pdf" });
    assert.equal(fetchRequest.locator, "https://example.com/datasheet.pdf");
  });

  it("rejects an oversized candidate snippet -- untrusted provider output is bounded at the boundary", () => {
    const tooLong = "x".repeat(MAX_RESEARCH_EVIDENCE_EXCERPT_LENGTH + 1);
    assert.throws(
      () => createResearchSourceCandidate({ title: "x", sourceType: "web_page", snippet: tooLong }),
      WorldModelValidationError
    );
  });

  it("rejects an oversized fetch excerpt", () => {
    const tooLong = "x".repeat(MAX_RESEARCH_EVIDENCE_EXCERPT_LENGTH + 1);
    assert.throws(
      () => createResearchFetchContent({ locator: "https://example.com/x", title: "x", sourceType: "web_page", excerpt: tooLong }),
      WorldModelValidationError
    );
  });

  it("a success search invocation result requires results non-null and error null", () => {
    const result = createResearchSearchInvocationResult({
      requestId: "req_1",
      providerId: "mock",
      status: "success",
      results: [createResearchSourceCandidate({ title: "Datasheet", sourceType: "datasheet", snippet: "Yield: 276 MPa" })],
      startedAt: new Date().toISOString()
    });
    assert.equal(result.results!.length, 1);
    assert.equal(result.error, null);
  });

  it("an error search invocation result requires results null and error set", () => {
    const result = createResearchSearchInvocationResult({
      requestId: "req_1",
      providerId: "mock",
      status: "error",
      error: { kind: "provider_unavailable", message: "simulated outage" },
      startedAt: new Date().toISOString()
    });
    assert.equal(result.results, null);
    assert.equal(result.error!.kind, "provider_unavailable");
  });

  it("rejects a hand-constructed disagreement: status success but results null", () => {
    assert.throws(
      () =>
        createResearchSearchInvocationResult({
          requestId: "req_1",
          providerId: "mock",
          status: "success",
          results: null as never,
          startedAt: new Date().toISOString()
        }),
      WorldModelValidationError
    );
  });

  it("a success fetch invocation result requires content non-null and error null", () => {
    const result = createResearchFetchInvocationResult({
      requestId: "req_1",
      providerId: "mock",
      status: "success",
      content: createResearchFetchContent({ locator: "https://example.com/x", title: "Datasheet", sourceType: "datasheet", excerpt: "Yield: 276 MPa" }),
      startedAt: new Date().toISOString()
    });
    assert.equal(result.content!.title, "Datasheet");
  });
});
