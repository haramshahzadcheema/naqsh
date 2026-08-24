import type { MemoryRecord } from "@naqsh/schemas";

/**
 * Memory must influence future reasoning, not just be creatable and
 * listable -- an audit found `runtime.memory` (P24's real, persisted
 * `MemoryStore`) was never read by anything that builds a model prompt:
 * `generateProjectPlan`/`generateProjectProposal` (engineeringWorkflow.ts)
 * and `generateChatReply` (chatReply.ts) each constructed their own context
 * from `WorldModelState`/conversation history alone, so a decision recorded
 * as memory today (e.g. "steel was rejected -- exceeded mass budget") had
 * no way to affect what Naqsh proposes or says tomorrow. This is the one
 * shared place all three callers format the SAME store's content into
 * model-facing text, so the framing (what counts as "worth surfacing," how
 * much fits in context) can't drift between them.
 *
 * Deliberately reads ONLY `status: "active"` records -- a `superseded`/
 * `archived`/`rejected` memory is real history (never deleted, see
 * memory-types.ts's own doc comment) but is not what a caller asking "what
 * do we currently know" should be told to act on; that distinction is the
 * whole reason `status` exists as a separate axis from `content` itself.
 * Bounded to the `limit` most recently created active records (not the
 * whole project's memory) for the same reason `chatReply.ts` already caps
 * conversation history to the last 10 turns -- unbounded context growth is
 * a real cost/latency problem long before it's a correctness one.
 */
const DEFAULT_MEMORY_LIMIT = 12;

export function describeMemoryForModel(records: readonly MemoryRecord[], limit = DEFAULT_MEMORY_LIMIT): string {
  const active = records.filter((record) => record.status === "active").sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  if (active.length === 0) {
    return "Project memory: nothing recorded yet.";
  }

  const shown = active.slice(0, limit);
  const lines = shown.map((record) => `  - [${record.kind}] ${record.title} -- ${record.content}`);
  const omitted = active.length - shown.length;

  return [
    `Project memory (${shown.length}${omitted > 0 ? ` of ${active.length}` : ""} recorded decisions/findings, most recent first -- real project history, not the current live state):`,
    ...lines,
    omitted > 0 ? `  (${omitted} older active record${omitted === 1 ? "" : "s"} omitted for length)` : null
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
