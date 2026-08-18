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
 * Every operation targets `create_environment_object` (P20's new tool) --
 * kept as an explicit field (not hardcoded into the executor) so a future
 * phase that adds other build-capable tools doesn't need to change this
 * function's shape, only what it returns.
 *
 * Ordering is simply `design.expectedOutputs`' own array order -- no
 * dependency graph, matching the brief's own "do not build a full DAG
 * scheduler" instruction (Step 19). `build-executor.ts` runs operations in
 * this order and stops at the first failure, which is sufficient without
 * one.
 */
export function planBuildOperations(design: DesignSpecification): BuildOperationInput[] {
  const componentById = new Map(design.components.map((component) => [component.id, component]));

  return design.expectedOutputs.map((output) => {
    const component = componentById.get(output.componentId);
    return {
      expectedOutputId: output.id,
      toolName: "create_environment_object",
      input: {
        type: output.environmentObjectType,
        name: component ? component.name : output.componentId,
        genericType: output.environmentGenericType,
        properties: output.properties
      }
    };
  });
}
