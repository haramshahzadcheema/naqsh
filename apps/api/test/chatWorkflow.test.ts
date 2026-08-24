import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModelProvider } from "@naqsh/model-providers";
import type { ModelProvider } from "@naqsh/core";
import { initializeWorldModel } from "@naqsh/core";
import type { ModelRequest } from "@naqsh/schemas";
import { createConversationRepository, createFileRepository, createMessageRepository, createProjectRepository, type ConversationRepository, type ProjectRepository, type ProjectRecord } from "../src/db/repositories.js";
import { discardProjectRuntime, getOrCreateProjectRuntime, type ProjectRuntime } from "../src/projectRuntime.js";
import { sendChatMessage, regenerateChatReply } from "../src/chatWorkflow.js";

/**
 * `sendChatMessage`'s own decision tree (exploration-intent branch checked
 * BEFORE design-intent, both checked before falling through to a plain
 * chat reply) had no direct test -- only its two branches' underlying
 * functions (`prepareExploration`/`generateProjectPlan`) and the trigger
 * regexes (`workflowEvents.test.ts`) were covered independently. This
 * closes that gap by exercising the actual dispatch function itself,
 * mirroring `engineeringWorkflow.test.ts`'s exact fakeProvider/runtimeFor
 * harness.
 */

const config = { modelId: "fake-v1" };

function schemaHasProperty(schema: unknown, key: string): boolean {
  if (!schema || typeof schema !== "object") return false;
  const props = (schema as { properties?: Record<string, unknown> }).properties;
  return !!props && key in props;
}

function extractFirstObjectId(instruction: string): string | null {
  const match = /objectId: "([^"]+)"/.exec(instruction);
  return match ? match[1]! : null;
}

function fakeProvider(): ModelProvider {
  return createMockModelProvider({
    respond: (request: ModelRequest) => {
      const schema = request.outputSchema;

      if (schemaHasProperty(schema, "steps")) {
        return {
          response: {
            kind: "structured_result",
            structuredResult: {
              steps: [
                {
                  id: "step_1",
                  title: "Reduce bracket thickness",
                  description: "Reduce the seed bracket's thickness while keeping it within load limits.",
                  purpose: "Meet the lightweight objective.",
                  dependsOn: [],
                  inputs: ["current geometry"],
                  expectedOutputs: ["updated thickness"],
                  relevantRequirementIds: [],
                  relevantConstraintIds: [],
                  relevantObjectIds: (() => {
                    const objectId = extractFirstObjectId(request.instruction);
                    return objectId ? [objectId] : [];
                  })(),
                  relevantDecisionIds: [],
                  verificationIntent: "Thickness matches the requested value.",
                  assumptionRefs: []
                }
              ],
              assumptions: [],
              unresolvedQuestions: [],
              risks: [{ id: "risk_1", description: "Reduced thickness may reduce strength margin.", impact: "Could fail load requirement.", severity: "medium" }],
              additionalMissingInformation: []
            }
          }
        };
      }

      if (schemaHasProperty(schema, "toolName")) {
        const match = /objectId: "([^"]+)"/.exec(request.instruction);
        const objectId = match ? match[1]! : "unknown_object";
        return {
          response: {
            kind: "structured_result",
            structuredResult: {
              toolName: "modify_environment_object",
              input: { objectId, propertyKey: "thicknessMm", value: 4 },
              target: { entityType: "object", entityId: objectId },
              rationale: "Reducing thickness saves mass.",
              expectedEffect: "thicknessMm becomes 4.",
              relevantRequirementIds: [],
              relevantConstraintIds: []
            }
          }
        };
      }

      if (schemaHasProperty(schema, "manufacturingIntent")) {
        const variationMatch = /variation (\d+) of (\d+)/.exec(request.instruction);
        const label = variationMatch ? `variation ${variationMatch[1]}` : "single design";
        return {
          response: {
            kind: "structured_result",
            structuredResult: {
              description: `Ribbed mounting plate (${label}).`,
              components: [{ id: "plate", name: "Mounting plate", type: "plate", geometryIntent: `Rectangular plate, ${label}.`, dimensions: { length: 100, width: 60 }, parentComponentId: null }],
              relationships: [],
              parameters: {},
              material: "6061 aluminum",
              manufacturingIntent: "CNC machined from bar stock.",
              relevantRequirementIds: [],
              relevantConstraintIds: [],
              expectedOutputs: [{ id: "out_plate", componentId: "plate", environmentObjectType: "part", environmentGenericType: "solid", properties: {} }]
            }
          }
        };
      }

      if (schemaHasProperty(schema, "interpretationStatus")) {
        // Only a statement with a concrete number is treated as a real,
        // specific requirement -- a bare trigger phrase like "Make it
        // lighter."/"Design this." (no measurable target) is honestly
        // ambiguous (a real interpreter shouldn't invent a number out of
        // nothing), so it produces a Clarification, never a fabricated
        // Requirement. This is what lets these tests exercise the
        // "no requirements yet" guard using the exact SAME trigger text a
        // real chat message would use, without a requirement silently
        // appearing as a side effect of the trigger phrase itself.
        if (/\d/.test(request.instruction)) {
          return {
            response: {
              kind: "structured_result",
              structuredResult: { description: "Must support a 50 kg load.", category: "structural", interpretationStatus: "specific", operator: "gte", value: 50, unit: "kg", ambiguityReason: null }
            }
          };
        }
        return {
          response: {
            kind: "structured_result",
            structuredResult: { description: "Unclear.", category: "structural", interpretationStatus: "ambiguous", operator: null, value: null, unit: null, ambiguityReason: "No specific, measurable target was stated." }
          }
        };
      }

      return { response: { kind: "text", text: "Acknowledged." } };
    }
  });
}

