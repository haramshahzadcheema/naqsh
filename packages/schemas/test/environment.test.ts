import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertEnvironmentDescriptor,
  assertEnvironmentDocumentInspection,
  assertEnvironmentObjectGeometry,
  assertEnvironmentOperationResult,
  assertEnvironmentSession,
  createEnvironmentDescriptor,
  createEnvironmentDocumentInspection,
  createEnvironmentHealth,
  createEnvironmentInspectionError,
  createEnvironmentObject,
  createEnvironmentObjectGeometry,
  createEnvironmentOperationResult,
  createEnvironmentProperty,
  createEnvironmentRelationship,
  createEnvironmentSession,
  deserializeEnvironmentDocumentInspection,
  deserializeEnvironmentObject,
  deserializeEnvironmentOperationResult,
  deserializeEnvironmentSession,
  serializeEnvironmentDocumentInspection,
  serializeEnvironmentObject,
  serializeEnvironmentOperationResult,
  serializeEnvironmentSession,
  UNAVAILABLE_ENVIRONMENT_GEOMETRY,
  WorldModelValidationError,
  type EnvironmentDescriptorInput
} from "../src/index.js";

function buildDescriptorInput(overrides: Partial<EnvironmentDescriptorInput> = {}): EnvironmentDescriptorInput {
  return {
    kind: "mock_cad",
    name: "Mock CAD",
    capabilities: ["create", "modify"],
    ...overrides
  };
}

describe("EnvironmentDescriptor: creation and validation", () => {
  it("creates a valid descriptor with defaults", () => {
    const descriptor = createEnvironmentDescriptor(buildDescriptorInput());
    assert.equal(descriptor.version, "0.1.0");
    assert.deepEqual(descriptor.metadata, {});
    assert.deepEqual(descriptor.capabilities, ["create", "modify"]);
  });

  it("rejects an empty kind", () => {
    assert.throws(
      () => createEnvironmentDescriptor(buildDescriptorInput({ kind: "" })),
      /environmentDescriptor.kind is required/
    );
  });

  it("rejects an empty name", () => {
    assert.throws(
      () => createEnvironmentDescriptor(buildDescriptorInput({ name: "" })),
      /environmentDescriptor.name is required/
    );
  });

  it("rejects an unknown capability", () => {
    assert.throws(
      () => assertEnvironmentDescriptor({ ...createEnvironmentDescriptor(buildDescriptorInput()), capabilities: ["fly"] }),
      /capabilities must be an array of valid capabilities/
    );
  });

  it("rejects duplicate capabilities", () => {
    assert.throws(
      () => createEnvironmentDescriptor(buildDescriptorInput({ capabilities: ["create", "create"] })),
      /capabilities must not contain duplicates/
    );
  });

  it("rejects a non-JSON-safe metadata field", () => {
    assert.throws(
      () => createEnvironmentDescriptor(buildDescriptorInput({ metadata: { onDone: () => {} } as never })),
      /metadata must be a JSON-serializable object/
    );
  });

  it("freezes the returned descriptor, including the capabilities array", () => {
    const descriptor = createEnvironmentDescriptor(buildDescriptorInput());
    assert.throws(() => {
      (descriptor as { name: string }).name = "renamed";
    }, TypeError);
  });
});

describe("EnvironmentSession: creation, validation, and round-trip", () => {
  it("creates a connected session with defaults", () => {
    const session = createEnvironmentSession({ environmentKind: "mock_cad" });
    assert.match(session.id, /^envsess_/);
    assert.equal(session.status, "connected");
    assert.equal(session.documentName, null);
  });

  it("rejects an invalid status", () => {
    assert.throws(
      () => assertEnvironmentSession({ ...createEnvironmentSession({ environmentKind: "mock_cad" }), status: "paused" }),
      /invalid environment session status/
    );
  });

  it("rejects a non-string, non-null documentName", () => {
    assert.throws(
      () => createEnvironmentSession({ environmentKind: "mock_cad", documentName: 5 as never }),
      /documentName must be a string or null/
    );
  });

  it("accepts an explicit documentName", () => {
    const session = createEnvironmentSession({ environmentKind: "mock_cad", documentName: "bracket.FCStd" });
    assert.equal(session.documentName, "bracket.FCStd");
  });

  it("round-trips through JSON with full fidelity", () => {
    const session = createEnvironmentSession({ environmentKind: "mock_cad", documentName: "bracket.FCStd" });
    assert.deepEqual(deserializeEnvironmentSession(serializeEnvironmentSession(session)), session);
  });
});

