import type { ChatThread } from "./types.js";

export interface ThreadGroup {
  label: string;
  threads: ChatThread[];
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** "Pinned" always sorts first (a thread the person explicitly chose to
 * keep at hand), then "Existing" (the one seeded demo project), then
 * everything else buckets by `createdAt` age, newest first within each
 * bucket, matching a familiar chat-history layout. A pinned thread
 * appears ONLY in "Pinned" -- never duplicated into its date bucket too.
 * Archived threads are excluded entirely (see `groupArchivedThreads`
 * below for where they actually live). */
export function groupThreads(threads: ChatThread[]): ThreadGroup[] {
  const visible = threads.filter((t) => !t.archived);
  const pinned = visible.filter((t) => t.pinned).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const unpinned = visible.filter((t) => !t.pinned);

  const existing = unpinned.filter((t) => t.kind === "existing");
  const rest = [...unpinned.filter((t) => t.kind === "new")].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const today = startOfDay(new Date());
  const yesterday = today - 86_400_000;
  const weekAgo = today - 7 * 86_400_000;

  const buckets: Record<"today" | "yesterday" | "week" | "older", ChatThread[]> = { today: [], yesterday: [], week: [], older: [] };
  for (const thread of rest) {
    const created = startOfDay(new Date(thread.createdAt));
    if (created >= today) buckets.today.push(thread);
    else if (created >= yesterday) buckets.yesterday.push(thread);
    else if (created >= weekAgo) buckets.week.push(thread);
    else buckets.older.push(thread);
  }

  const groups: ThreadGroup[] = [];
  if (pinned.length > 0) groups.push({ label: "Pinned", threads: pinned });
  if (existing.length > 0) groups.push({ label: "Demo", threads: existing });
  if (buckets.today.length > 0) groups.push({ label: "Today", threads: buckets.today });
  if (buckets.yesterday.length > 0) groups.push({ label: "Yesterday", threads: buckets.yesterday });
  if (buckets.week.length > 0) groups.push({ label: "Previous 7 days", threads: buckets.week });
  if (buckets.older.length > 0) groups.push({ label: "Older", threads: buckets.older });
  return groups;
}

/** The real, reachable home for archived threads -- kept separate from
 * `groupThreads` (rather than one more bucket in it) so the sidebar can
 * render it as its own collapsed-by-default section, never mixed into
 * the primary recency-grouped list. */
export function archivedThreads(threads: ChatThread[]): ChatThread[] {
  return threads.filter((t) => t.archived).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
