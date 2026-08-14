import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { join } from "node:path";

const repoRoot = join(process.cwd(), "..", "..");

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8")) as Record<string, unknown>;
}

/** Every .ts file under a src/ tree, relative to repoRoot. Used for
 * repo-wide static guards that must hold everywhere, not just in the
 * files that happened to prompt them. Written as a manual recursive walk
 * rather than relying on newer Dirent.recursive/.parentPath APIs, so it
 * behaves the same regardless of exact Node patch version. */
function listTsFiles(relativeDir: string): string[] {
  const results: string[] = [];
  const walk = (currentRelativeDir: string): void => {
    const absoluteDir = join(repoRoot, currentRelativeDir);
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const entryRelativePath = `${currentRelativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(entryRelativePath);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        results.push(entryRelativePath);
      }
    }
  };
  walk(relativeDir);
  return results;
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
    // asserts core has no local re-implementation of entity validation,
    // including Change (P2) and Tool/ToolRequest/ToolResult (P3) -- the
    // exact same risk applies to every one of them.
    const coreSourceFiles = [
      "src/transitions.ts",
      "src/bootstrap.ts",
      "src/change-history.ts",
      "src/record-transition.ts",
      "src/tool-registry.ts",
      "src/execute-tool.ts",
      "src/index.ts"
    ];
    for (const relativePath of coreSourceFiles) {
      const contents = readFileSync(join(repoRoot, "packages/core", relativePath), "utf8");
      assert.doesNotMatch(
        contents,
        /function\s+(assert|validate)(Requirement|Constraint|EngineeringObject|Decision|Experiment|Preference|Change|ChangeCause|ChangeTarget|Tool|ToolRequest|ToolResult)\b/,
        `${relativePath} must import validators from @naqsh/schemas instead of redefining them`
      );
    }
  });

  it("does not redefine WorldModelTransition or its member interfaces in core", () => {
    // Regression guard for the P2 correction: transition type CONTRACTS
    // moved from core to schemas so Change could reference them without
    // schemas depending on core. This asserts core's transitions.ts only
    // adds behavior (the registry/reducer), not a second copy of the
    // transition interfaces themselves.
    const contents = readFileSync(join(repoRoot, "packages/core/src/transitions.ts"), "utf8");
    assert.doesNotMatch(
      contents,
      /^export interface \w+Transition/m,
      "packages/core/src/transitions.ts must import transition interfaces from @naqsh/schemas instead of redefining them"
    );
  });
});

describe("P3 tool system: no arbitrary code execution", () => {
  it("contains no eval, Function constructor, or subprocess/dynamic-import execution paths anywhere in core or schemas", () => {
    // Static guard for the P3 brief's hard requirement: the tool system
    // must be an explicit allowlist (register() + a known handler), never
    // a path to running arbitrary code. Checked by source-text inspection
    // rather than runtime behavior because there is no runtime input that
    // could prove a negative -- this proves the CAPABILITY doesn't exist
    // in the source at all, not just that today's tests don't trigger it.
    //
    // Scoped to EVERY .ts file under packages/core/src and
    // packages/schemas/src, not just the two tool files -- the guarantee
    // this protects is repo-wide (nothing in the World Model, Change
    // Model, or tool layers should ever gain an execution primitive), and
    // a narrower scan would miss a violation introduced anywhere else.
    const forbiddenPatterns: RegExp[] = [
      /\beval\s*\(/,
      /new\s+Function\s*\(/,
      /require\s*\(\s*["'`]child_process["'`]\s*\)/,
      /from\s+["'`]child_process["'`]/,
      /\bexecSync\s*\(/,
      /\bspawn\s*\(/,
      /import\s*\(\s*[a-zA-Z_$]/ // dynamic import of a runtime-computed (non-literal) specifier
    ];
    const sourceFiles = [...listTsFiles("packages/core/src"), ...listTsFiles("packages/schemas/src")];
    assert.ok(sourceFiles.length > 10, "expected to find a substantial number of source files to scan");
    for (const relativePath of sourceFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not contain ${pattern}`);
      }
    }
  });

  it("Tool never carries a handler field -- handlers exist only in ToolRegistry's private closure", () => {
    // A Tool that could serialize a function would defeat the "no
    // arbitrary execution" guarantee the moment it crossed a process
    // boundary. This is enforced structurally (Tool's type has no handler
    // field) and by isJsonSafeValue rejecting functions in every field
    // that IS free-form (metadata); this test guards the structural half.
    const typesContents = readFileSync(join(repoRoot, "packages/schemas/src/types.ts"), "utf8");
    const toolInterfaceMatch = typesContents.match(/export interface Tool \{[\s\S]*?\n\}/);
    assert.ok(toolInterfaceMatch, "expected to find the Tool interface in packages/schemas/src/types.ts");
    assert.doesNotMatch(toolInterfaceMatch![0], /handler/i);
  });
});
