/**
 * A small, deterministic, pattern-based reader of the user's own words —
 * NOT a real NLU/LLM call. It exists to make the "conversation becoming
 * structured engineering state" moment demonstrable without a live model
 * connection: `apps/api` has no HTTP server yet (see `NaqshDataSource.ts`),
 * so there is nothing running P7 (Gemini) or P9 (planning) for a browser
 * client to call during onboarding. Every record this produces is still
 * built through the real `createRequirement`/`createConstraint` factories
 * from `@naqsh/schemas`, so it validates exactly like backend-produced
 * data would — only the *extraction* step is a stand-in, not the data
 * shape. A real implementation would replace this module's callers with a
 * call through the seam, not change what the UI does with the result.
 */
import { createConstraint, createRequirement, type Constraint, type Requirement } from "@naqsh/schemas";
import type { ExtractionEvent } from "./types.js";

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_onb_${counter}`;
}

function parseLoadKg(text: string): number | null {
  const match = /(\d+(?:\.\d+)?)\s*kg\b/i.exec(text);
  return match ? Number(match[1]) : null;
}

function parseEnvelopeMm(text: string): { l: number; w: number; h: number } | null {
  const match = /(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*mm/i.exec(text);
  if (!match) return null;
  return { l: Number(match[1]), w: Number(match[2]), h: Number(match[3]) };
}

function parseFirstMm(text: string): number | null {
  const match = /(\d+(?:\.\d+)?)\s*mm\b/i.exec(text);
  return match ? Number(match[1]) : null;
}

/** Runs against the user's opening statement — looks for a load figure and
 * a bounding envelope, both of which appear as their own requirement
 * chips the moment they're recognized. */
export function extractFromOpeningStatement(text: string): ExtractionEvent[] {
  const events: ExtractionEvent[] = [];

  const loadKg = parseLoadKg(text);
  if (loadKg !== null) {
    const requirement: Requirement = createRequirement({
      id: nextId("req"),
      description: `Must support a load of ${loadKg} kg.`,
      category: "structural",
      value: loadKg,
      unit: "kg",
      priority: "high",
      status: "active",
      source: "human"
    });
    events.push({ id: nextId("ext"), label: "Load capacity", requirement });
  }

  const envelope = parseEnvelopeMm(text);
  if (envelope) {
    const requirement: Requirement = createRequirement({
      id: nextId("req"),
      description: `Must fit within a ${envelope.l} × ${envelope.w} × ${envelope.h} mm envelope.`,
      category: "geometric",
      value: `${envelope.l} × ${envelope.w} × ${envelope.h}`,
      unit: "mm",
      priority: "high",
      status: "active",
      source: "human"
    });
    events.push({ id: nextId("ext"), label: "Envelope", requirement });
  }

  return events;
}

export function extractMaterialAnswer(text: string): ExtractionEvent[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const constraint: Constraint = createConstraint({
    id: nextId("con"),
    description: `Material preference: ${trimmed}.`,
    category: "material",
    value: trimmed,
    unit: null,
    severity: "soft",
    status: "active",
    source: "human"
  });
  return [{ id: nextId("ext"), label: "Material", constraint }];
}

export function extractThicknessAnswer(text: string): ExtractionEvent[] {
  const mm = parseFirstMm(text);
  if (mm === null) return [];
  const requirement: Requirement = createRequirement({
    id: nextId("req"),
    description: `Maximum thickness of ${mm} mm.`,
    category: "geometric",
    value: mm,
    unit: "mm",
    priority: "medium",
    status: "active",
    source: "human"
  });
  return [{ id: nextId("ext"), label: "Max thickness", requirement }];
}

export function extractManufacturingAnswer(text: string): ExtractionEvent[] {
  const trimmed = text.trim();
  if (!trimmed || /^(no|none|n\/a|not really)\.?$/i.test(trimmed)) return [];
  const constraint: Constraint = createConstraint({
    id: nextId("con"),
    description: `Manufacturing constraint: ${trimmed}.`,
    category: "manufacturability",
    value: null,
    unit: null,
    severity: "hard",
    status: "active",
    source: "human"
  });
  return [{ id: nextId("ext"), label: "Manufacturing", constraint }];
}

export interface ScriptStep {
  question: string;
  extract: (text: string) => ExtractionEvent[];
}

/** The fixed question sequence — mirrors P18 (Requirements) / P19
 * (Clarifications): every question here corresponds to a real gap in
 * structured project knowledge, not an arbitrary chatbot prompt. */
export const CONVERSATION_SCRIPT: ScriptStep[] = [
  { question: "What material are you considering?", extract: extractMaterialAnswer },
  { question: "What is the maximum thickness?", extract: extractThicknessAnswer },
  { question: "Are there any manufacturing constraints?", extract: extractManufacturingAnswer }
];
