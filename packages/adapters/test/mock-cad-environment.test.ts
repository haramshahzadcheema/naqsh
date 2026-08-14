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
});
