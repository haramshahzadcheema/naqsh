import { extractFromOpeningStatement } from "../onboarding/extraction.js";
import type { ExtractionEvent, MessageAttachment } from "../onboarding/types.js";
import type { StyleId } from "../settings/styles.js";

/**
 * Free-form chat, after the guided requirement questions are done (or in
 * the "existing project" thread, where there is no script at all). Same
 * honesty boundary as `extraction.ts`: this is a small pattern matcher,
 * not a live reasoning connection -- there is still no HTTP server behind
 * `apps/api` for a browser to reach P7/P9 through. It still runs the same
 * real `createRequirement`/`createConstraint`-backed extractor, so a
 * message like "actually it needs to hold 80 kg" still turns into a real,
 * validated requirement update. Anything it doesn't recognize gets a
 * short, honest acknowledgement rather than a fabricated insight.
 *
 * `style` picks which phrase variant is used -- a real, if modest, effect
 * of the "AI style" setting (see `settings/styles.ts`); a live model
 * connection would use the same preference as a system-prompt style
 * instruction instead of a lookup table.
 */
const UPDATED_PHRASES: Record<StyleId, string> = {
  balanced: "Got it — updated.",
  concise: "Updated.",
  detailed: "Got it — I've folded that into the requirements. Let me know if anything else needs adjusting.",
  technical: "Requirement delta applied.",
  creative: "Nice — that just became part of the design story."
};

const NOTED_PHRASES: Record<StyleId, string> = {
  balanced: "Noted — I'll keep that in mind.",
  concise: "Noted.",
  detailed: "Noted — I don't see anything I can turn into a requirement or constraint there yet, but I'm keeping track of it.",
  technical: "No structured delta extracted.",
  creative: "Filed that away for later."
};

export function replyTo(text: string, style: StyleId = "balanced"): { reply: string; extractions: ExtractionEvent[] } {
  const extractions = extractFromOpeningStatement(text);
  if (extractions.length > 0) {
    return { reply: UPDATED_PHRASES[style], extractions };
  }
  return { reply: NOTED_PHRASES[style], extractions: [] };
}

/** One honest sentence acknowledging attached files -- named plainly,
 * never claiming Naqsh "reviewed," "analyzed," or "opened" a binary/CAD
 * file it never actually parsed. */
export function describeAttachments(attachments: MessageAttachment[], extractedAnything: boolean): string {
  if (attachments.length === 0) return "";
  const names = attachments.map((a) => `"${a.name}"`).join(", ");
  const hasBinary = attachments.some((a) => a.kind === "binary");

  if (hasBinary) {
    return `Received ${names}. I can't inspect CAD/binary file contents without a live environment connection yet — it's attached for reference.`;
  }
  return extractedAnything ? `Read ${names} and pulled out what I could.` : `Read ${names} — didn't find anything I could turn into a requirement or constraint yet.`;
}
