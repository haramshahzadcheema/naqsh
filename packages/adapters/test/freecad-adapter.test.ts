import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EnvironmentObject, EnvironmentSession } from "@naqsh/schemas";
import { runEnvironmentAdapterContractTests, supportsCapability } from "@naqsh/core";
import { createFreeCadAdapter, type FreeCadAdapterOptions } from "../src/freecad-adapter.js";
import type { FreeCadRuntimeResult } from "../src/freecad-runtime.js";

/**
 * LEVEL 1 (Phase 12 Step 15): deterministic contract tests against a fake
 * FreeCAD runtime -- no `freecadcmd`, no real FreeCAD, no `child_process`
 * call ever happens in this file. `createFreeCadAdapter`'s injectable
 * `runOperation` (freecad-adapter.ts) is what makes this possible: every
 * test below exercises the REAL adapter logic (session tracking,
 * capability gating, error mapping, object-shape validation) with only the
 * one genuinely-external call (the `freecadcmd` subprocess) replaced.
 *
 * See freecad-adapter.integration.test.ts for the companion LEVEL 2 suite
 * that runs the same kind of assertions against a REAL FreeCAD install.
 */

interface FakeObjectFixture {
  id: string;
  type: string;
  name: string;
  properties: Array<{ key: string; value: unknown; readOnly: boolean }>;
  relationships?: Array<{ type: string; targetId: string; metadata: Record<string, unknown> }>;
}

function buildFakeRuntime(options: { objects?: FakeObjectFixture[]; failConnectFor?: string } = {}) {
  const objects: FakeObjectFixture[] = options.objects ?? [
    {
      id: "Box",
      type: "Part::Box",
      name: "Test Box",
      properties: [
        { key: "Length", value: { value: 10, unit: "mm" }, readOnly: false },
        { key: "TypeId", value: "Part::Box", readOnly: true }
      ],
      relationships: []
    }
  ];

  const calls: Array<{ operation: string; params: Record<string, unknown> }> = [];

  const runOperation = async (operation: string, params: Record<string, unknown>): Promise<FreeCadRuntimeResult> => {
    calls.push({ operation, params });
    switch (operation) {
      case "health":
        return { status: "success", data: { status: "healthy", version: "1.1.3-fake", raw: ["1", "1", "3-fake"] } };
      case "connect": {
        const filePath = params.filePath as string;
        if (options.failConnectFor && filePath === options.failConnectFor) {
          return { status: "error", kind: "environment_failure", message: `OSError: File '${filePath}' does not exist!` };
        }
        return { status: "success", data: { documentName: "FakeDoc", internalName: "FakeDoc", objectCount: objects.length } };
      }
      case "list_objects":
        return { status: "success", data: { objects } };
      case "inspect_object": {
        const objectId = params.objectId as string;
        const found = objects.find((object) => object.id === objectId);
        return found ? { status: "success", data: { found: true, object: found } } : { status: "success", data: { found: false } };
      }
      case "inspect_document":
        return {
          status: "success",
          data: {
            documentId: "FakeDoc",
            documentName: "FakeDoc",
            filePath: params.filePath,
            objectCount: objects.length,
            objectIds: objects.map((object) => object.id).sort(),
            rootObjectIds: objects.map((object) => object.id).sort(),
            environmentVersion: "1.1.3-fake"
          }
        };
      case "save":
        return { status: "success", data: { saved: true } };
      default:
        return { status: "error", kind: "invalid_operation", message: `Unknown operation: ${operation}` };
    }
  };

  return { runOperation, calls, objects };
}

function buildAdapter(overrides: Partial<FreeCadAdapterOptions> = {}, fake = buildFakeRuntime()) {
  return {
    adapter: createFreeCadAdapter({
      defaultDocumentPath: "fake.FCStd",
      runOperation: fake.runOperation,
      ...overrides
    }),
    fake
  };
}

async function connect(adapter: ReturnType<typeof createFreeCadAdapter>): Promise<EnvironmentSession> {
  const result = await adapter.connect();
  return result.data as EnvironmentSession;
}

// The reusable P5 contract suite, run against a fully deterministic fake
// runtime -- proves the FreeCAD adapter satisfies the EXACT SAME
// EnvironmentAdapter contract the mock adapters do, without needing
// FreeCAD installed. `runEnvironmentAdapterContractTests`'s own "modify
// capability" check requires at least one seeded object with a writable
// property regardless of whether "modify" is actually supported -- the
// fixture's "Length" property satisfies that.
runEnvironmentAdapterContractTests("freecad (fake runtime)", () => buildAdapter().adapter);

