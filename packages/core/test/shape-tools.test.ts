import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBooleanEnvironmentObjectTool, createFilletEnvironmentObjectTool } from "../src/shape-environment-object-tool.js";
import type { EnvironmentAdapter } from "../src/environment-adapter.js";
import type { EnvironmentSession } from "@naqsh/schemas";

/**
 * These tools exist because the agent's entire environment surface was
 * create + modify: Naqsh could place a box and a cylinder but could never
 * subtract one from the other, so a wheel arch was unreachable from
 * inside the product.
 */
const session = { id: "sess_1" } as EnvironmentSession;
const getSession = () => session;

function fakeObject(id: string, type: string): unknown {
  return { id, type, name: id, properties: [], relationships: [], metadata: {} };
}

describe("shaping tools", () => {
  it("boolean_environment_object passes a real cut through to the adapter", async () => {
    const calls: unknown[] = [];
    const adapter = {
      booleanObject: async (_s: EnvironmentSession, input: unknown) => {
        calls.push(input);
        return { status: "success", data: fakeObject("Body_Cut", "Part::Cut") };
      }
    } as unknown as EnvironmentAdapter;

    const { tool, handler } = createBooleanEnvironmentObjectTool(getSession, adapter);
    assert.equal(tool.name, "boolean_environment_object");
    assert.equal(tool.target, "environment");
    assert.equal(tool.mutation, "mutate");

    const result = (await handler({ kind: "cut", baseId: "Body", toolId: "Arch", name: "BodyWithArch" })) as { object: { type: string } };
    assert.equal(result.object.type, "Part::Cut");
    assert.deepEqual(calls[0], { kind: "cut", baseId: "Body", toolId: "Arch", name: "BodyWithArch" });
  });

  it("fillet_environment_object passes a real radius through", async () => {
    const calls: unknown[] = [];
    const adapter = {
      filletObject: async (_s: EnvironmentSession, input: unknown) => {
        calls.push(input);
        return { status: "success", data: fakeObject("Rounded", "Part::Fillet") };
      }
    } as unknown as EnvironmentAdapter;

    const { handler } = createFilletEnvironmentObjectTool(getSession, adapter);
    const result = (await handler({ objectId: "Body", radius: 15 })) as { object: { type: string } };
    assert.equal(result.object.type, "Part::Fillet");
    assert.deepEqual(calls[0], { objectId: "Body", radius: 15, name: undefined });
  });

  it("reports honestly when the connected environment cannot shape at all -- never a silent no-op", async () => {
    const plainAdapter = {} as unknown as EnvironmentAdapter;
    const { handler: booleanHandler } = createBooleanEnvironmentObjectTool(getSession, plainAdapter);
    await assert.rejects(async () => { await booleanHandler({ kind: "cut", baseId: "a", toolId: "b" }); }, /does not support boolean/i);

    const { handler: filletHandler } = createFilletEnvironmentObjectTool(getSession, plainAdapter);
    await assert.rejects(async () => { await filletHandler({ objectId: "a", radius: 5 }); }, /does not support fillets/i);
  });

  it("surfaces the adapter's real error rather than swallowing it", async () => {
    const adapter = {
      booleanObject: async () => ({ status: "error", error: { message: 'The "cut" produced no valid solid' } })
    } as unknown as EnvironmentAdapter;
    const { handler } = createBooleanEnvironmentObjectTool(getSession, adapter);
    await assert.rejects(async () => { await handler({ kind: "cut", baseId: "a", toolId: "b" }); }, /no valid solid/);
  });

  it("rejects malformed input before touching the environment", async () => {
    const adapter = { booleanObject: async () => ({ status: "success", data: fakeObject("x", "Part::Cut") }) } as unknown as EnvironmentAdapter;
    const { handler } = createBooleanEnvironmentObjectTool(getSession, adapter);
    await assert.rejects(async () => { await handler({ kind: "cut", baseId: "", toolId: "b" }); }, /baseId/);

    const filletAdapter = { filletObject: async () => ({ status: "success", data: fakeObject("x", "Part::Fillet") }) } as unknown as EnvironmentAdapter;
    const { handler: filletHandler } = createFilletEnvironmentObjectTool(getSession, filletAdapter);
    await assert.rejects(async () => { await filletHandler({ objectId: "a", radius: Number.NaN }); }, /finite number/);
  });

  it("refuses to act with no connected session", async () => {
    const adapter = { booleanObject: async () => ({ status: "success", data: {} }) } as unknown as EnvironmentAdapter;
    const { handler } = createBooleanEnvironmentObjectTool(() => null, adapter);
    await assert.rejects(async () => { await handler({ kind: "cut", baseId: "a", toolId: "b" }); }, /No connected environment session/);
  });
});
