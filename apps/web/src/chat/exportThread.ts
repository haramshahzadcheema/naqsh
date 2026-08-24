import type { ChatThread } from "./types.js";

/** Real, downloadable files built from real in-memory state -- no fake
 * download buttons. `apps/api` has no HTTP server yet (see
 * `NaqshDataSource.ts`), so there is nothing to generate a PDF/CAD export
 * server-side; these two formats (a markdown transcript, a JSON snapshot
 * of the thread's structured engineering state) are exactly what the
 * browser genuinely has on hand right now. */

export function buildTranscriptMarkdown(thread: ChatThread): string {
  const lines = [`# ${thread.title}`, "", `_Exported ${new Date().toLocaleString()}_`, ""];
  for (const message of thread.messages) {
    lines.push(`**${message.role === "naqsh" ? "Naqsh" : "You"}:**`, "", message.text, "");
    if (message.attachments && message.attachments.length > 0) {
      lines.push(...message.attachments.map((a) => `- 📎 ${a.name} (${a.type || "unknown type"})`), "");
    }
  }
  return lines.join("\n");
}

export function buildProjectDataJson(thread: ChatThread): string {
  return JSON.stringify(
    {
      thread: thread.title,
      exportedAt: new Date().toISOString(),
      requirements: thread.requirements,
      constraints: thread.constraints,
      understandingConfirmed: thread.understandingConfirmed
    },
    null,
    2
  );
}

export function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
