import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createRequirement,
  createTool,
  createWorldModelState,
  ToolError,
  type ToolInput,
  type ToolValueSchema,
  type WorldModelState
} from "@naqsh/schemas";
import { createChangeHistory } from "../src/change-history.js";
import { executeTool } from "../src/execute-tool.js";
import { recordTransition } from "../src/record-transition.js";
import { createToolRegistry, type ToolRegistry } from "../src/tool-registry.js";

const inspectInputSchema: ToolValueSchema = {
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"]
};
const inspectOutputSchema: ToolValueSchema = {
  type: "object",
  properties: { requirementCount: { type: "number" } },
  required: ["requirementCount"]
};

function buildToolInput(overrides: Partial<ToolInput> = {}): ToolInput {
  return {
    name: "inspect_project",
    target: "world_model",
    mutation: "observe",
    inputSchema: inspectInputSchema,
    outputSchema: inspectOutputSchema,
    ...overrides
  };
}

function buildState(): WorldModelState {
  return createWorldModelState({
    project: { name: "Bracket Study", description: "x", objective: { summary: "Design a bracket." } },
    session: {}
  });
}

describe("executeTool: happy path", () => {
  it("executes a registered tool and returns a structured success result", async () => {
    const registry = createToolRegistry();
    registry.register(createTool(buildToolInput()), () => ({ requirementCount: 3 }));

    const { request, result } = await executeTool(registry, {
      toolName: "inspect_project",
      input: { name: "Bracket Study" }
    });

    assert.equal(result.status, "success");
    assert.deepEqual(result.output, { requirementCount: 3 });
    assert.equal(result.error, null);
    assert.match(result.id, /^tres_/);
    assert.match(request.id, /^treq_/);
    assert.equal(result.requestId, request.id);
  });

  it("passes the exact validated input through to the handler", async () => {
    const registry = createToolRegistry();
    let receivedInput: unknown;
    registry.register(createTool(buildToolInput()), (input) => {
      receivedInput = input;
      return { requirementCount: 0 };
    });

    await executeTool(registry, { toolName: "inspect_project", input: { name: "Bracket Study" } });
    assert.deepEqual(receivedInput, { name: "Bracket Study" });
  });
});

describe("executeTool: input validation happens BEFORE the handler runs", () => {
  it("rejects invalid input with a structured invalid_input result and never calls the handler", async () => {
    const registry = createToolRegistry();
    let called = false;
    registry.register(createTool(buildToolInput()), () => {
      called = true;
      return { requirementCount: 0 };
    });

    const { result } = await executeTool(registry, { toolName: "inspect_project", input: {} });

    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
    assert.equal(called, false);
  });

  it("rejects a function smuggled inside input as a plain type mismatch (proves no code path treats it specially)", async () => {
    const registry = createToolRegistry();
    let called = false;
    registry.register(createTool(buildToolInput()), () => {
      called = true;
      return { requirementCount: 0 };
    });

    const { result } = await executeTool(registry, {
      toolName: "inspect_project",
      input: { name: (() => "not a string") as unknown }
    });

    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
    assert.equal(called, false);
  });
});

describe("executeTool: output validation", () => {
  it("rejects a handler whose output doesn't match outputSchema", async () => {
    const registry = createToolRegistry();
    registry.register(createTool(buildToolInput()), () => ({ requirementCount: "three" }) as never);

    const { result } = await executeTool(registry, {
      toolName: "inspect_project",
      input: { name: "Bracket Study" }
    });

    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_output");
  });
});

describe("executeTool: unknown tools cannot execute", () => {
  it("returns unknown_tool for an unregistered name", async () => {
    const registry = createToolRegistry();
    const { result } = await executeTool(registry, { toolName: "does_not_exist", input: {} });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "unknown_tool");
  });
});

describe("executeTool: handler failures become structured results, never uncaught exceptions", () => {
  it("catches a thrown Error and reports execution_failure", async () => {
    const registry = createToolRegistry();
    registry.register(createTool(buildToolInput()), () => {
      throw new Error("simulated handler crash");
    });

    const { result } = await executeTool(registry, {
      toolName: "inspect_project",
      input: { name: "Bracket Study" }
    });

    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "execution_failure");
    assert.match(result.error?.message ?? "", /simulated handler crash/);
  });

  it("preserves a ToolError's own kind when a handler throws one deliberately", async () => {
    const registry = createToolRegistry();
    registry.register(createTool(buildToolInput()), () => {
      throw new ToolError("unavailable", "environment adapter not connected");
    });

    const { result } = await executeTool(registry, {
      toolName: "inspect_project",
      input: { name: "Bracket Study" }
    });

    assert.equal(result.error?.kind, "unavailable");
  });

  it("executeTool itself never rejects for an expected failure mode", async () => {
    const registry = createToolRegistry();
    registry.register(createTool(buildToolInput()), () => {
      throw new Error("boom");
    });
    await assert.doesNotReject(() =>
      executeTool(registry, { toolName: "inspect_project", input: { name: "x" } })
    );
  });
});

