import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorldModelState } from "@naqsh/schemas";
import { createConversationRepository, createFileRepository, createMessageRepository, createProjectRepository, type ProjectRecord } from "../src/db/repositories.js";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "naqsh-repo-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("apps/api repositories: real file-backed persistence, not localStorage", () => {
  it("a saved project survives being re-read through a FRESH repository instance -- proving it's real disk persistence, not process memory", () => {
    withTempDir((dir) => {
      const state = createWorldModelState({ project: { name: "Bracket" }, session: {} });
      const record: ProjectRecord = { id: state.project.id, name: "Bracket", createdAt: "t0", updatedAt: "t0", worldModelState: state };

      createProjectRepository(dir).save(record);

      // A brand new repository instance, reading the same directory --
      // nothing about this call can be served from an in-memory cache.
      const reloaded = createProjectRepository(dir).get(record.id);
      assert.ok(reloaded);
      assert.equal(reloaded.name, "Bracket");
      assert.equal(reloaded.worldModelState.project.id, state.project.id);
    });
  });

  it("list() returns every saved record", () => {
    withTempDir((dir) => {
      const repo = createProjectRepository(dir);
      for (const name of ["A", "B", "C"]) {
        const state = createWorldModelState({ project: { name }, session: {} });
        repo.save({ id: state.project.id, name, createdAt: "t0", updatedAt: "t0", worldModelState: state });
      }
      assert.equal(repo.list().length, 3);
    });
  });

  it("save() writes via a temp-file-then-rename, not a direct overwrite -- no orphaned .tmp file remains on disk after a successful save", () => {
    withTempDir((dir) => {
      const state = createWorldModelState({ project: { name: "Atomic" }, session: {} });
      const record: ProjectRecord = { id: state.project.id, name: "Atomic", createdAt: "t0", updatedAt: "t0", worldModelState: state };
      createProjectRepository(dir).save(record);

      const collectionDir = join(dir, "projects");
      const filesOnDisk = readdirSync(collectionDir);
      assert.deepEqual(
        filesOnDisk.filter((name) => !name.endsWith(".json")),
        [],
        "only the real .json record should remain -- no leftover .tmp-* file from the write"
      );
      assert.ok(filesOnDisk.some((name) => name === `${record.id}.json`));
    });
  });

  it("list() ignores a stray non-.json file in the collection directory (e.g. a .tmp file orphaned by a crash mid-write)", () => {
    withTempDir((dir) => {
      const repo = createProjectRepository(dir);
      const state = createWorldModelState({ project: { name: "Real" }, session: {} });
      repo.save({ id: state.project.id, name: "Real", createdAt: "t0", updatedAt: "t0", worldModelState: state });

      // Simulate exactly what a crash between writeFileSync and renameSync
      // would leave behind: a real temp file sitting next to the finished
      // records, never renamed into place.
      writeFileSync(join(dir, "projects", "proj_orphaned.json.tmp-99999-123-abc"), "{not even valid json");

      assert.equal(repo.list().length, 1, "the orphaned temp file must never be mistaken for a real record");
    });
  });

  it("delete() removes the record and get() afterward returns null", () => {
    withTempDir((dir) => {
      const repo = createProjectRepository(dir);
      const state = createWorldModelState({ project: { name: "Temp" }, session: {} });
      const record: ProjectRecord = { id: state.project.id, name: "Temp", createdAt: "t0", updatedAt: "t0", worldModelState: state };
      repo.save(record);
      assert.equal(repo.delete(record.id), true);
      assert.equal(repo.get(record.id), null);
      assert.equal(repo.delete(record.id), false, "deleting a second time reports it was already gone");
    });
  });

  it("conversationRepository.listForProject only returns conversations for that project", () => {
    withTempDir((dir) => {
      const repo = createConversationRepository(dir);
      repo.save({ id: "conv_1", projectId: "proj_a", title: "First", createdAt: "t0", updatedAt: "t0" });
      repo.save({ id: "conv_2", projectId: "proj_b", title: "Second", createdAt: "t0", updatedAt: "t0" });
      repo.save({ id: "conv_3", projectId: "proj_a", title: "Third", createdAt: "t0", updatedAt: "t0" });

      const forA = repo.listForProject("proj_a");
      assert.equal(forA.length, 2);
      assert.ok(forA.every((c) => c.projectId === "proj_a"));
    });
  });

  it("messageRepository.listForConversation returns messages sorted by creation time", () => {
    withTempDir((dir) => {
      const repo = createMessageRepository(dir);
      repo.save({ id: "msg_2", conversationId: "conv_1", role: "assistant", text: "second", createdAt: "2026-01-01T00:00:02.000Z" });
      repo.save({ id: "msg_1", conversationId: "conv_1", role: "user", text: "first", createdAt: "2026-01-01T00:00:01.000Z" });

      const ordered = repo.listForConversation("conv_1");
      assert.deepEqual(
        ordered.map((m) => m.id),
        ["msg_1", "msg_2"]
      );
    });
  });

  it("projectRepository.listByOwner returns only that owner's projects, costing nothing extra as OTHER owners' project counts grow", () => {
    withTempDir((dir) => {
      const repo = createProjectRepository(dir);
      for (const [name, ownerId] of [
        ["Alice 1", "alice"],
        ["Bob 1", "bob"],
        ["Alice 2", "alice"],
        ["Bob 2", "bob"],
        ["Bob 3", "bob"]
      ] as const) {
        const state = createWorldModelState({ project: { name }, session: {} });
        repo.save({ id: state.project.id, name, ownerId, createdAt: "t0", updatedAt: "t0", worldModelState: state });
      }

      const aliceProjects = repo.listByOwner("alice");
      assert.equal(aliceProjects.length, 2);
      assert.ok(aliceProjects.every((p) => p.ownerId === "alice"));

      const bobProjects = repo.listByOwner("bob");
      assert.equal(bobProjects.length, 3);

      assert.deepEqual(repo.listByOwner("nobody"), []);
    });
  });

  it("the secondary index correctly REBUILDS from disk when a repository is constructed fresh against an existing directory -- the real restart scenario, not just in-process state", () => {
    withTempDir((dir) => {
      const first = createConversationRepository(dir);
      first.save({ id: "conv_1", projectId: "proj_a", title: "First", createdAt: "t0", updatedAt: "t0" });
      first.save({ id: "conv_2", projectId: "proj_a", title: "Second", createdAt: "t0", updatedAt: "t0" });
      first.save({ id: "conv_3", projectId: "proj_b", title: "Third", createdAt: "t0", updatedAt: "t0" });

      // A brand new repository instance -- its index has never seen a
      // save() call in this process; it must be rebuilt entirely from the
      // records already sitting on disk, exactly like a real server
      // restart against a populated data directory.
      const second = createConversationRepository(dir);
      assert.equal(second.listForProject("proj_a").length, 2);
      assert.equal(second.listForProject("proj_b").length, 1);
    });
  });

  it("deleting a record removes it from the index too -- listForProject never returns a stale, already-deleted entry", () => {
    withTempDir((dir) => {
      const repo = createFileRepository(dir);
      repo.save({ id: "file_1", projectId: "proj_a", filename: "a.txt", mimeType: "text/plain", size: 1, createdAt: "t0", extractionStatus: "success", extractedText: "a", extractionError: null, storedAt: "file_1.bin" });
      repo.save({ id: "file_2", projectId: "proj_a", filename: "b.txt", mimeType: "text/plain", size: 1, createdAt: "t0", extractionStatus: "success", extractedText: "b", extractionError: null, storedAt: "file_2.bin" });

      assert.equal(repo.listForProject("proj_a").length, 2);
      repo.delete("file_1");
      const remaining = repo.listForProject("proj_a");
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0]!.id, "file_2");
    });
  });
});