describe("createFreeCadAdapter: identity and capabilities", () => {
  it("declares kind 'freecad' and exactly the 'save' capability -- no modification claimed in Phase 12", () => {
    const { adapter } = buildAdapter();
    const descriptor = adapter.describe();
    assert.equal(descriptor.kind, "freecad");
    assert.deepEqual(descriptor.capabilities, ["save"]);
    for (const capability of ["create", "modify", "delete", "checkpoint"] as const) {
      assert.equal(supportsCapability(descriptor, capability), false);
    }
    assert.equal(supportsCapability(descriptor, "save"), true);
  });

  it("does not hardcode a fake FreeCAD version in the static descriptor", () => {
    const { adapter } = buildAdapter();
    // The descriptor's `version` is THIS ADAPTER's own version, never a
    // claimed live FreeCAD version -- describe() is synchronous and
    // cannot probe FreeCAD. Merely asserting it's a non-empty string
    // rather than a specific FreeCAD release number.
    assert.equal(typeof adapter.describe().version, "string");
    assert.ok(adapter.describe().version.length > 0);
  });
});

describe("createFreeCadAdapter: health", () => {
  it("reports the REAL, live FreeCAD version discovered via the runtime, not a static claim", async () => {
    const { adapter } = buildAdapter();
    const result = await adapter.health();
    assert.equal(result.status, "success");
    const health = result.data as { status: string; message: string };
    assert.equal(health.status, "healthy");
    assert.match(health.message, /1\.1\.3-fake/);
  });

  it("SECURITY/TRUTHFULNESS: when FreeCAD is unreachable, health() reports failure -- never fakes a healthy connection", async () => {
    const fake = buildFakeRuntime();
    const failingRunOperation = async (): Promise<FreeCadRuntimeResult> => ({
      status: "error",
      kind: "environment_failure",
      message: 'FreeCAD command not found at "freecadcmd" -- FreeCAD is not available in this environment'
    });
    const { adapter } = buildAdapter({ runOperation: failingRunOperation }, fake);
    const result = await adapter.health();
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "environment_failure");
    assert.match(result.error!.message, /not available/);
  });
});

describe("createFreeCadAdapter: connect", () => {
  it("uses defaultDocumentPath when no explicit filePath/documentPath option is given", async () => {
    const { adapter, fake } = buildAdapter({ defaultDocumentPath: "C:\\models\\bracket.FCStd" });
    await adapter.connect();
    assert.equal(fake.calls[0]?.operation, "connect");
    assert.equal(fake.calls[0]?.params.filePath, "C:\\models\\bracket.FCStd");
  });

  it("honors an explicit filePath option over defaultDocumentPath", async () => {
    const { adapter, fake } = buildAdapter({ defaultDocumentPath: "default.FCStd" });
    await adapter.connect({ filePath: "explicit.FCStd" });
    assert.equal(fake.calls[0]?.params.filePath, "explicit.FCStd");
  });

  it("accepts 'documentPath' as an alias for 'filePath'", async () => {
    const { adapter, fake } = buildAdapter({ defaultDocumentPath: "default.FCStd" });
    await adapter.connect({ documentPath: "aliased.FCStd" });
    assert.equal(fake.calls[0]?.params.filePath, "aliased.FCStd");
  });

  it("rejects deterministically when no file path can be determined at all", async () => {
    const { adapter } = buildAdapter({ defaultDocumentPath: undefined });
    const result = await adapter.connect();
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_operation");
  });

  it("SECURITY/TRUTHFULNESS: a genuinely missing document produces a structured error, never a fake 'connected' session", async () => {
    const fake = buildFakeRuntime({ failConnectFor: "missing.FCStd" });
    const { adapter } = buildAdapter({ defaultDocumentPath: "missing.FCStd" }, fake);
    const result = await adapter.connect();
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "environment_failure");
    assert.match(result.error!.message, /does not exist/);
  });

  it("the returned session records environmentKind 'freecad' and the resolved documentName", async () => {
    const { adapter } = buildAdapter();
    const result = await adapter.connect();
    assert.equal(result.status, "success");
    const session = result.data as EnvironmentSession;
    assert.equal(session.environmentKind, "freecad");
    assert.equal(session.documentName, "FakeDoc");
    assert.equal(session.status, "connected");
  });
});

