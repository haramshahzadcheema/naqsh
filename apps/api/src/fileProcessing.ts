/**
 * A small, extensible file-processing pipeline. Each `FileProcessor`
 * claims a set of MIME types/extensions and turns raw bytes into bounded
 * plain text (or reports a real extraction failure) -- never claims to
 * understand a format it doesn't actually parse (Phase F/G's explicit
 * honesty requirement).
 */
export interface FileProcessResult {
  status: "success" | "failed" | "unsupported";
  text: string | null;
  error: string | null;
}

export interface FileProcessor {
  canHandle(mimeType: string, filename: string): boolean;
  process(buffer: Buffer): Promise<FileProcessResult>;
}

/** Extracted text is bounded -- large enough for a real requirements
 * document, small enough that a huge upload never gets dumped whole into
 * a model context window (Phase G's explicit bound requirement). */
const MAX_EXTRACTED_CHARS = 40_000;

function truncate(text: string): string {
  return text.length > MAX_EXTRACTED_CHARS ? text.slice(0, MAX_EXTRACTED_CHARS) : text;
}

const TEXT_EXTENSIONS = [".txt", ".md", ".markdown", ".json", ".csv", ".yml", ".yaml"];

/** A pathological PDF (deeply nested objects, decompression-heavy
 * streams) can cost disproportionate CPU/memory relative to its size,
 * and this request awaits `pdfParse` synchronously (`server.ts`'s upload
 * handler) -- unbounded, that ties up the request indefinitely. This
 * bounds wall-clock time, not raw CPU: `pdf-parse`'s underlying pdf.js
 * processes a document in incremental async chunks rather than one
 * fully-synchronous call, so a losing `Promise.race` genuinely stops
 * awaiting further chunks rather than merely papering over a still-
 * running block -- a real mitigation, though not the hard, guaranteed
 * preemption only a worker-thread/child-process boundary would give. */
const PDF_PARSE_TIMEOUT_MS = 10_000;

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export const textFileProcessor: FileProcessor = {
  canHandle(mimeType, filename) {
    if (mimeType.startsWith("text/") || mimeType === "application/json") return true;
    const lower = filename.toLowerCase();
    return TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext));
  },
  async process(buffer) {
    try {
      return { status: "success", text: truncate(buffer.toString("utf8")), error: null };
    } catch (error) {
      return { status: "failed", text: null, error: error instanceof Error ? error.message : String(error) };
    }
  }
};

export const pdfFileProcessor: FileProcessor = {
  canHandle(mimeType, filename) {
    return mimeType === "application/pdf" || filename.toLowerCase().endsWith(".pdf");
  },
  async process(buffer) {
    try {
      // Lazy import: pdf-parse pulls in a moderately heavy dependency
      // tree that only PDF uploads actually need.
      const pdfParse = (await import("pdf-parse")).default;
      const result = await withTimeout(pdfParse(buffer), PDF_PARSE_TIMEOUT_MS, "PDF processing timed out -- this file may be unusually large or complex to parse.");
      const text = result.text.trim();
      if (text.length === 0) {
        return { status: "failed", text: null, error: "PDF contains no extractable text (it may be a scanned image with no text layer)." };
      }
      return { status: "success", text: truncate(text), error: null };
    } catch (error) {
      return { status: "failed", text: null, error: error instanceof Error ? error.message : String(error) };
    }
  }
};

const PROCESSORS: FileProcessor[] = [textFileProcessor, pdfFileProcessor];

export async function processFile(mimeType: string, filename: string, buffer: Buffer): Promise<FileProcessResult> {
  const processor = PROCESSORS.find((p) => p.canHandle(mimeType, filename));
  if (!processor) {
    return { status: "unsupported", text: null, error: null };
  }
  return processor.process(buffer);
}
