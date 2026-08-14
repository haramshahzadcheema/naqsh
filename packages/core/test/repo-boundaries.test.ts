import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { join } from "node:path";

const repoRoot = join(process.cwd(), "..", "..");

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8")) as Record<string, unknown>;
}

describe("repository layout", () => {
  it("has the expected package boundaries", () => {
    const expectedFiles = [
      "package.json",
      "tsconfig.base.json",
      "apps/web/package.json",
      "apps/web/src",
      "apps/api/package.json",
      "apps/api/src",
      "packages/core/package.json",
      "packages/core/src",
      "packages/adapters/package.json",
      "packages/adapters/src",
      "packages/schemas/package.json",
      "packages/schemas/src"
    ];

    for (const relativePath of expectedFiles) {
      assert.equal(existsSync(join(repoRoot, relativePath)), true, `Expected ${relativePath} to exist`);
    }
  });

  it("does not declare a conflicting package manager config", () => {
    assert.equal(existsSync(join(repoRoot, "pnpm-workspace.yaml")), false);
  });
});

describe("dependency direction: core depends on schemas, never the reverse", () => {
  it("declares @naqsh/schemas as a dependency of @naqsh/core", () => {
    const corePackageJson = readJson("packages/core/package.json");
    const dependencies = corePackageJson.dependencies as Record<string, string> | undefined;
    assert.ok(dependencies?.["@naqsh/schemas"], "@naqsh/core must depend on @naqsh/schemas");
  });

  it("does not let @naqsh/schemas depend on @naqsh/core", () => {
    const schemasPackageJson = readJson("packages/schemas/package.json");
    const dependencies = (schemasPackageJson.dependencies ?? {}) as Record<string, string>;
    assert.equal(
      "@naqsh/core" in dependencies,
      false,
      "@naqsh/schemas must stay dependency-free of @naqsh/core (schemas is the shared contract layer)"
    );
  });

  it("has exactly one entity-schema implementation, not a hand-duplicated copy", () => {
    // Regression guard for the exact bug found in the P0/P1 audit: identical
    // validators were hand-maintained in three places (core .cjs, core
    // .mjs, and an orphaned copy in schemas that nothing imported). This
    // asserts core has no local re-implementation of entity validation.
    const coreSourceFiles = ["src/transitions.ts", "src/bootstrap.ts", "src/index.ts"];
    for (const relativePath of coreSourceFiles) {
      const contents = readFileSync(join(repoRoot, "packages/core", relativePath), "utf8");
      assert.doesNotMatch(
        contents,
        /function\s+(assert|validate)(Requirement|Constraint|EngineeringObject|Decision|Experiment|Preference)/,
        `${relativePath} must import validators from @naqsh/schemas instead of redefining them`
      );
    }
  });
});