describe("createFreeCadAdapter: object enumeration and inspection", () => {
  it("maps FreeCAD-shaped raw objects into generic EnvironmentObject values -- never a raw FreeCAD reference", async () => {
    const { adapter } = buildAdapter();
    const session = await connect(adapter);
    const result = await adapter.listObjects(session);
    assert.equal(result.status, "success");
    const objects = result.data as EnvironmentObject[];
    assert.equal(objects.length, 1);
    assert.equal(objects[0]!.id, "Box");
    assert.equal(objects[0]!.type, "Part::Box");
    assert.equal(objects[0]!.name, "Test Box");
    // Only plain, JSON-safe data crossed the boundary -- no method, no
    // class instance, nothing resembling a live FreeCAD handle.
    assert.equal(Object.getPrototypeOf(objects[0]!.properties[0]), Object.prototype);
  });

  it("inspectObject finds a real object by id and reports object_not_found for an unknown one", async () => {
    const { adapter } = buildAdapter();
    const session = await connect(adapter);
    const found = await adapter.inspectObject(session, "Box");
    assert.equal(found.status, "success");
    const missing = await adapter.inspectObject(session, "Ghost");
    assert.equal(missing.status, "error");
    assert.equal(missing.error?.kind, "object_not_found");
  });

  it("REGRESSION (Phase 13 audit): a relationship-inspection failure the runtime reports for inspectObject's single object is surfaced via metadata, never silently dropped", async () => {
    // Mirrors the equivalent listObjects test below, but for the
    // single-object detail path (op_inspect_object in runner.py) -- an
    // earlier version of get_relationships() silently `continue`d past a
    // relationship it could not describe, with no trace anywhere.
    const fake = buildFakeRuntime();
    const withRelationshipError = async (operation: string, params: Record<string, unknown>) => {
      if (operation === "inspect_object") {
        return {
          status: "success" as const,
          data: {
            found: true,
            object: { id: "Box", type: "Part::Box", name: "Test Box", properties: [], relationships: [] },
            inspectionErrors: [{ kind: "relationship_inspection_failed", objectId: "Box", message: "contains: AttributeError: ..." }]
          }
        };
      }
      return fake.runOperation(operation, params);
    };
    const { adapter } = buildAdapter({}, { ...fake, runOperation: withRelationshipError });
    const session = await connect(adapter);
    const result = await adapter.inspectObject(session, "Box");
    assert.equal(result.status, "success");
    const inspectionErrors = result.metadata.inspectionErrors as Array<{ kind: string; objectId: string | null }>;
    assert.equal(inspectionErrors.length, 1);
    assert.equal(inspectionErrors[0]!.kind, "relationship_inspection_failed");
    assert.equal(inspectionErrors[0]!.objectId, "Box");
  });

  it("inspectObject's metadata carries no inspectionErrors key at all when the runtime reports none (no noisy empty array on the common path)", async () => {
    const { adapter } = buildAdapter();
    const session = await connect(adapter);
    const result = await adapter.inspectObject(session, "Box");
    assert.equal(result.status, "success");
    assert.equal(Object.hasOwn(result.metadata, "inspectionErrors"), false);
  });

  it("REGRESSION (Phase 13 Step 16 supersedes Phase 12's fail-fast): a malformed object from the runtime is skipped with a warning, never an uncaught exception and never silently fabricated data -- the overall call still succeeds", async () => {
    const fake = buildFakeRuntime();
    const malformedRunOperation = async (operation: string, params: Record<string, unknown>): Promise<FreeCadRuntimeResult> => {
      if (operation === "list_objects") {
        return { status: "success", data: { objects: [{ id: "", type: 123, name: null }] } };
      }
      return fake.runOperation(operation, params);
    };
    const { adapter } = buildAdapter({}, { ...fake, runOperation: malformedRunOperation });
    const session = await connect(adapter);
    const result = await adapter.listObjects(session);
    assert.equal(result.status, "success");
    assert.deepEqual(result.data, []);
    const warnings = result.metadata.warnings as string[];
    assert.ok(warnings.length > 0, "the malformed object must still be reported as a warning, not silently dropped");
  });

  it("SECURITY/STABILITY REGRESSION: a raw object with a MISSING id is skipped, never silently assigned a fresh, unstable, fabricated id (Phase 13: skipped-with-warning, not a whole-call failure)", async () => {
    // The specific bug this proves stays fixed: createEnvironmentObject
    // defaults a missing `id` to a freshly-generated random one
    // (`createId("envobj")`). If freecad-adapter.ts ever again passed
    // `id: undefined` through for a raw object whose id wasn't a string,
    // the SAME real FreeCAD object would silently receive a DIFFERENT
    // NAQSH-facing id on every single listObjects/inspectObject call --
    // breaking any caller (a Proposal referencing an object by id, the
    // P11 loop's before/after discrepancy comparison) that assumes object
    // identity is stable across observations. Under Phase 13's
    // partial-success listObjects, the security property now shows up as
    // "no such object ever appears in `data`" rather than "the whole call
    // errors" -- either way, no fabricated id ever crosses the boundary.
    const fake = buildFakeRuntime();
    const noIdRunOperation = async (operation: string, params: Record<string, unknown>): Promise<FreeCadRuntimeResult> => {
      if (operation === "list_objects") {
        return { status: "success", data: { objects: [{ type: "Part::Box", name: "No Id Object", properties: [] }] } };
      }
      return fake.runOperation(operation, params);
    };
    const { adapter } = buildAdapter({}, { ...fake, runOperation: noIdRunOperation });
    const session = await connect(adapter);

    const first = await adapter.listObjects(session);
    assert.equal(first.status, "success");
    assert.deepEqual(first.data, []);
    const warnings = first.metadata.warnings as string[];
    assert.ok(warnings.some((warning) => warning.includes("missing a valid, non-empty id")));
  });

  it("maps a real FreeCAD dependency relationship (OutList) into EnvironmentObject.relationships -- never fabricated, only what FreeCAD itself reports", async () => {
    const fake = buildFakeRuntime({
      objects: [
        {
          id: "Cut",
          type: "Part::Cut",
          name: "Cut",
          properties: [],
          relationships: [
            { type: "references", targetId: "Box1", metadata: {} },
            { type: "references", targetId: "Box2", metadata: {} }
          ]
        }
      ]
    });
    const { adapter } = buildAdapter({}, fake);
    const session = await connect(adapter);
    const result = await adapter.listObjects(session);
    assert.equal(result.status, "success");
    const objects = result.data as EnvironmentObject[];
    assert.deepEqual(
      objects[0]!.relationships.map((relationship) => relationship.targetId),
      ["Box1", "Box2"]
    );
    assert.ok(objects[0]!.relationships.every((relationship) => relationship.type === "references"));
  });

  it("PAYLOAD SAFETY: unsupported FreeCAD-side property values arrive as explicit markers, never crash the observation", async () => {
    const fake = buildFakeRuntime({
      objects: [
        {
          id: "Weird",
          type: "Part::Feature",
          name: "Weird Object",
          properties: [{ key: "Shape", value: { unsupported: true, pythonType: "Solid" }, readOnly: true }]
        }
      ]
    });
    const { adapter } = buildAdapter({}, fake);
    const session = await connect(adapter);
    const result = await adapter.listObjects(session);
    assert.equal(result.status, "success");
    const objects = result.data as EnvironmentObject[];
    assert.deepEqual(objects[0]!.properties[0]!.value, { unsupported: true, pythonType: "Solid" });
  });
});

