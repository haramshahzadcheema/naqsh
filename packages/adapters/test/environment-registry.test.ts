import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EnvironmentAdapter } from "@naqsh/core";
import { createDefaultEnvironmentRegistry, createEnvironmentRegistry, EnvironmentRegistryError } from "../src/environment-registry.js";
import { createMockCadEnvironment } from "../src/mock-cad-environment.js";
import { createMockSimulationEnvironment } from "../src/mock-simulation-environment.js";

function fakeAdapter(kind: string): EnvironmentAdapter {
  return {
    describe: () => ({ kind, name: `Fake ${kind}`, version: "0.0.1", capabilities: [], metadata: {} }),
    health: async () => {
      throw new Error("not used in these tests");
    },
    connect: async () => {
      throw new Error("not used in these tests");
    },
    disconnect: async () => {
      throw new Error("not used in these tests");
    },
    listObjects: async () => {
      throw new Error("not used in these tests");
    },
    inspectObject: async () => {
      throw new Error("not used in these tests");
    },
    inspectDocument: async () => {
      throw new Error("not used in these tests");
    },
    createObject: async () => {
      throw new Error("not used in these tests");
    },
    modifyObject: async () => {
      throw new Error("not used in these tests");
    },
    deleteObject: async () => {
      throw new Error("not used in these tests");
    },
    save: async () => {
      throw new Error("not used in these tests");
    },
    checkpoint: async () => {
      throw new Error("not used in these tests");
    },
    restore: async () => {
      throw new Error("not used in these tests");
    }
  };
}

describe("EnvironmentRegistry: registration", () => {
  it("registers and creates an adapter by kind", () => {
    const registry = createEnvironmentRegistry();
    registry.register({ kind: "test_kind", description: "d", create: () => fakeAdapter("test_kind") });
    const adapter = registry.create("test_kind");
    assert.equal(adapter.describe().kind, "test_kind");
  });

  it("rejects an empty/whitespace kind", () => {
    const registry = createEnvironmentRegistry();
    assert.throws(() => registry.register({ kind: "", description: "d", create: () => fakeAdapter("x") }), EnvironmentRegistryError);
    assert.throws(() => registry.register({ kind: "   ", description: "d", create: () => fakeAdapter("x") }), EnvironmentRegistryError);
  });

  it("rejects a duplicate registration -- no silent overwrite", () => {
    const registry = createEnvironmentRegistry();
    registry.register({ kind: "dup", description: "d", create: () => fakeAdapter("dup") });
    assert.throws(
      () => registry.register({ kind: "dup", description: "d2", create: () => fakeAdapter("dup") }),
      (error: unknown) => error instanceof EnvironmentRegistryError && error.kind === "duplicate_registration"
    );
  });

  it("throws unknown_environment for an unregistered kind", () => {
    const registry = createEnvironmentRegistry();
    assert.throws(() => registry.create("nonexistent"), (error: unknown) => error instanceof EnvironmentRegistryError && error.kind === "unknown_environment");
  });

  it("throws identity_mismatch if the constructed adapter's own describe().kind disagrees with the registration key", () => {
    const registry = createEnvironmentRegistry();
    registry.register({ kind: "advertised", description: "d", create: () => fakeAdapter("actually_different") });
    assert.throws(() => registry.create("advertised"), (error: unknown) => error instanceof EnvironmentRegistryError && error.kind === "identity_mismatch");
  });

  it("has() reflects registration state", () => {
    const registry = createEnvironmentRegistry();
    assert.equal(registry.has("x"), false);
    registry.register({ kind: "x", description: "d", create: () => fakeAdapter("x") });
    assert.equal(registry.has("x"), true);
  });

  it("list() returns every registered kind + description, in registration order, without constructing any adapter", () => {
    const registry = createEnvironmentRegistry();
    let constructCount = 0;
    registry.register({
      kind: "a",
      description: "A env",
      create: () => {
        constructCount += 1;
        return fakeAdapter("a");
      }
    });
    registry.register({ kind: "b", description: "B env", create: () => fakeAdapter("b") });
    assert.deepEqual(registry.list(), [
      { kind: "a", description: "A env" },
      { kind: "b", description: "B env" }
    ]);
    assert.equal(constructCount, 0, "list() must never construct an adapter as a side effect");
  });

  it("create() returns a FRESH adapter instance every call -- no caching, no shared instance", () => {
    const registry = createEnvironmentRegistry();
    let constructCount = 0;
    registry.register({
      kind: "counted",
      description: "d",
      create: () => {
        constructCount += 1;
        return fakeAdapter("counted");
      }
    });
    registry.create("counted");
    registry.create("counted");
    assert.equal(constructCount, 2);
  });

  it("two independent registries never share registrations", () => {
    const registryOne = createEnvironmentRegistry();
    const registryTwo = createEnvironmentRegistry();
    registryOne.register({ kind: "only_in_one", description: "d", create: () => fakeAdapter("only_in_one") });
    assert.equal(registryOne.has("only_in_one"), true);
    assert.equal(registryTwo.has("only_in_one"), false);
  });
});

describe("createDefaultEnvironmentRegistry: the known set this repository ships", () => {
  it("registers exactly mock_cad, mock_simulation, mock, and freecad", () => {
    const registry = createDefaultEnvironmentRegistry();
    const kinds = registry.list().map((entry) => entry.kind);
    assert.deepEqual(kinds.sort(), ["freecad", "mock", "mock_cad", "mock_simulation"]);
  });

  it("constructs a genuinely working mock_cad adapter matching createMockCadEnvironment()'s own capability profile", async () => {
    const registry = createDefaultEnvironmentRegistry();
    const adapter = registry.create("mock_cad");
    const reference = createMockCadEnvironment();
    assert.deepEqual(adapter.describe().capabilities.sort(), reference.describe().capabilities.sort());
  });

  it("constructs a genuinely working mock_simulation adapter matching createMockSimulationEnvironment()'s own capability profile", async () => {
    const registry = createDefaultEnvironmentRegistry();
    const adapter = registry.create("mock_simulation");
    const reference = createMockSimulationEnvironment();
    assert.deepEqual(adapter.describe().capabilities.sort(), reference.describe().capabilities.sort());
  });

  it("freecad is constructible without a real FreeCAD installation (only calling it would require one)", () => {
    const registry = createDefaultEnvironmentRegistry();
    const adapter = registry.create("freecad");
    assert.equal(adapter.describe().kind, "freecad");
  });
});
