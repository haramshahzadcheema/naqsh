import type { EnvironmentAdapter } from "@naqsh/core";
import { createInMemoryEnvironmentAdapter } from "./in-memory-environment.js";

/**
 * A deterministic, in-memory stand-in for a CAD-like environment — full
 * capability set (create/modify/delete/save/checkpoint), matching the P5
 * brief's example: "A CAD system might support: object inspection,
 * parameter modification, geometry creation, relationships, document
 * save." Not a real CAD kernel and never will be — its only job is to let
 * the EnvironmentAdapter contract (core's environment-adapter-contract.ts)
 * be exercised without FreeCAD (P12+) existing yet.
 */
export function createMockCadEnvironment(): EnvironmentAdapter {
  return createInMemoryEnvironmentAdapter({
    descriptor: {
      kind: "mock_cad",
      name: "Mock CAD Environment",
      capabilities: ["create", "modify", "delete", "save", "checkpoint"]
    },
    seedObjects: () => [
      {
        type: "bracket",
        name: "Seed Bracket",
        properties: [
          { key: "thicknessMm", value: 6, readOnly: false },
          { key: "material", value: "Aluminum 6061", readOnly: false },
          { key: "massG", value: 340, readOnly: true }
        ]
      }
    ]
  });
}