function createProject(projects: ProjectRepository, name: string): ProjectRecord {
  const worldModelState = initializeWorldModel({ name, description: "", objective: { summary: `Design a lightweight ${name}.` } });
  const now = new Date().toISOString();
  const record: ProjectRecord = { id: worldModelState.project.id, name, createdAt: now, updatedAt: now, worldModelState };
  projects.save(record);
  return record;
}

describe("sendChatMessage: exploration-intent, design-intent, and plain-chat dispatch", () => {
  let dataDir: string;
  let projects: ProjectRepository;
  let conversations: ConversationRepository;
  let messages: ReturnType<typeof createMessageRepository>;
  let files: ReturnType<typeof createFileRepository>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "naqsh-chatworkflow-test-"));
    projects = createProjectRepository(dataDir);
    conversations = createConversationRepository(dataDir);
    messages = createMessageRepository(dataDir);
    files = createFileRepository(dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function runtimeFor(record: ProjectRecord): ProjectRuntime {
    discardProjectRuntime(record.id);
    return getOrCreateProjectRuntime(record.id, projects, "mock_cad");
  }

  it("'make it lighter' (no requirements yet) is caught by the exploration branch, not the plain-chat fallback", async () => {
    const record = createProject(projects, "Bracket A");
    const runtime = runtimeFor(record);
    const provider = fakeProvider();
    const conversation = conversations.save({ id: "conv_1", projectId: record.id, title: "t", createdAt: "t0", updatedAt: "t0" });

    const result = await sendChatMessage({ conversation, project: record, runtime, provider, modelId: config.modelId, style: "balanced", text: "Make it lighter.", fileIds: [], messages, files });

    assert.equal(result.assistantMessage.text, "I don't have enough information yet -- tell me the requirements (load, dimensions, material, etc.) before I explore alternatives.");
    assert.equal(result.workflowEvents.length, 0, "no plan/proposal/exploration event -- the guard fires before anything is generated");
  });

  it("'make it lighter' with real requirements and a real plan produces a real exploration_prepared event, not a plain chat reply", async () => {
    const record = createProject(projects, "Bracket B");
    const runtime = runtimeFor(record);
    const provider = fakeProvider();
    const conversation = conversations.save({ id: "conv_2", projectId: record.id, title: "t", createdAt: "t0", updatedAt: "t0" });

    await sendChatMessage({ conversation, project: record, runtime, provider, modelId: config.modelId, style: "balanced", text: "The bracket must support a 50 kg load.", fileIds: [], messages, files });
    const { generateProjectPlan } = await import("../src/engineeringWorkflow.js");
    await generateProjectPlan(runtime, provider, config);

    const result = await sendChatMessage({ conversation, project: record, runtime, provider, modelId: config.modelId, style: "balanced", text: "Make it lighter.", fileIds: [], messages, files });

    assert.equal(result.workflowEvents.length, 1);
    const event = result.workflowEvents[0]!;
    assert.equal(event.kind, "exploration_prepared");
    if (event.kind !== "exploration_prepared") return;
    assert.equal(event.candidates.length, 3, "parseExplorationCount defaults to 3");
    assert.equal(event.pendingApprovals.length, 4);
    assert.ok(event.pendingApprovals.every((approval) => approval.status === "pending"));
    assert.match(result.assistantMessage.text, /3 alternative designs/);
  });

  it("'design this' still reaches the design-intent branch (plan+proposal), not exploration -- the two triggers never both fire for the same text", async () => {
    const record = createProject(projects, "Bracket C");
    const runtime = runtimeFor(record);
    const provider = fakeProvider();
    const conversation = conversations.save({ id: "conv_3", projectId: record.id, title: "t", createdAt: "t0", updatedAt: "t0" });

    await sendChatMessage({ conversation, project: record, runtime, provider, modelId: config.modelId, style: "balanced", text: "The bracket must support a 50 kg load.", fileIds: [], messages, files });
    const result = await sendChatMessage({ conversation, project: record, runtime, provider, modelId: config.modelId, style: "balanced", text: "Design this.", fileIds: [], messages, files });

    assert.equal(result.workflowEvents.length, 2);
    assert.deepEqual(
      result.workflowEvents.map((e) => e.kind),
      ["plan_created", "proposal_created"]
    );
  });

  it("ordinary conversational text never triggers either workflow -- falls through to a real plain chat reply", async () => {
    const record = createProject(projects, "Bracket D");
    const runtime = runtimeFor(record);
    const provider = fakeProvider();
    const conversation = conversations.save({ id: "conv_4", projectId: record.id, title: "t", createdAt: "t0", updatedAt: "t0" });

    const result = await sendChatMessage({ conversation, project: record, runtime, provider, modelId: config.modelId, style: "balanced", text: "What's the current mass?", fileIds: [], messages, files });

    assert.equal(result.workflowEvents.length, 0);
    assert.equal(result.assistantMessage.text, "Acknowledged.");
  });
});

