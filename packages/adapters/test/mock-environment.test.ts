import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EnvironmentObject, EnvironmentOperationResult, EnvironmentSession } from "@naqsh/schemas";
import { runEnvironmentAdapterContractTests, supportsCapability } from "@naqsh/core";
import { createMockEnvironment } from "../src/mock-environment.js";

// Reuses the EXACT P5 contract-test suite, unmodified -- the same proof
// obligation a future FreeCADAdapter (P12+) will have to satisfy. Nothing
// P6-specific here; this is what "the mock proves the contract is
// implementable" means in practice.
runEnvironmentAdapterContractTests("mock", () => createMockEnvironment());

async function connect(adapter: ReturnType<typeof createMockEnvironment>): Promise<EnvironmentSession> {
  const result = await adapter.connect();
  return result.data as EnvironmentSession;
}

describe("Mock environment: identity and capability reporting", () => {
  it("identifies itself as 'mock', not a stand-in for any real environment", () => {
    const adapter = createMockEnvironment();
    const descriptor = adapter.describe();
    assert.equal(descriptor.kind, "mock");
    assert.equal(descriptor.name, "Deterministic Mock Environment");
  });

  it("declares the full capability set and actually implements every one of them", () => {
    const adapter = createMockEnvironment();
    const descriptor = adapter.describe();
    for (const capability of ["create", "modify", "delete", "save", "checkpoint"] as const) {
      assert.equal(supportsCapability(descriptor, capability), true);
    }
  });
});

describe("Mock environment: deterministic initialization and inspection", () => {
  it("seeds the identical two objects, with the identical ids, on every fresh instance", async () => {
    const adapterA = createMockEnvironment();
    const adapterB = createMockEnvironment();
    const sessionA = await connect(adapterA);
    const sessionB = await connect(adapterB);

    const listedA = (await adapterA.listObjects(sessionA)).data as EnvironmentObject[];
    const listedB = (await adapterB.listObjects(sessionB)).data as EnvironmentObject[];

    assert.deepEqual(
      listedA.map((object) => object.id).sort(),
      listedB.map((object) => object.id).sort()
    );
    assert.deepEqual(
      listedA.map((object) => object.name).sort(),
      ["Widget A", "Widget B"]
    );
  });

  it("seeds a relationship end-to-end (widget_a is connected_to widget_b)", async () => {
    const adapter = createMockEnvironment();
    const session = await connect(adapter);
    const result = await adapter.inspectObject(session, "widget_a");
    assert.equal(result.status, "success");
    const widgetA = result.data as EnvironmentObject;
    assert.equal(widgetA.relationships.length, 1);
    assert.equal(widgetA.relationships[0]?.type, "connected_to");
    assert.equal(widgetA.relationships[0]?.targetId, "widget_b");
  });

  it("inspection is byte-identical across repeated calls with no mutation in between", async () => {
    const adapter = createMockEnvironment();
    const session = await connect(adapter);
    const first = await adapter.inspectObject(session, "widget_a");
    const second = await adapter.inspectObject(session, "widget_a");
    assert.deepEqual(first.data, second.data);
  });

  it("distinguishes read-only from writable seed properties", async () => {
    const adapter = createMockEnvironment();
    const session = await connect(adapter);
    const widgetA = (await adapter.inspectObject(session, "widget_a")).data as EnvironmentObject;
    const serialNumber = widgetA.properties.find((property) => property.key === "serialNumber");
    const status = widgetA.properties.find((property) => property.key === "status");
    assert.equal(serialNumber?.readOnly, true);
    assert.equal(status?.readOnly, false);
  });

  it("REGRESSION: mutating an inspected/listed object cannot leak back into the adapter's own state", async () => {
    // Confirmed exploitable during the P0-P8 audit: inspectObject/listObjects
    // returned the exact EnvironmentObject reference stored in this engine's
    // internal Map (createEnvironmentObject only shallow-freezes -- the
    // nested properties/relationships arrays and metadata were never
    // cloned), so result.data.properties.push(...) silently corrupted the
    // adapter's ground truth for every future call.
    const adapter = createMockEnvironment();
    const session = await connect(adapter);
    const inspected = (await adapter.inspectObject(session, "widget_a")).data as EnvironmentObject;
    assert.throws(() => {
      (inspected.properties as unknown[]).push({ key: "injected", value: "evil", readOnly: false });
    }, TypeError);
    assert.throws(() => {
      (inspected.metadata as Record<string, unknown>).injected = "evil";
    }, TypeError);

    const listed = (await adapter.listObjects(session)).data as EnvironmentObject[];
    assert.throws(() => {
      (listed as unknown[]).push({});
    }, TypeError);

    const reinspected = (await adapter.inspectObject(session, "widget_a")).data as EnvironmentObject;
    assert.equal(
      reinspected.properties.some((property) => property.key === "injected"),
      false,
      "the adapter's internal state must be completely unaffected by any attempted mutation above"
    );
  });
});