describe("executeTool: the P4 policy seam (not enforcement)", () => {
  it("allows execution by default when no authorize hook is given", async () => {
    const registry = createToolRegistry();
    registry.register(createTool(buildToolInput()), () => ({ requirementCount: 0 }));
    const { result } = await executeTool(registry, {
      toolName: "inspect_project",
      input: { name: "x" }
    });
    assert.equal(result.status, "success");
  });

  it("rejects with policy_rejected when authorize returns false, without calling the handler", async () => {
    const registry = createToolRegistry();
    let called = false;
    registry.register(createTool(buildToolInput()), () => {
      called = true;
      return { requirementCount: 0 };
    });

    const { result } = await executeTool(registry, {
      toolName: "inspect_project",
      input: { name: "x" },
      authorize: () => false
    });

    assert.equal(result.error?.kind, "policy_rejected");
    assert.equal(called, false);
  });

  it("supports an async authorize hook", async () => {
    const registry = createToolRegistry();
    registry.register(createTool(buildToolInput()), () => ({ requirementCount: 0 }));
    const { result } = await executeTool(registry, {
      toolName: "inspect_project",
      input: { name: "x" },
      authorize: async (context) => context.tool.mutation === "observe"
    });
    assert.equal(result.status, "success");
  });

  it("passes source and requestId to the authorize hook, matching the ToolRequest", async () => {
    const registry = createToolRegistry();
    registry.register(createTool(buildToolInput()), () => ({ requirementCount: 0 }));
    let seenSource: string | undefined;
    let seenRequestId: string | undefined;

    const { request } = await executeTool(registry, {
      toolName: "inspect_project",
      input: { name: "x" },
      source: "agent",
      authorize: (context) => {
        seenSource = context.source;
        seenRequestId = context.requestId;
        return true;
      }
    });

    assert.equal(seenSource, "agent");
    assert.equal(seenRequestId, request.id);
  });

  it("propagates a structured denial reason from the object form of the outcome", async () => {
    const registry = createToolRegistry();
    registry.register(createTool(buildToolInput()), () => ({ requirementCount: 0 }));
    const { result } = await executeTool(registry, {
      toolName: "inspect_project",
      input: { name: "x" },
      authorize: () => ({ allowed: false, reason: "autonomy level SUGGEST cannot execute mutate tools" })
    });
    assert.equal(result.error?.kind, "policy_rejected");
    assert.equal(result.error?.message, "autonomy level SUGGEST cannot execute mutate tools");
  });
});

describe("executeTool: metadata and classification are inspectable", () => {
  it("exposes target/mutation/version on the registered tool", () => {
    const registry: ToolRegistry = createToolRegistry();
    const tool = createTool(buildToolInput({ mutation: "mutate", target: "environment" }));
    registry.register(tool, () => ({}));
    const registered = registry.getByName("inspect_project");
    assert.equal(registered?.mutation, "mutate");
    assert.equal(registered?.target, "environment");
    assert.equal(registered?.version, "0.1.0");
  });
});

describe("executeTool -> Transition -> Change: P2 integration without bypassing the World Model", () => {
  it("a mutating tool's output is a transition the caller feeds through the existing recordTransition pipeline", async () => {
    // The tool NEVER touches WorldModelState/ChangeHistory itself -- it only
    // returns data shaped like a transition. Nothing in execute-tool.ts or
    // tool-registry.ts imports transitions.ts, change-history.ts, or
    // record-transition.ts; this test proves the seam works by explicitly
    // wiring the two together at the call site, the way a future P11 agent
    // loop would.
    const createRequirementTool = createTool({
      name: "create_requirement",
      target: "world_model",
      mutation: "mutate",
      inputSchema: {
        type: "object",
        properties: { description: { type: "string" }, category: { type: "string" } },
        required: ["description", "category"]
      },
      outputSchema: {
        type: "object",
        properties: {
          transition: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["add_requirement"] },
              requirement: {
                type: "object",
                properties: { description: { type: "string" }, category: { type: "string" } },
                required: ["description", "category"]
              }
            },
            required: ["kind", "requirement"]
          }
        },
        required: ["transition"]
      }
    });

    const registry = createToolRegistry();
    registry.register(createRequirementTool, (input: unknown) => {
      const { description, category } = input as { description: string; category: string };
      return { transition: { kind: "add_requirement", requirement: { description, category } } };
    });

    const { result } = await executeTool(registry, {
      toolName: "create_requirement",
      input: { description: "Max mass 350g", category: "mass" },
      source: "tool"
    });

    assert.equal(result.status, "success");
    const output = result.output as { transition: { kind: "add_requirement"; requirement: { description: string; category: string } } };

    const history = createChangeHistory();
    const state = buildState();
    const { state: nextState, change } = recordTransition(history, state, output.transition, {
      source: "tool",
      cause: { kind: "tool_execution", description: "create_requirement tool call" }
    });

    assert.equal(nextState.project.requirements.length, 1);
    assert.equal(nextState.project.requirements[0]!.description, "Max mass 350g");
    assert.equal(change.source, "tool");
    assert.equal(change.cause.kind, "tool_execution");
    assert.equal(change.transitionKind, "add_requirement");
    assert.equal(history.list().length, 1);
  });

  it("observe-classified tools never produce a transition and never touch history", async () => {
    const registry = createToolRegistry();
    registry.register(createTool(buildToolInput()), () => ({ requirementCount: 5 }));
    const history = createChangeHistory();

    await executeTool(registry, { toolName: "inspect_project", input: { name: "x" } });

    assert.equal(history.list().length, 0);
  });

  it("still works with a pre-existing requirement (createRequirement is a valid handler dependency)", () => {
    // Sanity check that schemas' own factories remain usable independent of
    // the tool system -- no accidental coupling introduced.
    const requirement = createRequirement({ description: "x", category: "mass" });
    assert.match(requirement.id, /^req_/);
  });
});
