import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the one thing an explicit test list cannot guard itself against:
 * a new test file that is never run, and therefore silently proves
 * nothing.
 *
 * Same guard as apps/api's. It was added there after `modelErrors.test.ts`
 * passed when invoked directly while being entirely absent from
 * `npm test`; `shape-tools.test.ts` then hit the identical trap here.
 * Two packages, same failure mode, so both now fail loudly instead.
 */
describe("test manifest", () => {
  it("every *.test.ts file in this package is actually listed in the npm test script", () => {
    const here = new URL(".", import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1");
    const packageJson = readFileSync(join(here, "..", "package.json"), "utf8");
    const script = (JSON.parse(packageJson) as { scripts: Record<string, string> }).scripts.test ?? "";

    const missing = readdirSync(here)
      .filter((file) => file.endsWith(".test.ts"))
      .filter((file) => !script.includes(`test/${file}`));

    assert.deepEqual(missing, [], `these test files are never run by "npm test" -- add them to packages/core/package.json: ${missing.join(", ")}`);
  });
});