describe("EnvironmentProperty and EnvironmentRelationship: creation and validation", () => {
  it("creates a writable property with defaults", () => {
    const property = createEnvironmentProperty({ key: "material", value: null });
    assert.equal(property.value, null);
    assert.equal(property.readOnly, false);
  });

  it("rejects an empty key", () => {
    assert.throws(() => createEnvironmentProperty({ key: "", value: null }), /environmentProperty.key is required/);
  });

  it("rejects a non-JSON-safe value", () => {
    assert.throws(
      () => createEnvironmentProperty({ key: "onDone", value: (() => {}) as never }),
      /environmentProperty.value must be JSON-serializable/
    );
  });

  it("creates a relationship with default metadata", () => {
    const relationship = createEnvironmentRelationship({ type: "mates_with", targetId: "envobj_2" });
    assert.deepEqual(relationship.metadata, {});
  });

  it("rejects an empty relationship targetId", () => {
    assert.throws(
      () => createEnvironmentRelationship({ type: "mates_with", targetId: "" }),
      /environmentRelationship.targetId is required/
    );
  });
});

describe("EnvironmentObject: creation, validation, and round-trip", () => {
  it("creates an object with nested properties and relationships validated", () => {
    const object = createEnvironmentObject({
      type: "part",
      name: "Bracket",
      properties: [
        { key: "massG", value: 42, readOnly: true },
        { key: "material", value: "aluminum" }
      ],
      relationships: [{ type: "mates_with", targetId: "envobj_other" }]
    });
    assert.match(object.id, /^envobj_/);
    assert.equal(object.properties.length, 2);
    assert.equal(object.properties[0]?.readOnly, true);
    assert.equal(object.relationships[0]?.type, "mates_with");
  });

  it("rejects a malformed nested property", () => {
    assert.throws(
      () => createEnvironmentObject({ type: "part", name: "Bracket", properties: [{ key: "", value: null }] }),
      /environmentProperty.key is required/
    );
  });

  it("rejects a malformed nested relationship", () => {
    assert.throws(
      () => createEnvironmentObject({ type: "part", name: "Bracket", relationships: [{ type: "", targetId: "x" }] }),
      /environmentRelationship.type is required/
    );
  });

  it("freezes the returned object AND its nested properties", () => {
    const object = createEnvironmentObject({ type: "part", name: "Bracket", properties: [{ key: "material", value: null }] });
    assert.throws(() => {
      (object as { name: string }).name = "renamed";
    }, TypeError);
    assert.throws(() => {
      (object.properties[0] as { value: unknown }).value = "steel";
    }, TypeError);
  });

  it("round-trips through JSON with full fidelity", () => {
    const object = createEnvironmentObject({
      type: "part",
      name: "Bracket",
      properties: [{ key: "material", value: "aluminum" }],
      relationships: [{ type: "mates_with", targetId: "envobj_other" }]
    });
    assert.deepEqual(deserializeEnvironmentObject(serializeEnvironmentObject(object)), object);
  });

  it("Phase 13: defaults genericType/parentId/visible/geometry honestly when a caller supplies none", () => {
    const object = createEnvironmentObject({ type: "part", name: "Bracket" });
    assert.equal(object.genericType, "unknown");
    assert.equal(object.parentId, null);
    assert.equal(object.visible, null);
    assert.deepEqual(object.geometry, UNAVAILABLE_ENVIRONMENT_GEOMETRY);
  });

  it("Phase 13: accepts an explicit genericType/parentId/visible/geometry", () => {
    const object = createEnvironmentObject({
      type: "Part::Box",
      name: "Box1",
      genericType: "solid",
      parentId: "envobj_group",
      visible: false,
      geometry: { available: true, valid: true, volume: 1000, solidCount: 1 }
    });
    assert.equal(object.genericType, "solid");
    assert.equal(object.parentId, "envobj_group");
    assert.equal(object.visible, false);
    assert.equal(object.geometry.available, true);
    assert.equal(object.geometry.volume, 1000);
    // Unsupplied geometry fields still default to null, not undefined/missing.
    assert.equal(object.geometry.surfaceArea, null);
  });

  it("Phase 13: rejects an invalid genericType", () => {
    assert.throws(
      () => createEnvironmentObject({ type: "part", name: "x", genericType: "spaceship" as never }),
      /invalid environmentObject.genericType/
    );
  });

  it("Phase 13: rejects a malformed geometry.boundingBox", () => {
    assert.throws(
      () =>
        createEnvironmentObject({
          type: "part",
          name: "x",
          geometry: { available: true, boundingBox: { min: { x: 0, y: 0, z: 0 } } as never }
        }),
      /environmentBoundingBox.max/
    );
  });

  it("Phase 13: round-trips the new fields through JSON with full fidelity", () => {
    const object = createEnvironmentObject({
      type: "Part::Box",
      name: "Box1",
      genericType: "solid",
      parentId: "envobj_group",
      visible: true,
      geometry: {
        available: true,
        valid: true,
        boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } },
        volume: 1000,
        surfaceArea: 600,
        centerOfMass: { x: 5, y: 5, z: 5 },
        solidCount: 1,
        faceCount: 6,
        edgeCount: 12,
        vertexCount: 8,
        shapeType: "Solid"
      }
    });
    assert.deepEqual(deserializeEnvironmentObject(serializeEnvironmentObject(object)), object);
  });
});