describe("regenerateChatReply: refuses to re-run a design/exploration-workflow turn", () => {
  let dataDir: string;
  let projects: ProjectRepository;
  let conversations: ConversationRepository;
  let messages: ReturnType<typeof createMessageRepository>;
  let files: ReturnType<typeof createFileRepository>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "naqsh-chatworkflow-regen-test-"));
    projects = createProjectRepository(dataDir);
    conversations = createConversationRepository(dataDir);
    messages = createMessageRepository(dataDir);
    files = createFileRepository(dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function runtimeFor(record: ProjectRecord): ProjectRuntime {
    discardProjectRuntime(record.id);
    return getOrCreateProjectRuntime(record.id, projects, "mock_cad");
  }

  it("refuses to regenerate a reply whose preceding user message carried exploration intent", async () => {
    const record = createProject(projects, "Bracket E");
    const runtime = runtimeFor(record);
    const provider = fakeProvider();
    const conversation = conversations.save({ id: "conv_5", projectId: record.id, title: "t", createdAt: "t0", updatedAt: "t0" });

    await sendChatMessage({ conversation, project: record, runtime, provider, modelId: config.modelId, style: "balanced", text: "The bracket must support a 50 kg load.", fileIds: [], messages, files });
    const explorationResult = await sendChatMessage({ conversation, project: record, runtime, provider, modelId: config.modelId, style: "balanced", text: "Make it lighter.", fileIds: [], messages, files });

    const outcome = await regenerateChatReply({ conversation, runtime, provider, modelId: config.modelId, style: "balanced", messages, targetMessageId: explorationResult.assistantMessage.id });
    assert.equal(outcome.status, "error");
    if (outcome.status !== "error") return;
    assert.equal(outcome.error.kind, "unsupported");
  });
});

describe("sendChatMessage: real project memory reaches the model -- not a decorative store", () => {
  let dataDir: string;
  let projects: ProjectRepository;
  let conversations: ConversationRepository;
  let messages: ReturnType<typeof createMessageRepository>;
  let files: ReturnType<typeof createFileRepository>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "naqsh-chatworkflow-memory-test-"));
    projects = createProjectRepository(dataDir);
    conversations = createConversationRepository(dataDir);
    messages = createMessageRepository(dataDir);
    files = createFileRepository(dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function runtimeFor(record: ProjectRecord): ProjectRuntime {
    discardProjectRuntime(record.id);
    return getOrCreateProjectRuntime(record.id, projects, "mock_cad");
  }

  it("a real MemoryRecord's content appears in the actual instruction sent to the model for a plain chat reply", async () => {
    const { createMemoryRecord } = await import("@naqsh/schemas");
    const record = createProject(projects, "Bracket M");
    const runtime = runtimeFor(record);
    const conversation = conversations.save({ id: "conv_mem", projectId: record.id, title: "t", createdAt: "t0", updatedAt: "t0" });

    runtime.memory.save(
      createMemoryRecord({
        projectId: record.id,
        projectVersion: 1,
        kind: "decision",
        title: "Steel rejected",
        content: "Steel was evaluated but rejected because mass exceeded the 2kg budget.",
        provenanceKind: "user_statement"
      })
    );

    let capturedInstruction: string | null = null;
    const capturingProvider: ModelProvider = createMockModelProvider({
      respond: (request: ModelRequest) => {
        if (request.outputSchema === null) capturedInstruction = request.instruction;
        return { response: { kind: "text", text: "Acknowledged." } };
      }
    });

    await sendChatMessage({ conversation, project: record, runtime, provider: capturingProvider, modelId: config.modelId, style: "balanced", text: "What material should we use?", fileIds: [], messages, files });

    assert.ok(capturedInstruction, "the plain-chat-reply branch must have been reached");
    assert.match(capturedInstruction!, /Steel rejected/);
    assert.match(capturedInstruction!, /Steel was evaluated but rejected because mass exceeded the 2kg budget\./);
  });
});
