import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EnvironmentObject, EnvironmentSession } from "@naqsh/schemas";
import { runEnvironmentAdapterContractTests, supportsCapability } from "@naqsh/core";
import { createMockCadEnvironment } from "../src/mock-cad-environment.js";

// The reusable suite is the primary coverage here -- it exercises every
// method against this adapter's actual (full) capability set. The same
// call, unmodified, is what a future
// packages/adapters/test/freecad-environment.test.ts will make against
// createFreeCADAdapter once P12 exists.
runEnvironmentAdapterContractTests("mock_cad", () => createMockCadEnvironment());

async function connect(adapter: ReturnType<typeof createMockCadEnvironment>): Promise<EnvironmentSession> {
  const result = await adapter.connect();
  return result.data as EnvironmentSession;
}

describe("Mock CAD environment: adapter-specific behavior", () => {
  it("declares the full capability set", () => {
    const adapter = createMockCadEnvironment();
    const descriptor = adapter.describe();
    for (const capability of ["create", "modify", "delete", "save", "checkpoint"] as const) {
      assert.equal(supportsCapability(descriptor, capability), true);
    }
  });

  it("seeds a bracket object with a read-only mass and writable material/thickness", async () => {
    const adapter = createMockCadEnvironment();
    const session = await connect(adapter);
    const listed = await adapter.listObjects(session);
    const objects = listed.data as EnvironmentObject[];
    const bracket = objects.find((object) => object.name === "Seed Bracket");
    assert.ok(bracket);
    const mass = bracket.properties.find((property) => property.key === "massG");
    assert.equal(mass?.readOnly, true);
    const material = bracket.properties.find((property) => property.key === "material");
    assert.equal(material?.readOnly, false);
  });

  it("rejects modifying the read-only mass property with invalid_operation", async () => {
    const adapter = createMockCadEnvironment();
    const session = await connect(adapter);
    const listed = await adapter.listObjects(session);
    const bracket = (listed.data as EnvironmentObject[]).find((object) => object.name === "Seed Bracket")!;

    const result = await adapter.modifyObject(session, bracket.id, { massG: 999 });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_operation");
  });

  it("rejects modifying an unknown property with invalid_operation", async () => {
    const adapter = createMockCadEnvironment();
    const session = await connect(adapter);
    const listed = await adapter.listObjects(session);
    const bracket = (listed.data as EnvironmentObject[]).find((object) => object.name === "Seed Bracket")!;

    const result = await adapter.modifyObject(session, bracket.id, { doesNotExist: 1 });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_operation");
  });

  it("connect(options) with a documentName threads through to the session; connect() with no args still works", async () => {
    const adapter = createMockCadEnvironment();

    const withTarget = await adapter.connect({ documentName: "bracket_v2.FCStd" });
    assert.equal(withTarget.status, "success");
    assert.equal((withTarget.data as EnvironmentSession).documentName, "bracket_v2.FCStd");

    const withoutTarget = await adapter.connect();
    assert.equal(withoutTarget.status, "success");
    assert.equal((withoutTarget.data as EnvironmentSession).documentName, null);
  });

  it("two sessions on the same adapter instance observe each other's mutations (shared document, not isolated)", async () => {
    const adapter = createMockCadEnvironment();
    const sessionA = await connect(adapter);
    const sessionB = await connect(adapter);

    const created = await adapter.createObject(sessionA, { type: "part", name: "seen-by-b" });
    assert.equal(created.status, "success");

    const listedFromB = await adapter.listObjects(sessionB);
    const names = (listedFromB.data as EnvironmentObject[]).map((object) => object.name);
    assert.ok(names.includes("seen-by-b"), "session B must see an object created via session A on the same adapter");
  });
});