describe("createFreeCadAdapter: not_connected guard", () => {
  it("every operation fails with not_connected against a disconnected/unknown session", async () => {
    const { adapter } = buildAdapter();
    const connectResult = await adapter.connect();
    const session = connectResult.data as EnvironmentSession;
    await adapter.disconnect(session);

    for (const call of [
      () => adapter.listObjects(session),
      () => adapter.inspectObject(session, "Box"),
      () => adapter.save(session),
      () => adapter.createObject(session, { type: "x", name: "x" }),
      () => adapter.modifyObject(session, "Box", { Length: 1 }),
      () => adapter.deleteObject(session, "Box"),
      () => adapter.checkpoint(session),
      () => adapter.restore(session, "chk_1")
    ]) {
      const result = await call();
      assert.equal(result.status, "error");
      assert.equal(result.error?.kind, "not_connected");
    }
  });
});

describe("createFreeCadAdapter: capability-gated methods never reach the FreeCAD runtime", () => {
  it("create/modify/delete/checkpoint/restore all fail with unsupported_capability and never invoke runOperation", async () => {
    const { adapter, fake } = buildAdapter();
    const session = await connect(adapter);
    const callsBefore = fake.calls.length;

    const createResult = await adapter.createObject(session, { type: "Part::Box", name: "x" });
    const modifyResult = await adapter.modifyObject(session, "Box", { Length: 20 });
    const deleteResult = await adapter.deleteObject(session, "Box");
    const checkpointResult = await adapter.checkpoint(session);
    const restoreResult = await adapter.restore(session, "chk_1");

    for (const result of [createResult, modifyResult, deleteResult, checkpointResult, restoreResult]) {
      assert.equal(result.status, "error");
      assert.equal(result.error?.kind, "unsupported_capability");
    }
    // SECURITY: capability-gated methods must short-circuit BEFORE ever
    // spawning FreeCAD -- proves there is no hidden path where a
    // rejected-by-capability call still touches the real environment.
    assert.equal(fake.calls.length, callsBefore);
  });
});

