export type StyleId = "balanced" | "concise" | "detailed" | "technical" | "creative";

export interface StyleOption {
  id: StyleId;
  label: string;
  description: string;
}

/** How Naqsh phrases its own built-in acknowledgements (see
 * `chat/naqshReply.ts`) -- separate from model selection (`settings/models.ts`).
 * A live model connection would use this as a system-prompt style
 * instruction; today it directly picks from a small phrase table, which is
 * a real (if modest) effect rather than a purely cosmetic setting. */
export const STYLE_OPTIONS: StyleOption[] = [
  { id: "balanced", label: "Balanced", description: "Clear and even-handed — the default." },
  { id: "concise", label: "Concise", description: "As few words as possible." },
  { id: "detailed", label: "Detailed", description: "Explains more of the reasoning." },
  { id: "technical", label: "Technical", description: "Terse, engineering-register phrasing." },
  { id: "creative", label: "Creative", description: "A little more personality." }
];

export const DEFAULT_STYLE: StyleId = "balanced";
