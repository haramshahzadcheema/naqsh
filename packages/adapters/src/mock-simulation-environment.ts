import type { EnvironmentAdapter } from "@naqsh/core";
import { createInMemoryEnvironmentAdapter } from "./in-memory-environment.js";

/**
 * A deterministic, in-memory stand-in for a simulation-like environment —
 * deliberately a NARROW capability set (modify only: no create/delete/
 * save/checkpoint), matching the P5 brief's example: "A simulator might
 * support: model inspection, parameter modification, execution, result
 * retrieval." Its topology (which sensors/actuators exist) is fixed; only
 * their parameters are tunable. This exists specifically to prove the
 * EnvironmentAdapter contract is genuinely capability-driven and was not
 * secretly designed around CAD — the exact same contract-test suite
 * (core's runEnvironmentAdapterContractTests) runs against this AND
 * mock-cad-environment.ts with entirely different pass/fail behavior per
 * capability-gated test, driven only by `descriptor.capabilities`.
 */
export function createMockSimulationEnvironment(): EnvironmentAdapter {
  return createInMemoryEnvironmentAdapter({
    descriptor: {
      kind: "mock_simulation",
      name: "Mock Simulation Environment",
      capabilities: ["modify"]
    },
    seedObjects: () => [
      {
        type: "sensor",
        name: "Load Sensor 1",
        properties: [
          { key: "setpointN", value: 500, readOnly: false },
          { key: "toleranceN", value: 5, readOnly: false },
          { key: "sampleRateHz", value: 1000, readOnly: true }
        ]
      },
      {
        type: "actuator",
        name: "Actuator 1",
        properties: [{ key: "targetPositionMm", value: 0, readOnly: false }]
      }
    ]
  });
}
