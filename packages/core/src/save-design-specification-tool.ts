import { assertDesignSpecification, createTool, ToolError, type DesignSpecification, type Tool, type ToolValueSchema } from "@naqsh/schemas";
import type { DesignSpecificationStore } from "./design-specification-store.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * The missing link `generateDesignSpecification` (P20, design-generator.ts)
 * itself deliberately never closes: that function produces a real,
 * shape-validated, semantically-validated `DesignSpecification` and
 * STOPS there (its own doc comment: "generating a design cannot mutate
 * WorldModelState and cannot touch any environment because nothing in
 * this file ever holds a reference to anything that could"). Nothing in
 * this repository ever called `DesignSpecificationStore.save()` before
 * this tool existed -- an audit finding, not a design choice: the
 * generator was fully built and tested, but no caller ever persisted its
 * output anywhere a later `create_candidate`/comparison/experiment could
 * find it.
 *
 * Classified `mutation: "suggest"` -- the exact same classification
 * `create_check`/`create_candidate`/`create_checkpoint` already use for
 * an identical reason: this creates a new, independent, additive record
 * and never touches `WorldModelState` or the live environment.
 *
 * Deliberately NOT a re-implementation of `generateDesignSpecification`'s
 * own validation: `assertDesignSpecification` (schemas) re-checks SHAPE
 * (defense in depth against a caller passing something malformed), but
 * this tool trusts that a `DesignSpecification` reaching it already
 * passed `validateDesignSpecificationSemantics` at generation time --
 * re-running that here would need the same `Plan`/`Requirement`/
 * `Constraint` context the generator already had and already used.
 */
const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    designSpecification: {
      type: "object",
      properties: {},
      additionalProperties: true,
      description: "A complete DesignSpecification, exactly as returned by generateDesignSpecification -- deep-validated by this tool's handler before being saved."
    }
  },
  required: ["designSpecification"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: { designSpecification: { type: "object", properties: {}, additionalProperties: true } },
  required: ["designSpecification"]
};

export function createSaveDesignSpecificationTool(designSpecificationStore: DesignSpecificationStore): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "save_design_specification",
    description:
      "Persists a DesignSpecification that generateDesignSpecification already produced and validated -- makes it findable by planId (listForPlan) and referenceable from a Candidate's designSpecificationId. Never mutates the World Model or the environment; never re-runs design generation itself.",
    target: "world_model",
    mutation: "suggest",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = (rawInput) => {
    const record = rawInput as Record<string, unknown>;
    let designSpecification: DesignSpecification;
    try {
      assertDesignSpecification(record.designSpecification);
      designSpecification = record.designSpecification as DesignSpecification;
    } catch (error) {
      throw new ToolError("invalid_input", `designSpecification is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    designSpecificationStore.save(designSpecification);
    return { designSpecification };
  };

  return { tool, handler };
}
