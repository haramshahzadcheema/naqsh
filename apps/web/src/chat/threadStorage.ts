import type { ChatThread } from "./types.js";

const STORAGE_KEY = "naqsh.chat.threads";

/** Every field on `ChatThread` is already plain, JSON-safe data (the
 * `Requirement`/`Constraint` objects came from `@naqsh/schemas` factories,
 * which only ever produce validated, JSON-serializable records) -- so
 * persistence here is a direct `JSON.stringify`/`parse`, the same
 * discipline `ThemeProvider` already uses for its own localStorage key. */
export function loadThreads(): ChatThread[] | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ChatThread[]) : null;
  } catch {
    return null;
  }
}

export function saveThreads(threads: ChatThread[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(threads));
}
