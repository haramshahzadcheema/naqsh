import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the one thing an explicit test list cannot guard itself against:
 * a new test file that is never run, and therefore silently proves
 * nothing.
 *
 * Found by audit -- `modelErrors.test.ts` was added, passed locally when
 * invoked directly, and was completely absent from `npm test` because
 * this package enumerates its test files by hand. The workspace total
 * simply didn't move, which is exactly the kind of silent gap that lets
 * dead coverage accumulate unnoticed.
 *
 * A glob would be the obvious fix, but neither `--test "test/**"` nor
 * directory discovery resolves test files under this Node/Windows shell
 * combination (verified, both find zero). So the list stays explicit and
 * this test makes any omission fail loudly instead.
 */
describe("test manifest", () => {
  it("every *.test.ts file in this package is actually listed in the npm test script", () => {
    const here = new URL(".", import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1");
    const packageJson = readFileSync(join(here, "..", "package.json"), "utf8");
    const script = (JSON.parse(packageJson) as { scripts: Record<string, string> }).scripts.test ?? "";

    const missing = readdirSync(here)
      .filter((file) => file.endsWith(".test.ts"))
      .filter((file) => !script.includes(`test/${file}`));

    assert.deepEqual(missing, [], `these test files are never run by "npm test" -- add them to apps/api/package.json: ${missing.join(", ")}`);
  });
});
