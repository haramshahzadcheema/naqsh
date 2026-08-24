import type { MessageAttachment } from "../onboarding/types.js";

const TEXT_EXTENSIONS = [".txt", ".md", ".markdown", ".json", ".csv", ".yml", ".yaml"];
/** Read at most this many characters of a text file's content -- enough
 * for a real requirements doc, small enough that a huge accidental
 * upload never bloats a chat message or the extraction pass. */
const MAX_TEXT_CHARS = 20_000;

function isTextLike(file: File): boolean {
  if (file.type.startsWith("text/") || file.type === "application/json") return true;
  const lower = file.name.toLowerCase();
  return TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `att_${Date.now().toString(36)}_${counter}`;
}

export interface ReadAttachment {
  meta: MessageAttachment;
  textContent: string | null;
}

/** Reads a browser `File` into an attachment: text-like files get their
 * content read (truncated) so it can flow into the same extraction
 * engine real typed text does; anything else is attached as a plain
 * labeled reference -- never silently pretended to be understood. */
export async function readFileAsAttachment(file: File): Promise<ReadAttachment> {
  const textLike = isTextLike(file);
  const meta: MessageAttachment = {
    id: nextId(),
    name: file.name,
    size: file.size,
    type: file.type || "application/octet-stream",
    kind: textLike ? "text" : "binary"
  };

  if (!textLike) {
    return { meta, textContent: null };
  }

  try {
    const raw = await readAsText(file);
    return { meta, textContent: raw.slice(0, MAX_TEXT_CHARS) };
  } catch {
    return { meta: { ...meta, kind: "binary" }, textContent: null };
  }
}

/** `FileReader`, not `Blob.prototype.text()` -- broader support across
 * browsers and the jsdom test environment alike. */
function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsText(file);
  });
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