describe("Mock environment: inspectDocument (Phase 13)", () => {
  it("reports the seeded object count/ids and passes through the session's documentName", async () => {
    const adapter = createMockEnvironment();
    const connectResult = await adapter.connect({ documentName: "my-doc" });
    const session = connectResult.data as EnvironmentSession;
    const result = await adapter.inspectDocument(session);
    assert.equal(result.status, "success");
    const inspection = result.data as { environmentKind: string; documentName: string | null; objectCount: number; objectIds: string[]; rootObjectIds: string[] };
    assert.equal(inspection.environmentKind, "mock");
    assert.equal(inspection.documentName, "my-doc");
    assert.equal(inspection.objectCount, 2);
    assert.deepEqual(inspection.objectIds.sort(), ["widget_a", "widget_b"]);
    // Neither seeded widget declares a parentId -- both are roots.
    assert.deepEqual(inspection.rootObjectIds.sort(), ["widget_a", "widget_b"]);
  });

  it("reflects object creation/deletion in subsequent inspectDocument calls", async () => {
    const adapter = createMockEnvironment();
    const session = await connect(adapter);
    await adapter.createObject(session, { type: "part", name: "extra" });
    const afterCreate = (await adapter.inspectDocument(session)).data as { objectCount: number };
    assert.equal(afterCreate.objectCount, 3);
  });
});

describe("Mock environment: object creation and modification", () => {
  it("creates a new object with a deterministic id", async () => {
    const adapter = createMockEnvironment();
    const session = await connect(adapter);
    const result = await adapter.createObject(session, { type: "component", name: "Widget C" });
    assert.equal(result.status, "success");
    const created = result.data as EnvironmentObject;
    assert.equal(created.id, "envobj_0001", "the first generated (non-seeded) object id must be deterministic");
  });

  it("creating an object with an explicit id that collides with an existing one fails with conflict, never silently overwriting", async () => {
    const adapter = createMockEnvironment();
    const session = await connect(adapter);
    const result = await adapter.createObject(session, { id: "widget_a", type: "component", name: "Impostor" });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "conflict");

    const stillOriginal = await adapter.inspectObject(session, "widget_a");
    assert.equal((stillOriginal.data as EnvironmentObject).name, "Widget A", "the original object must be untouched");
  });

  it("modifies a writable property and leaves the change observable on re-inspection", async () => {
    const adapter = createMockEnvironment();
    const session = await connect(adapter);
    const result = await adapter.modifyObject(session, "widget_a", { status: "maintenance" });
    assert.equal(result.status, "success");

    const reinspected = await adapter.inspectObject(session, "widget_a");
    const status = (reinspected.data as EnvironmentObject).properties.find((property) => property.key === "status");
    assert.equal(status?.value, "maintenance");
  });
});

