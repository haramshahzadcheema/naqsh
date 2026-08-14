import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertEnvironmentDescriptor,
  assertEnvironmentOperationResult,
  assertEnvironmentSession,
  createEnvironmentDescriptor,
  createEnvironmentHealth,
  createEnvironmentObject,
  createEnvironmentOperationResult,
  createEnvironmentProperty,
  createEnvironmentRelationship,
  createEnvironmentSession,
  deserializeEnvironmentObject,
  deserializeEnvironmentOperationResult,
  deserializeEnvironmentSession,
  serializeEnvironmentObject,
  serializeEnvironmentOperationResult,
  serializeEnvironmentSession,
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
});
