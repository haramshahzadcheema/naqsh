import type { Project, WorldModelState } from "./types.js";
import { assertProject, assertWorldModelState, WorldModelValidationError } from "./validators.js";

function requireNonEmptyString(value: string, message: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WorldModelValidationError(message);
  }
}

export function serializeProject(project: Project): string {
  assertProject(project);
  return JSON.stringify(project);
}

export function deserializeProject(serialized: string): Project {
  requireNonEmptyString(serialized, "serialized project is required");
  const parsed: unknown = JSON.parse(serialized);
  assertProject(parsed);
  return parsed;
}

export function serializeWorldModelState(state: WorldModelState): string {
  assertWorldModelState(state);
  return JSON.stringify(state);
}

export function deserializeWorldModelState(serialized: string): WorldModelState {
  requireNonEmptyString(serialized, "serialized state is required");
  const parsed: unknown = JSON.parse(serialized);
  assertWorldModelState(parsed);
  return parsed;
}
