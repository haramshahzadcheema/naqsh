import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EnvironmentObject, EnvironmentSession } from "@naqsh/schemas";
import { runEnvironmentAdapterContractTests, supportsCapability } from "@naqsh/core";
import { createMockSimulationEnvironment } from "../src/mock-simulation-environment.js";

// Same reusable suite as the CAD mock, exercised against a deliberately
// DIFFERENT capability profile (modify + checkpoint, no create/delete/
// save -- P26). Where the CAD suite proves create/delete/save/checkpoint
// all succeed end-to-end, this run proves the exact same test code instead
// asserts unsupported_capability for create/delete/save, while checkpoint
// (P26: a simulation's own parameter state IS snapshot/restore-able even
// though its object topology is fixed) succeeds end-to-end -- the contract
// is doing real, capability-driven work, not just always passing or always
// failing.
runEnvironmentAdapterContractTests("mock_simulation", () => createMockSimulationEnvironment());

async function connect(adapter: ReturnType<typeof createMockSimulationEnvironment>): Promise<EnvironmentSession> {
  const result = await adapter.connect();
  return result.data as EnvironmentSession;
}

describe("Mock simulation environment: adapter-specific behavior", () => {
  it("declares exactly modify + checkpoint -- proving the contract is not secretly CAD-shaped, while still supporting the bounded checkpoint/restore experiment pattern (P26)", () => {
    const adapter = createMockSimulationEnvironment();
    const descriptor = adapter.describe();
    for (const capability of ["modify", "checkpoint"] as const) {
      assert.equal(supportsCapability(descriptor, capability), true);
    }
    for (const capability of ["create", "delete", "save"] as const) {
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

  it("save/create/delete all fail with unsupported_capability, never silently succeed", async () => {
    const adapter = createMockSimulationEnvironment();
    const session = await connect(adapter);

    const saveResult = await adapter.save(session);
    assert.equal(saveResult.status, "error");
    assert.equal(saveResult.error?.kind, "unsupported_capability");

    const createResult = await adapter.createObject(session, { type: "sensor", name: "extra" });
    assert.equal(createResult.status, "error");
    assert.equal(createResult.error?.kind, "unsupported_capability");

    const listed = await adapter.listObjects(session);
    const existing = (listed.data as EnvironmentObject[])[0]!;
    const deleteResult = await adapter.deleteObject(session, existing.id);
    assert.equal(deleteResult.status, "error");
    assert.equal(deleteResult.error?.kind, "unsupported_capability");
  });

  it("checkpoint/restore genuinely round-trips a parameter change (P26: bounded, reversible simulation experiments)", async () => {
    const adapter = createMockSimulationEnvironment();
    const session = await connect(adapter);
    const listed = await adapter.listObjects(session);
    const sensor = (listed.data as EnvironmentObject[]).find((object) => object.type === "sensor")!;

    const checkpointResult = await adapter.checkpoint(session);
    assert.equal(checkpointResult.status, "success");
    const { checkpointId } = checkpointResult.data as { checkpointId: string };

    await adapter.modifyObject(session, sensor.id, { setpointN: 999 });
    const restoreResult = await adapter.restore(session, checkpointId);
    assert.equal(restoreResult.status, "success");

    const reinspected = await adapter.inspectObject(session, sensor.id);
    const setpoint = (reinspected.data as EnvironmentObject).properties.find((property) => property.key === "setpointN");
    assert.equal(setpoint?.value, 500, "restore must genuinely revert the parameter change, not just report success");
  });
});