describe("createFreeCadAdapter: Phase 13 inspection fields", () => {
  it("passes through genericType/parentId/visible/geometry from the runtime, defaulting missing fields honestly", async () => {
    const fake = buildFakeRuntime();
    // Simulate a runner.py payload richer than FakeObjectFixture's own type
    // (genericType/parentId/visible/geometry) by overriding runOperation
    // directly rather than widening the shared fixture type.
    const richRunOperation = async (operation: string, params: Record<string, unknown>) => {
      if (operation === "list_objects") {
        return {
          status: "success" as const,
          data: {
            objects: [
              {
                id: "Box1",
                type: "Part::Box",
                name: "Box1",
                genericType: "solid",
                parentId: "Group1",
                visible: false,
                geometry: { available: true, reason: null, valid: true, boundingBox: null, volume: 42, surfaceArea: null, centerOfMass: null, solidCount: 1, faceCount: null, edgeCount: null, vertexCount: null, shapeType: "Solid" },
                properties: [],
                relationships: []
              }
            ],
            inspectionErrors: []
          }
        };
      }
      return fake.runOperation(operation, params);
    };
    const { adapter } = buildAdapter({}, { ...fake, runOperation: richRunOperation });
    const session = await connect(adapter);
    const result = await adapter.listObjects(session);
    assert.equal(result.status, "success");
    const object = (result.data as EnvironmentObject[])[0]!;
    assert.equal(object.genericType, "solid");
    assert.equal(object.parentId, "Group1");
    assert.equal(object.visible, false);
    assert.deepEqual(object.geometry.volume, 42);
    assert.equal(object.geometry.available, true);
  });

  it("defaults genericType/parentId/visible/geometry when the runtime omits them (backward compatible with a leaner payload)", async () => {
    const { adapter } = buildAdapter();
    const session = await connect(adapter);
    const result = await adapter.listObjects(session);
    const object = (result.data as EnvironmentObject[])[0]!;
    assert.equal(object.genericType, "unknown");
    assert.equal(object.parentId, null);
    assert.equal(object.visible, null);
    assert.equal(object.geometry.available, false);
  });

  it("stamps object-level provenance (environmentKind) on every returned EnvironmentObject", async () => {
    const { adapter } = buildAdapter();
    const session = await connect(adapter);
    const result = await adapter.listObjects(session);
    const object = (result.data as EnvironmentObject[])[0]!;
    const provenance = object.metadata.provenance as { environmentKind: string };
    assert.equal(provenance.environmentKind, "freecad");
  });

  it("provenance is stable across repeated calls (no per-object timestamp) so listObjects() stays deterministic with no mutation in between", async () => {
    // The specific bug this proves stays fixed: an earlier version stamped
    // a live `observedAt` timestamp into every object's provenance, which
    // made two back-to-back listObjects() calls return DIFFERENT `data`
    // even with zero mutation -- breaking the generic EnvironmentAdapter
    // contract-test invariant every adapter must satisfy. `completedAt` on
    // the surrounding EnvironmentOperationResult already carries "when",
    // once per call; provenance only needs to carry "where from".
    const { adapter } = buildAdapter();
    const session = await connect(adapter);
    const first = await adapter.listObjects(session);
    const second = await adapter.listObjects(session);
    assert.deepEqual(first.data, second.data);
  });

  it("PARTIAL SUCCESS: a malformed object among otherwise-good ones is skipped with a warning, not an outright failure (Phase 13 Step 16)", async () => {
    const fake = buildFakeRuntime();
    const mixedRunOperation = async (operation: string, params: Record<string, unknown>) => {
      if (operation === "list_objects") {
        return {
          status: "success" as const,
          data: {
            objects: [
              { id: "Good1", type: "Part::Box", name: "Good1", properties: [], relationships: [] },
              { id: "", type: "Bad", name: "Bad" },
              { id: "Good2", type: "Part::Box", name: "Good2", properties: [], relationships: [] }
            ],
            inspectionErrors: [{ kind: "object_unavailable", objectId: "Ghost", message: "RuntimeError: shape is invalid" }]
          }
        };
      }
      return fake.runOperation(operation, params);
    };
    const { adapter } = buildAdapter({}, { ...fake, runOperation: mixedRunOperation });
    const session = await connect(adapter);
    const result = await adapter.listObjects(session);
    assert.equal(result.status, "success");
    const objects = result.data as EnvironmentObject[];
    assert.deepEqual(
      objects.map((object) => object.id).sort(),
      ["Good1", "Good2"]
    );
    const warnings = result.metadata.warnings as string[];
    assert.ok(warnings.some((warning) => warning.includes("malformed object")));
    const inspectionErrors = result.metadata.inspectionErrors as Array<{ kind: string; objectId: string | null }>;
    assert.equal(inspectionErrors.length, 1);
    assert.equal(inspectionErrors[0]!.objectId, "Ghost");
  });
});

