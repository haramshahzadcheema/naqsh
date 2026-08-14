import { randomUUID } from "node:crypto";

const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/**
 * Builds a namespaced entity id, e.g. `req_3f9c...`. A caller-supplied
 * `value` is honored as-is (used by deserialization / fixtures); otherwise a
 * UUID is generated. Namespacing by prefix keeps ids self-describing across
 * logs, events, and cross-environment references without a lookup.
 */
export function createId(prefix: string, value?: string): string {
  if (typeof prefix !== "string" || prefix.length === 0) {
    throw new Error("prefix is required");
  }
  const normalizedValue = value ?? randomUUID();
  if (typeof normalizedValue !== "string" || normalizedValue.length === 0) {
    throw new Error("id value is required");
  }
  return `${prefix}_${normalizedValue}`;
}

export function toIsoTimestamp(date: Date = new Date()): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error("valid date is required");
  }
  return date.toISOString();
}

export function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && ISO_8601_REGEX.test(value);
}
