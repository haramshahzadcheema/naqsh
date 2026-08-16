import type { EnvironmentAdapter } from "@naqsh/core";
import { createDeterministicClock, createDeterministicIdGenerator } from "./deterministic.js";
import { createInMemoryEnvironmentAdapter, type CheckpointFaultController } from "./in-memory-environment.js";

export interface MockEnvironmentOptions {
  /** Defaults to a fresh createDeterministicIdGenerator() -- override only
   * for a scenario that needs ids to line up with an external fixture. */
  generateId?: (prefix: string) => string;
  /** Defaults to a fresh createDeterministicClock() -- override only for a
   * scenario that needs specific timestamps. */
  now?: () => string;
  /** Phase 15 test-only fault injection for checkpoint()/restore() --
   * see `CheckpointFaultController`'s own doc comment. Omitted by every
   * caller before P15 and by every production caller after it. */
  checkpointFaults?: CheckpointFaultController;
}

/**
 * P6's canonical deterministic mock environment (NAQSH briefing P6: "the
 * controlled laboratory for testing the rest of NAQSH before real
 * environments exist"). Distinct from the two P5 example adapters
 * (mock-cad-environment.ts, mock-simulation-environment.ts), which exist to
 * prove the EnvironmentAdapter contract tolerates DIFFERENT capability
 * profiles -- this one exists to BE the general-purpose harness later
 * phases (P7+) build and test against, so its defaults favor
 * reproducibility over resembling any particular real environment.
 *
 * `kind: "mock"` and `name: "Deterministic Mock Environment"` are
 * deliberately generic -- nothing here pretends to be FreeCAD or any other
 * real system; `describe()` makes that explicit rather than leaving it
 * implied. Full capability set (create/modify/delete/save/checkpoint) so
 * every operation P7+ might need is actually exercisable.
 *
 * Deterministic BY DEFAULT, not merely deterministic-if-configured: unlike
 * the P5 mocks (which default to real randomness/wall-clock, matching how
 * a real adapter behaves), this one defaults `generateId`/`now` to fresh
 * createDeterministicIdGenerator()/createDeterministicClock() instances.
 * Every `createMockEnvironment()` call gets its OWN counters/clock (no
 * shared module-level state), so two independent instances fed the same
 * sequence of operations produce byte-identical results, while two
 * DIFFERENT instances never interfere with each other.
 *
 * Built on the exact same `createInMemoryEnvironmentAdapter` engine as the
 * P5 mocks, and returns a plain `EnvironmentAdapter` -- there is no
 * separate "mock interface." A tool handler (P6+) calling this adapter
 * goes through the identical `EnvironmentAdapter` contract a real
 * `FreeCADAdapter` (P12+) will satisfy.
 */
export function createMockEnvironment(options: MockEnvironmentOptions = {}): EnvironmentAdapter {
  const generateId = options.generateId ?? createDeterministicIdGenerator();
  const now = options.now ?? createDeterministicClock();

  return createInMemoryEnvironmentAdapter({
    descriptor: {
      kind: "mock",
      name: "Deterministic Mock Environment",
      capabilities: ["create", "modify", "delete", "save", "checkpoint"]
    },
    generateId,
    now,
    checkpointFaults: options.checkpointFaults,
    seedObjects: () => [
      {
        id: "widget_a",
        type: "component",
        name: "Widget A",
        properties: [
          { key: "status", value: "active", readOnly: false },
          { key: "serialNumber", value: "WA-001", readOnly: true }
        ],
        relationships: [{ type: "connected_to", targetId: "widget_b" }]
      },
      {
        id: "widget_b",
        type: "component",
        name: "Widget B",
        properties: [
          { key: "status", value: "idle", readOnly: false },
          { key: "serialNumber", value: "WB-001", readOnly: true }
        ]
      }
    ]
  });
}