describe("createFreeCadAdapter: inspectDocument (Phase 13)", () => {
  it("reports a well-formed EnvironmentDocumentInspection built from the runtime's document summary", async () => {
    const { adapter } = buildAdapter();
    const session = await connect(adapter);
    const result = await adapter.inspectDocument(session);
    assert.equal(result.status, "success");
    const inspection = result.data as {
      environmentKind: string;
      objectCount: number;
      objectIds: string[];
      environmentVersion: string | null;
    };
    assert.equal(inspection.environmentKind, "freecad");
    assert.equal(inspection.objectCount, 1);
    assert.deepEqual(inspection.objectIds, ["Box"]);
    assert.equal(inspection.environmentVersion, "1.1.3-fake");
  });

  it("fails deterministically with not_connected on a disconnected session, never invoking the runtime", async () => {
    const { adapter, fake } = buildAdapter();
    const session = await connect(adapter);
    await adapter.disconnect(session);
    const callsBefore = fake.calls.length;
    const result = await adapter.inspectDocument(session);
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "not_connected");
    assert.equal(fake.calls.length, callsBefore);
  });

  it("a runtime-level failure surfaces as a structured error, never a fake empty inspection", async () => {
    const fake = buildFakeRuntime();
    const failingRunOperation = async (operation: string, params: Record<string, unknown>) => {
      if (operation === "inspect_document") return { status: "error" as const, kind: "environment_failure" as const, message: "document closed unexpectedly" };
      return fake.runOperation(operation, params);
    };
    const { adapter } = buildAdapter({}, { ...fake, runOperation: failingRunOperation });
    const session = await connect(adapter);
    const result = await adapter.inspectDocument(session);
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /document closed unexpectedly/);
  });
});

describe("createFreeCadAdapter: save", () => {
  it("save() genuinely calls into the runtime and succeeds", async () => {
    const { adapter, fake } = buildAdapter();
    const session = await connect(adapter);
    const result = await adapter.save(session);
    assert.equal(result.status, "success");
    assert.ok(fake.calls.some((call) => call.operation === "save"));
  });

  it("a runtime-reported save failure surfaces as a structured error, never a false success", async () => {
    const fake = buildFakeRuntime();
    const failingSave = async (operation: string, params: Record<string, unknown>): Promise<FreeCadRuntimeResult> => {
      if (operation === "save") return { status: "error", kind: "environment_failure", message: "disk full" };
      return fake.runOperation(operation, params);
    };
    const { adapter } = buildAdapter({}, { ...fake, runOperation: failingSave });
    const session = await connect(adapter);
    const result = await adapter.save(session);
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /disk full/);
  });
});
