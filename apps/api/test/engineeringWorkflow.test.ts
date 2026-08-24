import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModelProvider } from "@naqsh/model-providers";
import type { ModelProvider } from "@naqsh/core";
import { initializeWorldModel } from "@naqsh/core";
import type { ModelRequest } from "@naqsh/schemas";
import { createProjectRepository, type ProjectRepository, type ProjectRecord } from "../src/db/repositories.js";
import { discardProjectRuntime, getOrCreateProjectRuntime, captureRequirementFromStatement, type EnvironmentKind, type ProjectRuntime } from "../src/projectRuntime.js";
import {
  approveProposal,
  executeProposal,
  generateProjectCandidates,
  generateProjectPlan,
  generateProjectProposal,
  prepareExploration,
  rejectProposal,
  rollbackToCheckpoint,
  verifyExistingCheck
} from "../src/engineeringWorkflow.js";
import { getBackgroundJob, submitBackgroundJob } from "../src/jobsWorkflow.js";

const config = { modelId: "fake-v1" };

function schemaHasProperty(schema: unknown, key: string): boolean {
  if (!schema || typeof schema !== "object") return false;
  const props = (schema as { properties?: Record<string, unknown> }).properties;
  return !!props && key in props;
}

/** Pulls the first real `objectId: "..."` out of the environment-context
 * text `generateProjectProposal` injects (see engineeringWorkflow.ts's
 * `describeEnvironmentForModel`) -- simulates a real model actually
 * reading the environment context it was given, rather than hardcoding a
 * guessed id in the test. */
function extractFirstObjectId(instruction: string): string | null {
  const match = /objectId: "([^"]+)"/.exec(instruction);
  return match ? match[1]! : null;
}

/** Picks a real, writable property to propose changing, from the SAME
 * environment-context text `describeEnvironmentForModel` injects --
 * mock_cad's seed object happens to have "thicknessMm"; mock_simulation's
 * seed objects don't (they have setpointN/toleranceN/targetPositionMm
 * instead), so a fake model hardcoding "thicknessMm" for every environment
 * would try to set a property that doesn't exist there and genuinely fail
 * (the in-memory adapter correctly rejects unknown properties). Simulating
 * a real model actually reading what's writable, per environment. */
function pickProposalTarget(instruction: string): { objectId: string; propertyKey: string; value: unknown } {
  const lineRegex = /objectId: "([^"]+)", name: "[^"]*", type: "[^"]*", properties: (\[.*\])/g;
  let match: RegExpExecArray | null;
  while ((match = lineRegex.exec(instruction))) {
    const objectId = match[1]!;
    let properties: Array<{ key: string; value: unknown; readOnly: boolean }>;
    try {
      properties = JSON.parse(match[2]!);
    } catch {
      continue;
    }
    const thickness = properties.find((p) => p.key === "thicknessMm" && !p.readOnly);
    if (thickness) return { objectId, propertyKey: "thicknessMm", value: 4 };
    const writable = properties.find((p) => !p.readOnly);
    if (writable) {
      const value = typeof writable.value === "number" ? writable.value + 1 : "changed";
      return { objectId, propertyKey: writable.key, value };
    }
  }
  return { objectId: "unknown_object", propertyKey: "thicknessMm", value: 4 };
}

interface FakeProviderOverrides {
  proposalToolName?: string;
  malformedProposal?: boolean;
  /** Overrides the (default empty) `properties` bag on a generated
   * candidate's single `expectedOutput` -- lets a test that actually needs
   * a build to produce checkable properties (e.g. background-job
   * verification) do so without every other candidate-generation test
   * having to care. */
  candidateProperties?: Record<string, unknown>;
}

/** One fake ModelProvider that serves every structured-output shape this
 * workflow's real core functions request (plan, proposal, requirement
 * interpretation) plus plain chat text -- routed by inspecting the
 * REQUEST's own outputSchema, the same real dispatch a real Gemini
 * response would need to satisfy. Every response still goes through
 * `createMockModelProvider`'s real `validateStructuredResult` check (it's
 * the same production code path a live Gemini response goes through). */