describe("EnvironmentObjectGeometry: creation and validation", () => {
  it("defaults to a fully unavailable geometry value", () => {
    const geometry = createEnvironmentObjectGeometry();
    assert.deepEqual(geometry, UNAVAILABLE_ENVIRONMENT_GEOMETRY);
  });

  it("rejects a non-number volume", () => {
    assert.throws(
      () => assertEnvironmentObjectGeometry({ ...createEnvironmentObjectGeometry(), volume: "a lot" }),
      /volume must be a number or null/
    );
  });

  it("rejects a non-vector centerOfMass", () => {
    assert.throws(
      () => assertEnvironmentObjectGeometry({ ...createEnvironmentObjectGeometry(), centerOfMass: { x: 1 } }),
      /centerOfMass must be an .x,y,z. vector of numbers or null/
    );
  });
});

describe("EnvironmentHealth: creation and validation", () => {
  it("creates health with defaults", () => {
    const health = createEnvironmentHealth({ status: "healthy" });
    assert.equal(health.message, "");
    assert.ok(health.checkedAt.length > 0);
  });

  it("rejects an invalid status", () => {
    assert.throws(() => createEnvironmentHealth({ status: "thriving" as never }), /invalid environment health status/);
  });
});

describe("EnvironmentOperationResult: creation, validation, and round-trip", () => {
  it("creates a success result with a null error", () => {
    const result = createEnvironmentOperationResult({
      operation: "list_objects",
      sessionId: "envsess_1",
      status: "success",
      data: [],
      startedAt: new Date().toISOString()
    });
    assert.equal(result.error, null);
    assert.match(result.id, /^envop_/);
  });

  it("rejects a success result carrying a non-null error", () => {
    assert.throws(
      () =>
        assertEnvironmentOperationResult({
          ...createEnvironmentOperationResult({
            operation: "list_objects",
            status: "success",
            startedAt: new Date().toISOString()
          }),
          error: { kind: "conflict", message: "x" }
        }),
      /error must be null when status is success/
    );
  });

  it("requires a structured, validly-kinded error for an error result", () => {
    assert.throws(
      () =>
        createEnvironmentOperationResult({
          operation: "list_objects",
          status: "error",
          startedAt: new Date().toISOString()
        }),
      /environment operation error must be an object/
    );
  });

  it("accepts every documented EnvironmentErrorKind, including the not-yet-produced 'conflict' kind", () => {
    const kinds = [
      "not_connected",
      "object_not_found",
      "unsupported_capability",
      "invalid_operation",
      "environment_failure",
      "conflict"
    ] as const;
    for (const kind of kinds) {
      const result = createEnvironmentOperationResult({
        operation: "modify_object",
        status: "error",
        error: { kind, message: `example ${kind}` },
        startedAt: new Date().toISOString()
      });
      assert.equal(result.error?.kind, kind);
    }
  });

  it("rejects an invalid operation kind", () => {
    assert.throws(
      () =>
        createEnvironmentOperationResult({
          operation: "run_simulation" as never,
          status: "success",
          startedAt: new Date().toISOString()
        }),
      WorldModelValidationError
    );
  });

  it("rejects a function hidden inside data (JSON-safety)", () => {
    assert.throws(
      () =>
        createEnvironmentOperationResult({
          operation: "list_objects",
          status: "success",
          data: { onDone: () => {} },
          startedAt: new Date().toISOString()
        }),
      /data must be JSON-serializable/
    );
  });

  it("round-trips through JSON with full fidelity", () => {
    const result = createEnvironmentOperationResult({
      operation: "modify_object",
      sessionId: "envsess_1",
      objectId: "envobj_1",
      status: "success",
      data: { key: "material", value: "steel" },
      startedAt: new Date().toISOString()
    });
    assert.deepEqual(deserializeEnvironmentOperationResult(serializeEnvironmentOperationResult(result)), result);
  });

  it("Phase 13: accepts the new 'inspect_document' operation kind", () => {
    const result = createEnvironmentOperationResult({
      operation: "inspect_document",
      status: "success",
      data: null,
      startedAt: new Date().toISOString()
    });
    assert.equal(result.operation, "inspect_document");
  });
});