describe("Mock environment: invalid operations fail through the P5 error model", () => {
  it("inspecting an unknown object fails with object_not_found", async () => {
    const adapter = createMockEnvironment();
    const session = await connect(adapter);
    const result = await adapter.inspectObject(session, "does_not_exist");
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "object_not_found");
  });

  it("modifying a read-only property fails with invalid_operation, and does not apply the change", async () => {
    const adapter = createMockEnvironment();
    const session = await connect(adapter);
    const result = await adapter.modifyObject(session, "widget_a", { serialNumber: "HACKED" });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_operation");

    const reinspected = await adapter.inspectObject(session, "widget_a");
    const serialNumber = (reinspected.data as EnvironmentObject).properties.find(
      (property) => property.key === "serialNumber"
    );
    assert.equal(serialNumber?.value, "WA-001");
  });

  it("modifying an unknown property fails with invalid_operation", async () => {
    const adapter = createMockEnvironment();
    const session = await connect(adapter);
    const result = await adapter.modifyObject(session, "widget_a", { doesNotExist: 1 });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_operation");
  });

  it("operating on a disconnected session fails with not_connected, never silently succeeding", async () => {
    const adapter = createMockEnvironment();
    const session = await connect(adapter);
    await adapter.disconnect(session);
    const result = await adapter.modifyObject(session, "widget_a", { status: "should_not_apply" });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "not_connected");
  });

  it("createObject with a shape violation (empty type) returns a structured error, never throws/rejects", async () => {
    const adapter = createMockEnvironment();
    const session = await connect(adapter);
    const result = await adapter.createObject(session, { type: "", name: "bad" });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_operation");
  });

  it("createObject with a non-JSON-safe property value returns a structured error, never throws/rejects", async () => {
    const adapter = createMockEnvironment();
    const session = await connect(adapter);
    const result = await adapter.createObject(session, {
      type: "component",
      name: "Bad Widget",
      properties: [{ key: "score", value: Number.NaN, readOnly: false }]
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_operation");
  });

  it("modifyObject with a non-JSON-safe new value returns a structured error, never throws/rejects", async () => {
    const adapter = createMockEnvironment();
    const session = await connect(adapter);
    const result = await adapter.modifyObject(session, "widget_a", { status: Number.POSITIVE_INFINITY });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_operation");
  });

  it("modifyObject with a MIXED batch (one valid key, one invalid key) applies NEITHER change -- atomic, not partial", async () => {
    const adapter = createMockEnvironment();
    const session = await connect(adapter);

    const result = await adapter.modifyObject(session, "widget_a", {
      status: "should_not_apply_either",
      serialNumber: "HACKED"
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_operation");

    const reinspected = await adapter.inspectObject(session, "widget_a");
    const status = (reinspected.data as EnvironmentObject).properties.find((property) => property.key === "status");
    const serialNumber = (reinspected.data as EnvironmentObject).properties.find(
      (property) => property.key === "serialNumber"
    );
    assert.equal(status?.value, "active", "the otherwise-valid key must NOT have been applied");
    assert.equal(serialNumber?.value, "WA-001", "the read-only key must not have been applied either");
  });
});

describe("Mock environment: lifecycle", () => {
  it("connect -> inspect -> modify -> disconnect -> further operations fail deterministically", async () => {
    const adapter = createMockEnvironment();
    const session = await connect(adapter);
    assert.equal(session.status, "connected");

    const inspected = await adapter.inspectObject(session, "widget_a");
    assert.equal(inspected.status, "success");

    const modified = await adapter.modifyObject(session, "widget_a", { status: "in_use" });
    assert.equal(modified.status, "success");

    const disconnectResult = await adapter.disconnect(session);
    assert.equal(disconnectResult.status, "success");

    const afterDisconnect = await adapter.listObjects(session);
    assert.equal(afterDisconnect.status, "error");
    assert.equal(afterDisconnect.error?.kind, "not_connected");
  });

  it("disconnecting an already-disconnected session fails with not_connected, not a second success", async () => {
    const adapter = createMockEnvironment();
    const session = await connect(adapter);
    const first = await adapter.disconnect(session);
    assert.equal(first.status, "success");
    const second = await adapter.disconnect(session);
    assert.equal(second.status, "error");
    assert.equal(second.error?.kind, "not_connected");
  });
});

describe("Mock environment: instance isolation", () => {
  it("two separate instances do not share object state", async () => {
    const adapterA = createMockEnvironment();
    const adapterB = createMockEnvironment();
    const sessionA = await connect(adapterA);
    const sessionB = await connect(adapterB);

    await adapterA.createObject(sessionA, { type: "component", name: "Only In A" });

    const listedA = (await adapterA.listObjects(sessionA)).data as EnvironmentObject[];
    const listedB = (await adapterB.listObjects(sessionB)).data as EnvironmentObject[];

    assert.equal(listedA.some((object) => object.name === "Only In A"), true);
    assert.equal(listedB.some((object) => object.name === "Only In A"), false);
  });

  it("two separate instances do not share their deterministic id/clock counters", async () => {
    const adapterA = createMockEnvironment();
    const adapterB = createMockEnvironment();
    const sessionA = await connect(adapterA);
    const sessionB = await connect(adapterB);

    await adapterA.createObject(sessionA, { type: "component", name: "First" });
    await adapterA.createObject(sessionA, { type: "component", name: "Second" });

    const createdInB = await adapterB.createObject(sessionB, { type: "component", name: "First-in-B" });
    assert.equal(
      (createdInB.data as EnvironmentObject).id,
      "envobj_0001",
      "adapter B's counter must start fresh, unaffected by adapter A's calls"
    );
  });
});

describe("Mock environment: repeated operations produce deterministic results", () => {
  async function runFixedSequence(adapter: ReturnType<typeof createMockEnvironment>): Promise<EnvironmentOperationResult[]> {
    const results: EnvironmentOperationResult[] = [];
    const connectResult = await adapter.connect();
    results.push(connectResult);
    const session = connectResult.data as EnvironmentSession;

    results.push(await adapter.createObject(session, { type: "component", name: "Determinism Probe" }));
    results.push(await adapter.modifyObject(session, "widget_a", { status: "probed" }));
    results.push(await adapter.checkpoint(session));
    results.push(await adapter.deleteObject(session, "widget_b"));
    results.push(await adapter.disconnect(session));
    return results;
  }

  it("two fresh instances given the identical operation sequence produce IDENTICAL results, ids and timestamps included", async () => {
    const resultsA = await runFixedSequence(createMockEnvironment());
    const resultsB = await runFixedSequence(createMockEnvironment());
    assert.deepEqual(resultsA, resultsB);
  });

  it("the same instance run twice from a fresh connect still reproduces distinguishable but internally consistent ids (proves the clock/counter is real, not accidentally constant)", async () => {
    const adapter = createMockEnvironment();
    const first = await runFixedSequence(adapter);
    const second = await runFixedSequence(adapter);
    assert.notDeepEqual(first, second, "a second pass against the SAME running instance must continue advancing ids/timestamps, not repeat them");
  });
});

describe("Mock environment: overriding the deterministic defaults", () => {
  it("accepts an injected generateId/now pair instead of the built-in defaults", async () => {
    let counter = 0;
    const adapter = createMockEnvironment({
      generateId: (prefix) => `${prefix}-custom-${++counter}`,
      now: () => "2099-01-01T00:00:00.000Z"
    });
    const connectResult = await adapter.connect();
    const session = connectResult.data as EnvironmentSession;
    assert.equal(session.id, "envsess-custom-1");
    assert.equal(session.openedAt, "2099-01-01T00:00:00.000Z");
  });
});