function fakeProvider(overrides: FakeProviderOverrides = {}): ModelProvider {
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
                  relevantRequirementIds: request.context.requirementCount > 0 ? [] : [],
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
        if (overrides.malformedProposal) {
          // Missing required fields entirely -- proves malformed model
          // output is rejected, never silently repaired into a Proposal.
          return { response: { kind: "structured_result", structuredResult: { toolName: "modify_environment_object" } } };
        }
        const { objectId, propertyKey, value } = pickProposalTarget(request.instruction);
        return {
          response: {
            kind: "structured_result",
            structuredResult: {
              toolName: overrides.proposalToolName ?? "modify_environment_object",
              input: { objectId, propertyKey, value },
              target: { entityType: "object", entityId: objectId },
              rationale: "Reducing thickness saves mass while remaining above the minimum load-bearing thickness.",
              expectedEffect: "thicknessMm becomes 4.",
              relevantRequirementIds: [],
              relevantConstraintIds: []
            }
          }
        };
      }

      if (schemaHasProperty(schema, "manufacturingIntent")) {
        // A real model would read "variation N of M" from the instruction
        // (engineeringWorkflow.ts's `generateProjectCandidates` injects
        // exactly that per call) and produce a genuinely different design
        // per variation -- simulated here by echoing whatever variation
        // marker is present into the description, so a test can assert
        // two generated candidates are actually distinct, not copies.
        const variationMatch = /variation (\d+) of (\d+)/.exec(request.instruction);
        const label = variationMatch ? `variation ${variationMatch[1]}` : "single design";
        return {
          response: {
            kind: "structured_result",
            structuredResult: {
              description: `Ribbed mounting plate (${label}).`,
              components: [
                { id: "plate", name: "Mounting plate", type: "plate", geometryIntent: `Rectangular plate, ${label}.`, dimensions: { length: 100, width: 60 }, parentComponentId: null }
              ],
              relationships: [],
              parameters: {},
              material: "6061 aluminum",
              manufacturingIntent: "CNC machined from bar stock.",
              relevantRequirementIds: [],
              relevantConstraintIds: [],
              expectedOutputs: [{ id: "out_plate", componentId: "plate", environmentObjectType: "part", environmentGenericType: "solid", properties: overrides.candidateProperties ?? {} }]
            }
          }
        };
      }

      if (schemaHasProperty(schema, "interpretationStatus")) {
        // `answer_clarification` re-interprets a FOCUSED statement of the
        // shape "<question> Answer: <answerText>" (see
        // answer-clarification-tool.ts) -- dispatched here by that literal
        // "Answer:" marker, the same real instruction text a live Gemini
        // call would receive. "banana" simulates an answer that genuinely
        // doesn't resolve the ambiguity (P19's own "answer_insufficient"
        // case); anything else resolves it.
        if (request.instruction.includes("Answer:")) {
          if (/Answer:\s*banana/i.test(request.instruction)) {
            return {
              response: {
                kind: "structured_result",
                structuredResult: { description: "Still unclear.", category: "structural", interpretationStatus: "ambiguous", operator: null, value: null, unit: null, ambiguityReason: "The answer did not give a specific, usable load value." }
              }
            };
          }
          return {
            response: {
              kind: "structured_result",
              structuredResult: { description: "Must support 500 N vertically.", category: "structural", interpretationStatus: "specific", operator: "gte", value: 500, unit: "N", ambiguityReason: null }
            }
          };
        }
        // An ORIGINAL statement naming a load/strength topic with no
        // number attached genuinely matches P19's own `AMBIGUITY_TOPIC_RULES`
        // -- simulating a real Gemini call recognizing the same vagueness a
        // human would. Every OTHER original statement in this file's tests
        // states a concrete number, so this never fires for them.
        if (/\b(strong|load|withstand|support)\b/i.test(request.instruction) && !/\d/.test(request.instruction)) {
          return {
            response: {
              kind: "structured_result",
              structuredResult: { description: "The bracket must be strong.", category: "structural", interpretationStatus: "ambiguous", operator: null, value: null, unit: null, ambiguityReason: "No specific load or direction was stated." }
            }
          };
        }
        return {
          response: {
            kind: "structured_result",
            structuredResult: {
              description: "Must support a 50 kg load.",
              category: "structural",
              interpretationStatus: "specific",
              operator: "gte",
              value: 50,
              unit: "kg",
              ambiguityReason: null
            }
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

async function withRequirement(runtime: ProjectRuntime, provider: ModelProvider): Promise<void> {
  const outcome = await captureRequirementFromStatement(runtime, provider, "The bracket must support 50 kg.", config);
  assert.equal(outcome.kind, "requirement_added");
}

describe("engineering agent execution: real OBSERVE -> PLAN -> PROPOSE -> APPROVE -> EXECUTE -> VERIFY -> REPORT", () => {
  let dataDir: string;
  let projects: ProjectRepository;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "naqsh-workflow-test-"));
    projects = createProjectRepository(dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function runtimeFor(record: ProjectRecord, kind: EnvironmentKind = "mock_cad"): ProjectRuntime {
    discardProjectRuntime(record.id);
    return getOrCreateProjectRuntime(record.id, projects, kind);
  }

  it("1. requirement -> plan: a real requirement shapes the real observation a plan is generated from", async () => {
    const record = createProject(projects, "Bracket A");
    const runtime = runtimeFor(record);
    const provider = fakeProvider();
    await withRequirement(runtime, provider);

    const outcome = await generateProjectPlan(runtime, provider, config);
    assert.equal(outcome.status, "success");
    if (outcome.status !== "success") return;
    assert.equal(outcome.plan.steps.length, 1);
    assert.equal(runtime.plans.get(outcome.plan.id)?.id, outcome.plan.id);
  });

  it("2. plan -> proposal: a real Proposal is generated for a concrete plan step, referencing a real environment object", async () => {
    const record = createProject(projects, "Bracket B");
    const runtime = runtimeFor(record);
    const provider = fakeProvider();
    await withRequirement(runtime, provider);
    const plan = (await generateProjectPlan(runtime, provider, config)) as { status: "success"; plan: import("@naqsh/schemas").Plan };

    const outcome = await generateProjectProposal(runtime, provider, plan.plan.id, config);
    assert.equal(outcome.status, "success");
    if (outcome.status !== "success") return;
    assert.equal(outcome.proposal.toolName, "modify_environment_object");
    assert.notEqual((outcome.proposal.input as { objectId: string }).objectId, "unknown_object", "the proposal must target a REAL object the environment actually reported");
  });

  it("3. proposal -> approval: a real, pending Approval exists the moment a Proposal exists, and approving it is a real state transition", async () => {
    const record = createProject(projects, "Bracket C");
    const runtime = runtimeFor(record);
    const provider = fakeProvider();
    await withRequirement(runtime, provider);
    const plan = (await generateProjectPlan(runtime, provider, config)) as { status: "success"; plan: import("@naqsh/schemas").Plan };
    const proposed = (await generateProjectProposal(runtime, provider, plan.plan.id, config)) as { status: "success"; proposal: import("@naqsh/schemas").Proposal; approvalId: string };

    const pending = runtime.approvals.getById(proposed.approvalId);
    assert.equal(pending?.status, "pending");

    const decision = approveProposal(runtime, proposed.proposal.id);
    assert.equal(decision.status, "success");
    assert.equal(runtime.approvals.getById(proposed.approvalId)?.status, "approved");
  });

  it("4. a REJECTED proposal never executes", async () => {
    const record = createProject(projects, "Bracket D");
    const runtime = runtimeFor(record);
    const provider = fakeProvider();
    await withRequirement(runtime, provider);
    const plan = (await generateProjectPlan(runtime, provider, config)) as { status: "success"; plan: import("@naqsh/schemas").Plan };
    const proposed = (await generateProjectProposal(runtime, provider, plan.plan.id, config)) as { status: "success"; proposal: import("@naqsh/schemas").Proposal };

    rejectProposal(runtime, proposed.proposal.id);
    const executed = await executeProposal(runtime, proposed.proposal.id);
    // create_checkpoint itself doesn't need approval (mutation:"suggest"),
    // so the workflow call itself still reports "success" -- the mutating
    // step (modify_environment_object) is the one that's independently
    // re-authorized by executeTool and denied, exactly like test 6's
    // "never approved at all" case. A rejected Approval must never be
    // treated as equivalent to an approved one.
    assert.equal(executed.status, "success");
    if (executed.status !== "success") return;
    assert.equal(executed.report.execution.status, "failed", "a REJECTED proposal must never actually mutate the environment");
  });

  it("5. an APPROVED proposal genuinely executes -- real environment mutation, real checkpoint, real verification, real objective evaluation", async () => {
    const record = createProject(projects, "Bracket E");
    const runtime = runtimeFor(record);
    const provider = fakeProvider();
    await withRequirement(runtime, provider);
    const plan = (await generateProjectPlan(runtime, provider, config)) as { status: "success"; plan: import("@naqsh/schemas").Plan };
    const proposed = (await generateProjectProposal(runtime, provider, plan.plan.id, config)) as { status: "success"; proposal: import("@naqsh/schemas").Proposal };
    approveProposal(runtime, proposed.proposal.id);

    const executed = await executeProposal(runtime, proposed.proposal.id);
    assert.equal(executed.status, "success");
    if (executed.status !== "success") return;
    assert.equal(executed.report.execution.status, "success");
    assert.ok(executed.report.execution.checkpointId, "a checkpoint must have been created");
    assert.equal(executed.report.verification.status, "passed", "the property was actually set to the requested value, so deterministic verification must pass");
    assert.equal(executed.report.objective.status, "satisfied");

    // Genuinely persisted, queryable through the SAME `listForProject` path
    // `GET /projects/:id/objective-satisfaction` uses -- not just returned
    // once in the execution report and then lost.
    const persisted = runtime.objectiveSatisfactionStore.listForProject(record.id);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]!.id, executed.report.objective.result?.id);

    // The environment was genuinely mutated, not just reported as such.
    const session = runtime.getSession();
    assert.ok(session);
    const listed = await runtime.environmentAdapter.listObjects(session!);
    const objects = listed.data as Array<{ properties: Array<{ key: string; value: unknown }> }>;
    const thickness = objects[0]?.properties.find((p) => p.key === "thicknessMm");
    assert.equal(thickness?.value, 4);
  });

  it("5b. executeProposal persists a REAL AgentLoopRun (P11) via resumeAgentLoopRunAfterApproval -- not a second, competing execution mechanism", async () => {
    const record = createProject(projects, "Bracket E2");
    const runtime = runtimeFor(record);
    const provider = fakeProvider();
    await withRequirement(runtime, provider);
    const plan = (await generateProjectPlan(runtime, provider, config)) as { status: "success"; plan: import("@naqsh/schemas").Plan };
    const proposed = (await generateProjectProposal(runtime, provider, plan.plan.id, config)) as { status: "success"; proposal: import("@naqsh/schemas").Proposal };
    approveProposal(runtime, proposed.proposal.id);

    assert.equal(runtime.agentLoopRuns.listForProject(record.id).length, 0, "no run should exist before execution");

    const executed = await executeProposal(runtime, proposed.proposal.id);
    assert.equal(executed.status, "success");
    if (executed.status !== "success") return;

    const runs = runtime.agentLoopRuns.listForProject(record.id);
    assert.equal(runs.length, 1, "exactly one real AgentLoopRun must be persisted for this execution");
    const run = runs[0]!;
    assert.equal(run.status, "completed");
    assert.equal(run.proposal.id, proposed.proposal.id);
    assert.equal(run.plan.id, plan.plan.id);
    assert.equal(run.projectId, record.id);
    assert.ok(run.approval, "the run must carry the real, consumed Approval");
    assert.equal(run.approval!.status, "approved");
    assert.ok(run.approval!.consumedAt, "the approval must be marked consumed after a successful execution");
    assert.ok(run.executionResult, "a real ExecutionResult must be recorded");
    assert.equal(run.executionResult!.outcome, "succeeded");
    assert.ok(run.observationAfter, "a real post-execution ObservationResult must be recorded");
    assert.ok(run.discrepancy, "discrepancy detection must have run");
    assert.equal(run.discrepancy!.detected, false, "the property genuinely changed to the requested value -- no discrepancy");

    // The execution report's own discrepancy field must be the SAME real
    // object the persisted run carries, never a separately-computed copy.
    assert.deepEqual(executed.report.discrepancy, run.discrepancy);
  });

  it("6b. an execution never authorized (approval still pending) is mapped honestly, but also never persists a fabricated 'completed' AgentLoopRun", async () => {
    const record = createProject(projects, "Bracket F2");
    const runtime = runtimeFor(record);
    const provider = fakeProvider();
    await withRequirement(runtime, provider);
    const plan = (await generateProjectPlan(runtime, provider, config)) as { status: "success"; plan: import("@naqsh/schemas").Plan };
    const proposed = (await generateProjectProposal(runtime, provider, plan.plan.id, config)) as { status: "success"; proposal: import("@naqsh/schemas").Proposal };

    // Never approved.
    const executed = await executeProposal(runtime, proposed.proposal.id);
    assert.equal(executed.status, "success");
    if (executed.status !== "success") return;
    assert.equal(executed.report.execution.status, "failed");
    assert.equal(executed.report.discrepancy, null);

    // The "not_approved" path is a pre-execution denial resumeAgentLoopRunAfterApproval
    // reports as an orchestration-level error, BEFORE constructing any
    // terminal run -- so nothing is persisted here at all, never a run
    // dishonestly marked "completed"/"execution_failed" for something that
    // never actually reached executeTool.
    assert.equal(runtime.agentLoopRuns.listForProject(record.id).length, 0);
  });

  it("6. execution with NO approval at all fails -- a frontend can never substitute a bare boolean for real authorization", async () => {
    const record = createProject(projects, "Bracket F");
    const runtime = runtimeFor(record);
    const provider = fakeProvider();
    await withRequirement(runtime, provider);
    const plan = (await generateProjectPlan(runtime, provider, config)) as { status: "success"; plan: import("@naqsh/schemas").Plan };
    const proposed = (await generateProjectProposal(runtime, provider, plan.plan.id, config)) as { status: "success"; proposal: import("@naqsh/schemas").Proposal };

    // Never approved.
    const executed = await executeProposal(runtime, proposed.proposal.id);
    assert.equal(executed.status, "success");
    if (executed.status !== "success") return;
    assert.equal(executed.report.execution.status, "failed", "executeTool's own authorize hook must independently deny this -- checkpoint creation itself doesn't need approval, but the mutating modify_environment_object call does, and it's not approved");
  });

  it("7. a STALE proposal (project changed since it was generated) is refused, never executed", async () => {
    const record = createProject(projects, "Bracket G");
    const runtime = runtimeFor(record);
    const provider = fakeProvider();
    await withRequirement(runtime, provider);
    const plan = (await generateProjectPlan(runtime, provider, config)) as { status: "success"; plan: import("@naqsh/schemas").Plan };
    const proposed = (await generateProjectProposal(runtime, provider, plan.plan.id, config)) as { status: "success"; proposal: import("@naqsh/schemas").Proposal };
    approveProposal(runtime, proposed.proposal.id);

    // The project changes AFTER the proposal was generated (a second real
    // requirement capture bumps project.version).
    await captureRequirementFromStatement(runtime, provider, "The bracket must also fit within a 100mm envelope.", config);

    const executed = await executeProposal(runtime, proposed.proposal.id);
    assert.equal(executed.status, "error");
    if (executed.status === "error") assert.equal(executed.error.kind, "proposal_stale");
  });

  it("9/10. verification is deterministic and independent of any model claim -- and objective satisfaction is a SEPARATE verdict from execution success", async () => {
    const record = createProject(projects, "Bracket H");
    const runtime = runtimeFor(record);
    await ensureConnected(runtime);
    const session = runtime.getSession()!;
    const listed = await runtime.environmentAdapter.listObjects(session);
    const objectId = (listed.data as Array<{ id: string }>)[0]!.id;

    // Define a check asserting something that is DEFINITELY false.
    const { executeTool, createExecuteToolAuthorizer } = await import("@naqsh/core");
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "approved_modify", approvals: runtime.approvals, autonomyGrants: runtime.autonomyGrants });
    const checkExec = await executeTool(runtime.registry, {
      toolName: "create_check",
      input: { kind: "numeric_comparison", description: "thickness is 999 (false)", objectId, property: "thicknessMm", operator: "eq", expectedValue: 999 },
      source: "agent",
      target: null,
      authorize
    });
    assert.equal(checkExec.result.status, "success");
    const check = (checkExec.result.output as { check: { id: string } }).check;

    const verified = await verifyExistingCheck(runtime, check.id);
    assert.equal(verified.status, "success");
    if (verified.status === "success") {
      assert.equal(verified.result.status, "fail", "verification must report FAIL when reality doesn't match -- never rewritten to look like success");
    }
  });

  it("11. rollback genuinely restores prior state through the real checkpoint mechanism", async () => {
    const record = createProject(projects, "Bracket I");
    const runtime = runtimeFor(record);
    const provider = fakeProvider();
    await withRequirement(runtime, provider);
    const plan = (await generateProjectPlan(runtime, provider, config)) as { status: "success"; plan: import("@naqsh/schemas").Plan };
    const proposed = (await generateProjectProposal(runtime, provider, plan.plan.id, config)) as { status: "success"; proposal: import("@naqsh/schemas").Proposal };
    approveProposal(runtime, proposed.proposal.id);
    const executed = await executeProposal(runtime, proposed.proposal.id);
    assert.equal(executed.status, "success");
    if (executed.status !== "success") return;
    const checkpointId = executed.report.execution.checkpointId!;

    const rolledBack = await rollbackToCheckpoint(runtime, checkpointId, "test rollback");
    assert.equal(rolledBack.status, "success");

    const session = runtime.getSession()!;
    const listed = await runtime.environmentAdapter.listObjects(session);
    const objects = listed.data as Array<{ properties: Array<{ key: string; value: unknown }> }>;
    const thickness = objects[0]?.properties.find((p) => p.key === "thicknessMm");
    assert.equal(thickness?.value, 6, "rollback must restore the ORIGINAL thickness (6), undoing the execution's change to 4");
  });

  it("12. a proposal generated in project A cannot be executed against project B's runtime", async () => {
    const recordA = createProject(projects, "Project A");
    const recordB = createProject(projects, "Project B");
    const runtimeA = runtimeFor(recordA);
    const runtimeB = runtimeFor(recordB);
    const provider = fakeProvider();
    await withRequirement(runtimeA, provider);
    const plan = (await generateProjectPlan(runtimeA, provider, config)) as { status: "success"; plan: import("@naqsh/schemas").Plan };
    const proposed = (await generateProjectProposal(runtimeA, provider, plan.plan.id, config)) as { status: "success"; proposal: import("@naqsh/schemas").Proposal };
    approveProposal(runtimeA, proposed.proposal.id);

    // runtimeB has never heard of this proposal.
    const executed = await executeProposal(runtimeB, proposed.proposal.id);
    assert.equal(executed.status, "error");
    if (executed.status === "error") assert.equal(executed.error.kind, "proposal_not_found");
  });

  it("13. a checkpoint captured in project A cannot be restored against project B", async () => {
    const recordA = createProject(projects, "Project A2");
    const recordB = createProject(projects, "Project B2");
    const runtimeA = runtimeFor(recordA);
    const runtimeB = runtimeFor(recordB);
    const provider = fakeProvider();
    await withRequirement(runtimeA, provider);
    const plan = (await generateProjectPlan(runtimeA, provider, config)) as { status: "success"; plan: import("@naqsh/schemas").Plan };
    const proposed = (await generateProjectProposal(runtimeA, provider, plan.plan.id, config)) as { status: "success"; proposal: import("@naqsh/schemas").Proposal };
    approveProposal(runtimeA, proposed.proposal.id);
    const executed = await executeProposal(runtimeA, proposed.proposal.id);
    assert.equal(executed.status, "success");
    if (executed.status !== "success") return;

    // runtimeB has its own, entirely separate CheckpointStore (one per
    // project runtime, matching `proposals`' own per-runtime isolation in
    // test 12) -- it never saw project A's checkpoint at all, so lookup
    // fails before the projectId check would even run. Same real-world
    // guarantee (project B can never restore project A's checkpoint), same
    // "look up in the correct runtime's own store" isolation mechanism.
    const rolledBack = await rollbackToCheckpoint(runtimeB, executed.report.execution.checkpointId!, "cross-project attempt");
    assert.equal(rolledBack.status, "error");
    if (rolledBack.status === "error") assert.equal(rolledBack.error?.kind, "checkpoint_not_found");
  });

  it("15. malformed model output for a proposal is rejected -- no Proposal is ever created, nothing is stored", async () => {
    const record = createProject(projects, "Bracket J");
    const runtime = runtimeFor(record);
    const provider = fakeProvider({ malformedProposal: true });
    await withRequirement(runtime, provider);
    const plan = (await generateProjectPlan(runtime, provider, config)) as { status: "success"; plan: import("@naqsh/schemas").Plan };

    const outcome = await generateProjectProposal(runtime, provider, plan.plan.id, config);
    assert.equal(outcome.status, "error");
    assert.equal(runtime.proposals.size, 0);
  });

  it("16. the model cannot invent an undeclared tool -- proposing a nonexistent tool name is rejected by semantic validation", async () => {
    const record = createProject(projects, "Bracket K");
    const runtime = runtimeFor(record);
    const provider = fakeProvider({ proposalToolName: "delete_everything_unregistered" });
    await withRequirement(runtime, provider);
    const plan = (await generateProjectPlan(runtime, provider, config)) as { status: "success"; plan: import("@naqsh/schemas").Plan };

    const outcome = await generateProjectProposal(runtime, provider, plan.plan.id, config);
    assert.equal(outcome.status, "error");
    assert.equal(runtime.proposals.size, 0);
  });

  it("17. full end-to-end workflow against the mock CAD environment", async () => {
    const record = createProject(projects, "CAD End To End");
    const runtime = runtimeFor(record, "mock_cad");
    const provider = fakeProvider();
    await withRequirement(runtime, provider);
    const plan = (await generateProjectPlan(runtime, provider, config)) as { status: "success"; plan: import("@naqsh/schemas").Plan };
    const proposed = (await generateProjectProposal(runtime, provider, plan.plan.id, config)) as { status: "success"; proposal: import("@naqsh/schemas").Proposal };
    approveProposal(runtime, proposed.proposal.id);
    const executed = await executeProposal(runtime, proposed.proposal.id);
    assert.equal(executed.status, "success");
    if (executed.status !== "success") return;
    assert.equal(executed.report.execution.status, "success");
    assert.equal(executed.report.verification.status, "passed");
    assert.equal(executed.report.objective.status, "satisfied");
    assert.ok(runtime.activity.length > 0);
  });

  it("18. full end-to-end workflow against the mock simulation environment", async () => {
    const record = createProject(projects, "Simulation End To End");
    const runtime = runtimeFor(record, "mock_simulation");
    const provider = fakeProvider();
    await withRequirement(runtime, provider);
    const plan = (await generateProjectPlan(runtime, provider, config)) as { status: "success"; plan: import("@naqsh/schemas").Plan };
    const proposed = (await generateProjectProposal(runtime, provider, plan.plan.id, config)) as { status: "success"; proposal: import("@naqsh/schemas").Proposal };
    approveProposal(runtime, proposed.proposal.id);
    const executed = await executeProposal(runtime, proposed.proposal.id);
    assert.equal(executed.status, "success");
    if (executed.status !== "success") return;
    assert.equal(executed.report.execution.status, "success", "mock_simulation supports modify+checkpoint, so this real mutation must succeed");
  });

  it("19. plan -> candidates: N genuinely different design alternatives are generated, saved, and turned into real Candidates", async () => {
    const record = createProject(projects, "Candidate Generation Project");
    const runtime = runtimeFor(record);
    const provider = fakeProvider();
    await withRequirement(runtime, provider);
    const plan = (await generateProjectPlan(runtime, provider, config)) as { status: "success"; plan: import("@naqsh/schemas").Plan };

    const outcome = await generateProjectCandidates(runtime, provider, plan.plan.id, plan.plan.steps[0]!.id, 3, config);
    assert.equal(outcome.status, "success");
    if (outcome.status !== "success") return;

    assert.equal(outcome.candidates.length, 3);
    assert.equal(outcome.failures.length, 0);

    // Every design must genuinely differ (proves the per-iteration
    // "variation N of M" instruction actually reached the model, not
    // just that three IDENTICAL designs got three different ids).
    const descriptions = new Set(outcome.candidates.map((c) => c.designSpecification.description));
    assert.equal(descriptions.size, 3, "each generated design must be genuinely distinct, not a copy");

    for (const { designSpecification, candidate } of outcome.candidates) {
      assert.equal(runtime.designSpecificationStore.getById(designSpecification.id)?.id, designSpecification.id, "each design must actually be persisted");
      assert.equal(candidate.designSpecificationId, designSpecification.id, "each candidate must link back to its own design");
      assert.equal(candidate.planId, plan.plan.id);
      assert.equal(candidate.status, "proposed");
    }
    // All three real, distinct Candidates must be independently listable.
    assert.equal(runtime.candidateStore.listForPlan(plan.plan.id).length, 3);
  });

  it("20. candidate generation against an unknown plan is refused honestly, never silently succeeding with nothing generated", async () => {
    const record = createProject(projects, "Unknown Plan Candidates");
    const runtime = runtimeFor(record);
    const provider = fakeProvider();

    const outcome = await generateProjectCandidates(runtime, provider, "plan_does_not_exist", "step_1", 2, config);
    assert.equal(outcome.status, "error");
    if (outcome.status !== "error") return;
    assert.equal(outcome.error.kind, "plan_not_found");
  });

  it("21. candidate generation against an unknown plan step is refused honestly", async () => {
    const record = createProject(projects, "Unknown Step Candidates");
    const runtime = runtimeFor(record);
    const provider = fakeProvider();
    await withRequirement(runtime, provider);
    const plan = (await generateProjectPlan(runtime, provider, config)) as { status: "success"; plan: import("@naqsh/schemas").Plan };

    const outcome = await generateProjectCandidates(runtime, provider, plan.plan.id, "step_does_not_exist", 2, config);
    assert.equal(outcome.status, "error");
    if (outcome.status !== "error") return;
    assert.equal(outcome.error.kind, "unknown_plan_step");
  });

  it("22. the deterministic mock model honestly fails candidate generation rather than fabricating a design -- proven with the REAL deterministic provider, not the test's own fake one", async () => {
    const { resolveModelProvider } = await import("../src/modelProviderFactory.js");
    const record = createProject(projects, "Deterministic Candidates");
    const runtime = runtimeFor(record);
    const fake = fakeProvider();
    await withRequirement(runtime, fake);
    const plan = (await generateProjectPlan(runtime, fake, config)) as { status: "success"; plan: import("@naqsh/schemas").Plan };

    const resolved = resolveModelProvider("deterministic");
    assert.ok(!("error" in resolved));
    if ("error" in resolved) return;
    const outcome = await generateProjectCandidates(runtime, resolved.provider, plan.plan.id, plan.plan.steps[0]!.id, 2, { modelId: resolved.modelId });
    assert.equal(outcome.status, "error", "the deterministic provider cannot produce schema-valid structured design output -- this must fail honestly, not fabricate a candidate");
  });

  it("22b. candidates -> background job: submitBackgroundJob wires a REAL verifyCandidate hook, end-to-end", async () => {
    const record = createProject(projects, "Exploration Job Project");
    const runtime = runtimeFor(record);
    const provider = fakeProvider({ candidateProperties: { mass: 3 } });
    await withRequirement(runtime, provider);
    const plan = (await generateProjectPlan(runtime, provider, config)) as { status: "success"; plan: import("@naqsh/schemas").Plan };

    const generated = await generateProjectCandidates(runtime, provider, plan.plan.id, plan.plan.steps[0]!.id, 2, config);
    assert.equal(generated.status, "success");
    if (generated.status !== "success") return;
    const candidateIds = generated.candidates.map((c) => c.candidate.id);

    // submitBackgroundJob's own submission authorizer is fixed at
    // "approved_modify" (see jobsWorkflow.ts's approvedModifyAuthorizer) --
    // submit_background_job's OWN ceiling check refuses a job requesting
    // "autonomous" (a job can never carry more authority than its creator),
    // so a job submitted through this path always runs its candidates at
    // "approved_modify", which means every "mutate"-classified tool call
    // inside runBackgroundJob is authorized by a real, approved Approval
    // (authorization.ts: only autonomyLevel==="autonomous" consults
    // AutonomyGrant) -- never a grant. Approvals here are never auto-
    // consumed by the runner (only executeProposal does that, explicitly),
    // so one broad approval per tool covers every candidate in the job.
    const allowedTools = ["create_checkpoint", "add_experiment", "update_experiment", "create_environment_object", "restore_checkpoint", "create_check", "run_verification"];
    for (const toolName of ["add_experiment", "update_experiment", "create_environment_object", "restore_checkpoint"]) {
      const approval = runtime.approvals.create({ toolName, targetType: null, targetId: null, proposalId: null, reason: "test: exploration job", requestedBy: "agent" });
      runtime.approvals.approve(approval.id, "human");
    }

    const submitted = await submitBackgroundJob(runtime, {
      objective: "Explore alternatives for the bracket plate.",
      candidateIds,
      autonomyLevel: "approved_modify",
      allowedTools,
      budget: { maxIterations: 10, maxDurationMs: 30_000, maxToolCalls: 100, maxModelCalls: 10, maxCandidates: 10 }
    });
    assert.equal(submitted.status, "success");
    if (submitted.status !== "success") return;

    let final = submitted.job;
    for (let attempt = 0; attempt < 100 && !["completed", "failed", "cancelled"].includes(final.status); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const fetched = await getBackgroundJob(runtime, submitted.job.id);
      assert.equal(fetched.status, "success");
      if (fetched.status !== "success") return;
      final = fetched.job;
    }

    assert.equal(final.status, "completed");
    assert.ok(final.result, "a terminal job must carry a real JobResult");
    assert.equal(final.result!.candidateResults.length, 2);
    for (const candidateResult of final.result!.candidateResults) {
      assert.equal(candidateResult.outcome, "evaluated");
      assert.equal(candidateResult.rolledBack, false, "submitBackgroundJob deliberately leaves rollbackAfterEachCandidate at its default -- see jobsWorkflow.ts's doc comment on why restore_checkpoint reverting the World Model too would erase the Experiment records this whole flow exists to produce");
      assert.ok(candidateResult.verificationResultIds.length > 0, "submitBackgroundJob must wire a real verifyCandidate hook -- an empty array here would mean the wiring regressed to build-only");
      for (const verificationResultId of candidateResult.verificationResultIds) {
        const stored = runtime.verificationResultStore.getById(verificationResultId);
        assert.ok(stored, "every verificationResultId on the job result must resolve to a REAL, persisted VerificationResult");
        assert.equal(stored!.status, "pass", "the candidate's build actually set mass:3, so a numeric_comparison check against it must pass");
      }
      // The real Experiment record (not just this job's own bookkeeping)
      // must carry the same ids -- compareCandidates (used by the frontend
      // comparison view) reads verification data exclusively off
      // Experiment.verificationResultIds. This only holds because rollback
      // is OFF for this job -- see the assertion above.
      assert.ok(candidateResult.experimentId);
      const experiment = runtime.getState().project.experiments.find((e) => e.id === candidateResult.experimentId);
      assert.ok(experiment, "the candidate's experiment must exist in the current project's World Model state");
      assert.deepEqual(experiment!.verificationResultIds, candidateResult.verificationResultIds);
    }

    // Both candidates' real environment mutations survive (no rollback) --
    // exactly the "genuinely comparable, independent objects" outcome this
    // job is FOR.
    assert.equal(runtime.getState().project.experiments.length, 2);
  });

  it("23. an ambiguous statement produces a real, persisted Clarification -- never a transient in-memory-only signal", async () => {
    const record = createProject(projects, "Clarification Bracket");
    const runtime = runtimeFor(record);
    const provider = fakeProvider();

    const outcome = await captureRequirementFromStatement(runtime, provider, "The bracket must be strong.", config);
    assert.equal(outcome.kind, "clarification_needed");
    if (outcome.kind !== "clarification_needed") return;
    assert.equal(outcome.clarifications.length, 1);
    assert.equal(outcome.clarifications[0]!.status, "pending");
    assert.equal(outcome.clarifications[0]!.category, "missing_threshold");

    // Really persisted in the store, not just returned once.
    assert.equal(runtime.clarificationStore.list().length, 1);
    assert.equal(runtime.clarificationStore.getById(outcome.clarifications[0]!.id)?.id, outcome.clarifications[0]!.id);
    assert.equal(record.worldModelState.project.requirements.length, 0, "no Requirement should exist yet -- the candidate is still unresolved");
  });

  it("24. answering a clarification with a sufficient answer resolves it and records a real Requirement -- traceable back to the original statement", async () => {
    const { answerClarification } = await import("../src/projectRuntime.js");
    const record = createProject(projects, "Clarification Answer Bracket");
    const runtime = runtimeFor(record);
    const provider = fakeProvider();

    const captured = await captureRequirementFromStatement(runtime, provider, "The bracket must be strong.", config);
    assert.equal(captured.kind, "clarification_needed");
    if (captured.kind !== "clarification_needed") return;
    const clarificationId = captured.clarifications[0]!.id;

    const answered = await answerClarification(runtime, provider, clarificationId, "500 N vertically", "fake-v1");
    assert.equal(answered.kind, "answered");
    if (answered.kind !== "answered") return;
    assert.equal(answered.clarification.status, "answered");
    assert.equal(answered.clarification.answerText, "500 N vertically");
    assert.equal(answered.outcome.kind, "requirement_added");
    if (answered.outcome.kind !== "requirement_added") return;
    assert.equal(answered.outcome.requirement.value, 500);
    assert.equal(answered.outcome.requirement.metadata.resolvedClarificationId, clarificationId);

    // The store itself reflects the resolution, not just this call's return value.
    assert.equal(runtime.clarificationStore.getById(clarificationId)?.status, "answered");
  });

  it("25. an insufficient answer is rejected, leaves the Clarification pending, and never fabricates a Requirement", async () => {
    const { answerClarification, dismissClarification } = await import("../src/projectRuntime.js");
    const record = createProject(projects, "Clarification Rejection Bracket");
    const runtime = runtimeFor(record);
    const provider = fakeProvider();

    const captured = await captureRequirementFromStatement(runtime, provider, "The bracket must be strong.", config);
    assert.equal(captured.kind, "clarification_needed");
    if (captured.kind !== "clarification_needed") return;
    const clarificationId = captured.clarifications[0]!.id;

    const rejected = await answerClarification(runtime, provider, clarificationId, "banana", "fake-v1");
    assert.equal(rejected.kind, "answer_rejected");
    assert.equal(runtime.clarificationStore.getById(clarificationId)?.status, "pending", "an insufficient answer must never be recorded as resolving the clarification");
    assert.equal(record.worldModelState.project.requirements.length, 0);

    // Dismissal (the OTHER real resolution path) genuinely works too.
    const dismissed = await dismissClarification(runtime, clarificationId, "Not needed for this iteration.");
    assert.equal(dismissed.status, "success");
    if (dismissed.status !== "success") return;
    assert.equal(dismissed.clarification.status, "dismissed");
    assert.equal(runtime.clarificationStore.getById(clarificationId)?.status, "dismissed");
  });

  it("26. prepareExploration: real candidates paired with real, PENDING (never auto-approved) Approval records", async () => {
    const record = createProject(projects, "Exploration Prep Project");
    const runtime = runtimeFor(record);
    const provider = fakeProvider();
    await withRequirement(runtime, provider);
    await generateProjectPlan(runtime, provider, config);

    const outcome = await prepareExploration(runtime, provider, config, 2);
    assert.equal(outcome.status, "success");
    if (outcome.status !== "success") return;
    const { exploration } = outcome;

    assert.equal(exploration.candidates.length, 2);
    assert.equal(exploration.failures.length, 0);
    assert.equal(exploration.pendingApprovals.length, 4, "one Approval per EXPLORATION_MUTATE_TOOLS entry");
    assert.deepEqual(
      exploration.pendingApprovals.map((a) => a.toolName).sort(),
      ["add_experiment", "create_environment_object", "modify_environment_object", "update_experiment"]
    );
    for (const approval of exploration.pendingApprovals) {
      assert.equal(approval.status, "pending", "prepareExploration must never auto-approve -- a human decides via the generic approval routes");
      // Independently confirm the store agrees -- not just the returned object.
      assert.equal(runtime.approvals.getById(approval.id)?.status, "pending");
    }
    assert.ok(exploration.allowedTools.includes("create_environment_object"));
    assert.ok(exploration.allowedTools.includes("create_check"));
  });

  it("27. prepareExploration refuses honestly when there's no plan yet -- never fabricates one or explores against nothing", async () => {
    const record = createProject(projects, "No Plan Exploration Project");
    const runtime = runtimeFor(record);
    const provider = fakeProvider();
    await withRequirement(runtime, provider);

    const outcome = await prepareExploration(runtime, provider, config, 2);
    assert.equal(outcome.status, "error");
    if (outcome.status !== "error") return;
    assert.equal(outcome.error.kind, "no_plan");
    assert.equal(runtime.approvals.list().length, 0, "no approval should be requested when exploration never actually started");
  });

  it("28. prepareExploration targets the MOST RECENTLY created plan when several exist", async () => {
    const record = createProject(projects, "Multiple Plans Exploration Project");
    const runtime = runtimeFor(record);
    const provider = fakeProvider();
    await withRequirement(runtime, provider);
    await generateProjectPlan(runtime, provider, config);
    // A tiny real delay so the second plan's createdAt is strictly later --
    // otherwise two plans generated back-to-back could tie at
    // millisecond resolution, making "most recent" ambiguous.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const secondPlan = (await generateProjectPlan(runtime, provider, config)) as { status: "success"; plan: import("@naqsh/schemas").Plan };
    assert.equal(secondPlan.status, "success");

    const outcome = await prepareExploration(runtime, provider, config, 1);
    assert.equal(outcome.status, "success");
    if (outcome.status !== "success") return;
    assert.equal(outcome.exploration.planId, secondPlan.plan.id);
  });

  it("29. real project memory reaches the model for BOTH plan and proposal generation -- not a decorative store", async () => {
    const { createMemoryRecord } = await import("@naqsh/schemas");
    const record = createProject(projects, "Memory Reaches Plan Project");
    const runtime = runtimeFor(record);
    const seedProvider = fakeProvider();
    await withRequirement(runtime, seedProvider);

    runtime.memory.save(
      createMemoryRecord({
        projectId: record.id,
        projectVersion: runtime.getState().project.version,
        kind: "decision",
        title: "Aluminum selected over steel",
        content: "6061 aluminum was chosen over steel because steel exceeded the mass budget in an earlier iteration.",
        provenanceKind: "user_statement"
      })
    );

    // Route every call through the SAME structured responses fakeProvider
    // already produces (so plan/proposal generation still succeeds), while
    // independently capturing the real instruction text sent for each call.
    const capturedInstructions: string[] = [];
    const memoryAwareProvider: ModelProvider = {
      ...seedProvider,
      generate: async (request: ModelRequest) => {
        capturedInstructions.push(request.instruction);
        return seedProvider.generate(request);
      }
    };

    const plan = (await generateProjectPlan(runtime, memoryAwareProvider, config)) as { status: "success"; plan: import("@naqsh/schemas").Plan };
    assert.equal(plan.status, "success");
    const proposed = await generateProjectProposal(runtime, memoryAwareProvider, plan.plan.id, config);
    assert.equal(proposed.status, "success");

    assert.ok(capturedInstructions.length >= 2, "both plan and proposal generation must have made a real model call");
    for (const instruction of capturedInstructions) {
      assert.match(instruction, /Aluminum selected over steel/, "every reasoning call must carry real project memory in its instruction");
      assert.match(instruction, /6061 aluminum was chosen over steel because steel exceeded the mass budget in an earlier iteration\./);
    }
  });
});

async function ensureConnected(runtime: ProjectRuntime): Promise<void> {
  const { ensureEnvironmentSession } = await import("../src/projectRuntime.js");
  await ensureEnvironmentSession(runtime);
}
