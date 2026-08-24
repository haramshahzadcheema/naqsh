import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";

/**
 * A real, server-side, file-backed persistence primitive -- deliberately
 * NOT a database. `apps/web` previously kept all application state in
 * `localStorage`, which is not backend persistence at all (it's per-
 * browser, per-origin, and invisible to the server). This is: it lives on
 * the server's disk, survives a browser refresh trivially (the browser
 * never held the data in the first place), and survives a server restart
 * too, at the cost of not being a transactional database.
 *
 * A real SQL database (e.g. via `better-sqlite3`) was considered and
 * deliberately not used for this pass: it's a native, compiled dependency,
 * and this repository's own `apps/web` install already hit real npm
 * flakiness in this environment (see repo history) -- adding a
 * compilation step on top of that for a hackathon-scoped persistence
 * layer was judged higher-risk than it's worth. The `Repository`
 * interfaces in `repositories.ts` are written against a plain contract
 * (get/list/save/delete), so swapping this file for a real database-backed
 * implementation later touches nothing else.
 */
export class JsonCollectionStore<T extends { id: string }> {
  private readonly dir: string;
  private readonly indexKeyFor?: (record: T) => string | null;
  /** Secondary index: indexed-field value -> ids of every record currently
   * holding it. Exists purely so a caller asking "every record belonging
   * to THIS one owner/project/conversation" (`listByIndex`) never has to
   * read and parse every OTHER record in the entire collection just to
   * throw most of them away -- the exact `list().filter(...)` pattern this
   * class's callers used to lean on, which scales with the collection's
   * GLOBAL size (every project/conversation/message/file this server has
   * EVER stored, across every user) rather than the caller's own slice of
   * it. At real scale (many users, many projects each) that difference is
   * the entire ballgame: `GET /projects` for one user must not cost more
   * as OTHER users create more projects.
   *
   * Built once, by scanning disk, at construction time -- an O(n) cost
   * paid once per process lifetime, not per request -- then kept exactly
   * in sync incrementally on every `save()`/`delete()` (O(1) each).
   * Requires the indexed field to be immutable once a record is first
   * saved (true for every field this codebase actually indexes by --
   * `ownerId`, `projectId`, `conversationId` are all foreign keys fixed at
   * creation time, per their own doc comments in `repositories.ts`); this
   * class does not attempt to detect or handle a record's index key
   * changing between saves.
   */
  private readonly index = new Map<string, Set<string>>();

  constructor(baseDir: string, collectionName: string, options?: { indexBy?: (record: T) => string | null }) {
    this.dir = join(baseDir, collectionName);
    mkdirSync(this.dir, { recursive: true });
    this.indexKeyFor = options?.indexBy;
    if (this.indexKeyFor) {
      for (const record of this.list()) this.addToIndex(record);
    }
  }

  private addToIndex(record: T): void {
    if (!this.indexKeyFor) return;
    const key = this.indexKeyFor(record);
    if (key === null) return;
    let ids = this.index.get(key);
    if (!ids) {
      ids = new Set();
      this.index.set(key, ids);
    }
    ids.add(record.id);
  }

  private pathFor(id: string): string {
    // `id`s in this codebase are always created via @naqsh/schemas'
    // `createId()` (prefix_base36), never raw user input -- but this
    // guard makes path traversal structurally impossible regardless.
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.dir, `${safe}.json`);
  }

  get(id: string): T | null {
    const path = this.pathFor(id);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
      return null;
    }
  }

  list(): T[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        try {
          return JSON.parse(readFileSync(join(this.dir, name), "utf8")) as T;
        } catch {
          return null;
        }
      })
      .filter((value): value is T => value !== null);
  }

  /** Every record whose indexed field currently equals `key` -- the whole
   * point of building the index. Throws if this store wasn't constructed
   * with `indexBy` (a programmer error, not a runtime condition a caller
   * should need to branch on). */
  listByIndex(key: string): T[] {
    if (!this.indexKeyFor) throw new Error("listByIndex called on a JsonCollectionStore with no indexBy configured");
    const ids = this.index.get(key);
    if (!ids) return [];
    const records: T[] = [];
    for (const id of ids) {
      const record = this.get(id);
      if (record) records.push(record);
    }
    return records;
  }

  /** Write-to-temp-then-rename, not a direct overwrite: a process killed
   * mid-write previously left a truncated/corrupt `.json` file that
   * silently read back as `null` (see `get()`'s own catch above) --
   * indistinguishable from "record not found." A same-directory rename
   * is atomic on both POSIX and NTFS, so the real target file is always
   * either the complete OLD content or the complete NEW content, never a
   * partial write; the only failure mode this leaves is an orphaned
   * `.tmp-*` file (harmless: `list()`'s `.json`-suffix filter already
   * excludes it) if the process dies in the narrow window between the
   * write and the rename. */
  save(record: T): T {
    const target = this.pathFor(record.id);
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmp, JSON.stringify(record, null, 2), "utf8");
    renameSync(tmp, target);
    this.addToIndex(record);
    return record;
  }

  delete(id: string): boolean {
    const path = this.pathFor(id);
    if (!existsSync(path)) return false;
    // Read the record's OWN indexed key before removing it from disk --
    // O(1) index cleanup, rather than scanning every bucket this
    // collection has ever indexed to find which one(s) might contain `id`.
    const existing = this.indexKeyFor ? this.get(id) : null;
    const key = existing ? this.indexKeyFor!(existing) : null;
    unlinkSync(path);
    if (key !== null) this.index.get(key)?.delete(id);
    return true;
  }
}
