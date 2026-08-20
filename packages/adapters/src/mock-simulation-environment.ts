import type { EnvironmentAdapter } from "@naqsh/core";
import { createInMemoryEnvironmentAdapter } from "./in-memory-environment.js";

/**
 * A deterministic, in-memory stand-in for a simulation-like environment —
 * deliberately a NARROW capability set (modify + checkpoint only: no
 * create/delete/save), matching the P5 brief's example: "A simulator might
 * support: model inspection, parameter modification, execution, result
 * retrieval." Its topology (which sensors/actuators exist) is fixed; only
 * their parameters are tunable. This exists specifically to prove the
 * EnvironmentAdapter contract is genuinely capability-driven and was not
 * secretly designed around CAD — the exact same contract-test suite
 * (core's runEnvironmentAdapterContractTests) runs against this AND
 * mock-cad-environment.ts with entirely different pass/fail behavior per
 * capability-gated test, driven only by `descriptor.capabilities`. "create"/
 * "delete"/"save" all still exercise the genuine `unsupported_capability`
 * path on this adapter — only "checkpoint" was added.
 *
 * P26: "checkpoint" is included (unlike the original P5 profile, modify-
 * only) because a real simulation environment plausibly CAN snapshot/
 * restore its own parameter state around one bounded run (the exact
 * "checkpoint -> mutate -> verify -> rollback/commit" pattern P22's
 * `executeExperimentForCandidate` already requires of every environment it
 * runs a candidate against) without needing to create or delete simulated
 * entities at all — fixed topology, checkpointable state. This is what
 * lets a simulation experiment use the SAME, unmodified P22/P25
 * orchestration a CAD experiment already does, via `ExpectedBuildOutput.
 * targetObjectId` (see `build-operations.ts`, core) planning
 * `modify_environment_object` calls instead of `create_environment_object`
 * — proving "the experiment model must not require geometry as a universal
 * prerequisite" (P26 brief) with real, exercised code, not just a
 * capability declaration nobody actually uses.
 */
export function createMockSimulationEnvironment(): EnvironmentAdapter {
  return createInMemoryEnvironmentAdapter({
    descriptor: {
      kind: "mock_simulation",
      name: "Mock Simulation Environment",
      capabilities: ["modify", "checkpoint"]
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