describe("EnvironmentInspectionError: creation and validation", () => {
  it("creates a well-formed inspection error with a null objectId default", () => {
    const error = createEnvironmentInspectionError({ kind: "object_unavailable", message: "shape is invalid" });
    assert.equal(error.objectId, null);
    assert.equal(error.kind, "object_unavailable");
  });

  it("accepts every documented EnvironmentInspectionErrorKind", () => {
    const kinds = [
      "object_unavailable",
      "unsupported_object_type",
      "property_inspection_failed",
      "relationship_inspection_failed",
      "geometry_inspection_failed",
      "serialization_failed"
    ] as const;
    for (const kind of kinds) {
      const error = createEnvironmentInspectionError({ kind, message: `example ${kind}` });
      assert.equal(error.kind, kind);
    }
  });

  it("rejects an invalid kind", () => {
    assert.throws(
      () => createEnvironmentInspectionError({ kind: "gremlin" as never, message: "x" }),
      /invalid environment inspection error kind/
    );
  });
});

describe("EnvironmentDocumentInspection: creation, validation, and round-trip", () => {
  function buildInspectionInput() {
    return {
      environmentKind: "freecad",
      objectCount: 2,
      objectIds: ["Box1", "Cut"],
      rootObjectIds: ["Cut"]
    };
  }

  it("creates a well-formed inspection with defaults", () => {
    const inspection = createEnvironmentDocumentInspection(buildInspectionInput());
    assert.equal(inspection.documentId, null);
    assert.equal(inspection.documentName, null);
    assert.equal(inspection.filePath, null);
    assert.deepEqual(inspection.warnings, []);
    assert.deepEqual(inspection.unsupportedFeatures, []);
    assert.deepEqual(inspection.inspectionErrors, []);
    assert.ok(inspection.inspectedAt.length > 0);
  });

  it("Phase 13 Step 18: an empty document (zero objects) is a valid inspection, not an error", () => {
    const inspection = createEnvironmentDocumentInspection({
      environmentKind: "freecad",
      objectCount: 0,
      objectIds: [],
      rootObjectIds: []
    });
    assert.equal(inspection.objectCount, 0);
  });

  it("rejects a mismatched objectIds length vs objectCount", () => {
    assert.throws(
      () => createEnvironmentDocumentInspection({ ...buildInspectionInput(), objectCount: 5 }),
      /objectIds length must match objectCount/
    );
  });

  it("rejects a rootObjectIds entry that isn't in objectIds", () => {
    assert.throws(
      () => createEnvironmentDocumentInspection({ ...buildInspectionInput(), rootObjectIds: ["Ghost"] }),
      /rootObjectIds must be a subset of objectIds/
    );
  });

  it("rejects a negative objectCount", () => {
    assert.throws(
      () => createEnvironmentDocumentInspection({ ...buildInspectionInput(), objectCount: -1, objectIds: [] }),
      /objectCount must be a non-negative integer/
    );
  });

  it("carries structured inspectionErrors alongside a successful inspection (Phase 13 Step 16 partial success)", () => {
    const inspection = createEnvironmentDocumentInspection({
      ...buildInspectionInput(),
      inspectionErrors: [{ kind: "object_unavailable", objectId: "Ghost", message: "shape is invalid" }]
    });
    assert.equal(inspection.inspectionErrors.length, 1);
    assert.equal(inspection.inspectionErrors[0]?.objectId, "Ghost");
  });

  it("freezes the returned inspection, including nested inspectionErrors", () => {
    const inspection = createEnvironmentDocumentInspection({
      ...buildInspectionInput(),
      inspectionErrors: [{ kind: "object_unavailable", message: "x" }]
    });
    assert.throws(() => {
      (inspection as { objectCount: number }).objectCount = 99;
    }, TypeError);
    assert.throws(() => {
      (inspection.inspectionErrors[0] as { message: string }).message = "changed";
    }, TypeError);
  });

  it("round-trips through JSON with full fidelity", () => {
    const inspection = createEnvironmentDocumentInspection({
      environmentKind: "freecad",
      documentId: "my_doc",
      documentName: "My Document",
      filePath: "C:\\models\\bracket.FCStd",
      objectCount: 2,
      objectIds: ["Box1", "Cut"],
      rootObjectIds: ["Cut"],
      environmentVersion: "1.1.3",
      warnings: ["one property could not be read"],
      unsupportedFeatures: ["TechDraw pages"],
      inspectionErrors: [{ kind: "property_inspection_failed", objectId: "Box1", message: "x" }]
    });
    assert.deepEqual(deserializeEnvironmentDocumentInspection(serializeEnvironmentDocumentInspection(inspection)), inspection);
  });

  it("assertEnvironmentDocumentInspection rejects a non-object", () => {
    assert.throws(() => assertEnvironmentDocumentInspection(null), /environment document inspection must be an object/);
  });
});
