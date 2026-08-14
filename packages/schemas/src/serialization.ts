import type { Approval, AuthorizationDecision, AutonomyGrant, Change, Project, Tool, ToolResult, WorldModelState } from "./types.js";
import {
  assertApproval,
  assertAuthorizationDecision,
  assertAutonomyGrant,
  assertChange,
  assertProject,
  assertTool,
  assertToolResult,
  assertWorldModelState,
  WorldModelValidationError
} from "./validators.js";

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

export function serializeChange(change: Change): string {
  assertChange(change);
  return JSON.stringify(change);
}

export function deserializeChange(serialized: string): Change {
  requireNonEmptyString(serialized, "serialized change is required");
  const parsed: unknown = JSON.parse(serialized);
  assertChange(parsed);
  return parsed;
}

export function serializeTool(tool: Tool): string {
  assertTool(tool);
  return JSON.stringify(tool);
}

export function deserializeTool(serialized: string): Tool {
  requireNonEmptyString(serialized, "serialized tool is required");
  const parsed: unknown = JSON.parse(serialized);
  assertTool(parsed);
  return parsed;
}

export function serializeToolResult(result: ToolResult): string {
  assertToolResult(result);
  return JSON.stringify(result);
}

export function deserializeToolResult(serialized: string): ToolResult {
  requireNonEmptyString(serialized, "serialized tool result is required");
  const parsed: unknown = JSON.parse(serialized);
  assertToolResult(parsed);
  return parsed;
}

export function serializeApproval(approval: Approval): string {
  assertApproval(approval);
  return JSON.stringify(approval);
}

export function deserializeApproval(serialized: string): Approval {
  requireNonEmptyString(serialized, "serialized approval is required");
  const parsed: unknown = JSON.parse(serialized);
  assertApproval(parsed);
  return parsed;
}

export function serializeAutonomyGrant(grant: AutonomyGrant): string {
  assertAutonomyGrant(grant);
  return JSON.stringify(grant);
}

export function deserializeAutonomyGrant(serialized: string): AutonomyGrant {
  requireNonEmptyString(serialized, "serialized autonomy grant is required");
  const parsed: unknown = JSON.parse(serialized);
  assertAutonomyGrant(parsed);
  return parsed;
}

export function serializeAuthorizationDecision(decision: AuthorizationDecision): string {
  assertAuthorizationDecision(decision);
  return JSON.stringify(decision);
}

export function deserializeAuthorizationDecision(serialized: string): AuthorizationDecision {
  requireNonEmptyString(serialized, "serialized authorization decision is required");
  const parsed: unknown = JSON.parse(serialized);
  assertAuthorizationDecision(parsed);
  return parsed;
}
