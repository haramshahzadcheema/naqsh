import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EnvironmentObject, EnvironmentSession } from "@naqsh/schemas";
import { runEnvironmentAdapterContractTests, supportsCapability } from "@naqsh/core";
import { createMockSimulationEnvironment } from "../src/mock-simulation-environment.js";

// Same reusable suite as the CAD mock, exercised against a deliberately
// DIFFERENT capability profile (modify only). Where the CAD suite proves
// create/delete/save/checkpoint succeed end-to-end, this run proves the
// exact same test code instead asserts unsupported_capability for every
// one of them -- the contract is doing real, capability-driven work, not
// just always passing.
runEnvironmentAdapterContractTests("mock_simulation", () => createMockSimulationEnvironment());

async function connect(adapter: ReturnType<typeof createMockSimulationEnvironment>): Promise<EnvironmentSession> {
  const result = await adapter.connect();
  return result.data as EnvironmentSession;
}

describe("Mock simulation environment: adapter-specific behavior", () => {
  it("declares only the modify capability -- proving the contract is not secretly CAD-shaped", () => {
    const adapter = createMockSimulationEnvironment();
    const descriptor = adapter.describe();
    assert.equal(supportsCapability(descriptor, "modify"), true);
    for (const capability of ["create", "delete", "save", "checkpoint"] as const) {
      assert.equal(supportsCapability(descriptor, capability), false);
    }
  });

  it("seeds sensor/actuator objects distinct from CAD vocabulary", async () => {
    const adapter = createMockSimulationEnvironment();
    const session = await connect(adapter);
    const listed = await adapter.listObjects(session);
    const objects = listed.data as EnvironmentObject[];
    assert.deepEqual(
      objects.map((object) => object.type).sort(),
      ["actuator", "sensor"]
    );
  });

  it("allows tuning a writable simulation parameter", async () => {
    const adapter = createMockSimulationEnvironment();
    const session = await connect(adapter);
    const listed = await adapter.listObjects(session);
    const sensor = (listed.data as EnvironmentObject[]).find((object) => object.type === "sensor")!;

    const result = await adapter.modifyObject(session, sensor.id, { setpointN: 750 });
    assert.equal(result.status, "success");
    const updated = (result.data as EnvironmentObject).properties.find((property) => property.key === "setpointN");
    assert.equal(updated?.value, 750);
  });

  it("save/checkpoint/create/delete all fail with unsupported_capability, never silently succeed", async () => {
    const adapter = createMockSimulationEnvironment();
    const session = await connect(adapter);

    const saveResult = await adapter.save(session);
    assert.equal(saveResult.status, "error");
    assert.equal(saveResult.error?.kind, "unsupported_capability");

    const checkpointResult = await adapter.checkpoint(session);
    assert.equal(checkpointResult.status, "error");
    assert.equal(checkpointResult.error?.kind, "unsupported_capability");

    const createResult = await adapter.createObject(session, { type: "sensor", name: "extra" });
    assert.equal(createResult.status, "error");
    assert.equal(createResult.error?.kind, "unsupported_capability");

    const listed = await adapter.listObjects(session);
    const existing = (listed.data as EnvironmentObject[])[0]!;
    const deleteResult = await adapter.deleteObject(session, existing.id);
    assert.equal(deleteResult.status, "error");
    assert.equal(deleteResult.error?.kind, "unsupported_capability");
  });
});
