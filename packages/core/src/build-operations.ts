import type { BuildOperationInput, DesignSpecification } from "@naqsh/schemas";

/**
 * `DesignSpecification` -> a bounded, ORDERED sequence of `BuildOperation`s
 * (P20). Deliberately a PURE, SYNCHRONOUS, deterministic function -- no
 * Gemini call, no I/O -- mirroring `requirement-completeness.ts`'s (P19)
 * identical "translating an already-validated structured object into the
 * next typed step is mechanical, not a new engineering judgment call"
 * reasoning. `generateDesignSpecification` already spent a model call
 * producing a schema- and semantically-validated `DesignSpecification`;
 * turning ITS `expectedOutputs` into concrete tool calls needs no further
 * interpretation.
 *
 * Each output targets EXACTLY ONE of two existing, registered tools,
 * chosen by `ExpectedBuildOutput.targetObjectId` (P26) -- never a new
 * execution mechanism:
 *   `targetObjectId === null` (the original, and still default, shape) --
 *     `create_environment_object` (P20), requiring the "create" capability.
 *   `targetObjectId` set -- one `modify_environment_object` (P11) call PER
 *     entry in `properties` (that tool sets exactly one property per call),
 *     requiring only the "modify" capability. This is what lets a build
 *     target an environment whose object topology is fixed and can only be
 *     PARAMETERIZED, never created into (a simulation's sensors/actuators,
 *     see `mock-simulation-environment.ts` @naqsh/adapters) -- "build" no
 *     longer universally presupposes "create," closing the P26 brief's own
 *     explicit "the experiment model must not require geometry as a
 *     universal prerequisite" gap. An output with `targetObjectId` set but
 *     an EMPTY `properties` object plans zero operations for that output
 *     (nothing to modify) -- never a phantom no-op call.
 *
 * Ordering is simply `design.expectedOutputs`' own array order (and, within
 * a modify-target output, `Object.entries(properties)`'s own order) -- no
 * dependency graph, matching the brief's own "do not build a full DAG
 * scheduler" instruction (Step 19). `build-executor.ts` runs operations in
 * this order and stops at the first failure, which is sufficient without
 * one.
 */
export function planBuildOperations(design: DesignSpecification): BuildOperationInput[] {
  const componentById = new Map(design.components.map((component) => [component.id, component]));
  const operations: BuildOperationInput[] = [];

  for (const output of design.expectedOutputs) {
    const component = componentById.get(output.componentId);

    if (output.targetObjectId === null) {
      operations.push({
        expectedOutputId: output.id,
        toolName: "create_environment_object",
        input: {
          type: output.environmentObjectType,
          name: component ? component.name : output.componentId,
          genericType: output.environmentGenericType,
          properties: output.properties
        }
      });
      continue;
    }

    for (const [propertyKey, value] of Object.entries(output.properties)) {
      operations.push({
        expectedOutputId: output.id,
        toolName: "modify_environment_object",
        input: { objectId: output.targetObjectId, propertyKey, value }
      });
    }
  }

  return operations;
}
