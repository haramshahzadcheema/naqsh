import { WorldModelValidationError } from "./errors.js";
import type { ToolValueSchema } from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates that `value` is itself a well-formed `ToolValueSchema`
 * DEFINITION (not a value being checked against one). Recursive: an
 * "object" schema's `properties` and an "array" schema's `items` must
 * themselves be valid schemas. This is what `assertTool` runs against a
 * Tool's `inputSchema`/`outputSchema` at registration time, so a malformed
 * schema fails at REGISTER time, not silently at first execution.
 */
export function assertValidToolValueSchema(value: unknown, path = "schema"): asserts value is ToolValueSchema {
  if (!isPlainObject(value)) {
    throw new WorldModelValidationError("invalid_shape", `${path} must be an object`);
  }
  if (value.description !== undefined && typeof value.description !== "string") {
    throw new WorldModelValidationError("invalid_shape", `${path}.description must be a string`);
  }
  if (value.nullable !== undefined && typeof value.nullable !== "boolean") {
    throw new WorldModelValidationError("invalid_shape", `${path}.nullable must be a boolean`);
  }
  switch (value.type) {
    case "string": {
      if (value.enum !== undefined) {
        if (!Array.isArray(value.enum) || !value.enum.every((item) => typeof item === "string")) {
          throw new WorldModelValidationError("invalid_shape", `${path}.enum must be an array of strings`);
        }
      }
      return;
    }
    case "number":
    case "boolean":
    case "null":
      return;
    case "array": {
      assertValidToolValueSchema(value.items, `${path}.items`);
      return;
    }
    case "object": {
      if (!isPlainObject(value.properties)) {
        throw new WorldModelValidationError("invalid_shape", `${path}.properties must be an object`);
      }
      for (const [key, propertySchema] of Object.entries(value.properties)) {
        assertValidToolValueSchema(propertySchema, `${path}.properties.${key}`);
      }
      if (value.required !== undefined) {
        if (!Array.isArray(value.required) || !value.required.every((item) => typeof item === "string")) {
          throw new WorldModelValidationError("invalid_shape", `${path}.required must be an array of strings`);
        }
        for (const key of value.required) {
          if (!(key in value.properties)) {
            throw new WorldModelValidationError("invalid_shape", `${path}.required references unknown property "${key}"`);
          }
        }
      }
      if (value.additionalProperties !== undefined && typeof value.additionalProperties !== "boolean") {
        throw new WorldModelValidationError("invalid_shape", `${path}.additionalProperties must be a boolean`);
      }
      return;
    }
    default:
      throw new WorldModelValidationError(
        "invalid_shape",
        `${path}.type must be one of string, number, boolean, null, array, object`
      );
  }
}

/**
 * Validates `value` against `schema`, returning every violation found
 * (empty array = valid) rather than stopping at the first one — a tool
 * caller (eventually an agent) benefits from seeing all problems with a
 * malformed call at once, not one at a time across retries.
 */
export function matchesToolValueSchema(schema: ToolValueSchema, value: unknown, path = "value"): string[] {
  if (schema.nullable && value === null) {
    return [];
  }
  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") return [`${path} must be a string`];
      if (schema.enum && !schema.enum.includes(value)) {
        return [`${path} must be one of: ${schema.enum.join(", ")}`];
      }
      return [];
    }
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? [] : [`${path} must be a finite number`];
    case "boolean":
      return typeof value === "boolean" ? [] : [`${path} must be a boolean`];
    case "null":
      return value === null ? [] : [`${path} must be null`];
    case "array": {
      if (!Array.isArray(value)) return [`${path} must be an array`];
      return value.flatMap((item, index) => matchesToolValueSchema(schema.items, item, `${path}[${index}]`));
    }
    case "object": {
      if (!isPlainObject(value)) return [`${path} must be an object`];
      const errors: string[] = [];
      for (const key of schema.required ?? []) {
        if (!(key in value)) {
          errors.push(`${path}.${key} is required`);
        }
      }
      for (const [key, propertySchema] of Object.entries(schema.properties)) {
        if (key in value) {
          errors.push(...matchesToolValueSchema(propertySchema, value[key], `${path}.${key}`));
        }
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(key in schema.properties)) {
            errors.push(`${path}.${key} is not an allowed property`);
          }
        }
      }
      return errors;
    }
    default: {
      const exhaustiveCheck: never = schema;
      throw new WorldModelValidationError("invalid_shape", `Unsupported tool value schema type: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export function assertMatchesToolValueSchema(schema: ToolValueSchema, value: unknown, path = "value"): void {
  const errors = matchesToolValueSchema(schema, value, path);
  if (errors.length > 0) {
    throw new WorldModelValidationError("invalid_shape", errors.join("; "));
  }
}
