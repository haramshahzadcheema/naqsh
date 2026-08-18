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
      "packages/model-providers/package.json",
      "packages/model-providers/src",
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

  it("no source file under packages/core/src or packages/schemas/src imports from apps/api or apps/web", () => {
    // The wrong-direction-import guard this file was otherwise missing
    // (flagged during the P0-P8 audit): apps consume packages, never the
    // reverse. Unlikely in practice, but this file guards every OTHER
    // wrong-direction import explicitly, so this one shouldn't be the sole
    // silent gap.
    const forbiddenPattern = /from\s+["'`](\.\.\/)*apps\/(api|web)\//;
    for (const relativePath of [...listTsFiles("packages/core/src"), ...listTsFiles("packages/schemas/src")]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, forbiddenPattern, `${relativePath} must not import from apps/api or apps/web`);
    }
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
    const sourceFiles = [
      ...listTsFiles("packages/core/src"),
      ...listTsFiles("packages/schemas/src"),
      ...listTsFiles("packages/adapters/src"),
      ...listTsFiles("packages/model-providers/src")
    ];
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

describe("P5 environment adapter: dependency direction and World Model boundary", () => {
  it("declares @naqsh/core and @naqsh/schemas as dependencies of @naqsh/adapters", () => {
    const adaptersPackageJson = readJson("packages/adapters/package.json");
    const dependencies = adaptersPackageJson.dependencies as Record<string, string> | undefined;
    assert.ok(dependencies?.["@naqsh/core"], "@naqsh/adapters must depend on @naqsh/core");
    assert.ok(dependencies?.["@naqsh/schemas"], "@naqsh/adapters must depend on @naqsh/schemas");
  });

  it("does not let @naqsh/core depend on @naqsh/adapters", () => {
    const corePackageJson = readJson("packages/core/package.json");
    const dependencies = (corePackageJson.dependencies ?? {}) as Record<string, string>;
    assert.equal(
      "@naqsh/adapters" in dependencies,
      false,
      "@naqsh/core must stay dependency-free of @naqsh/adapters -- core defines the EnvironmentAdapter contract, it never depends on a concrete implementation"
    );
  });

  it("no source file under packages/core/src imports from @naqsh/adapters", () => {
    // Matches an actual import/require statement, not a doc comment that
    // merely MENTIONS the package name while explaining the architecture
    // (e.g. "Concrete adapters (the mocks in @naqsh/adapters now, ...)"),
    // which several files in this repo legitimately do.
    const actualImportPattern = /from\s+["'`]@naqsh\/adapters["'`]|require\s*\(\s*["'`]@naqsh\/adapters["'`]\s*\)/;
    for (const relativePath of listTsFiles("packages/core/src")) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, actualImportPattern, `${relativePath} must not import @naqsh/adapters`);
    }
  });

  it("environment-adapter files never import the World Model transition/change machinery", () => {
    // Preserves the P5 brief's explicit boundary: an adapter reports what
    // an environment has; reconciling that into WorldModelState is a
    // later phase's job (P8), not this one's. If environment-adapter.ts,
    // environment-adapter-contract.ts, or any mock adapter ever imports
    // transitions.ts/change-history.ts/record-transition.ts/bootstrap.ts,
    // that boundary has been silently crossed.
    const forbiddenImports = [
      "./transitions.js",
      "./change-history.js",
      "./record-transition.js",
      "./bootstrap.js",
      "@naqsh/core/transitions",
      "@naqsh/core/change-history"
    ];
    const filesToCheck = [
      "packages/core/src/environment-adapter.ts",
      "packages/core/src/environment-adapter-contract.ts",
      ...listTsFiles("packages/adapters/src")
    ];
    for (const relativePath of filesToCheck) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const forbidden of forbiddenImports) {
        assert.equal(
          contents.includes(forbidden),
          false,
          `${relativePath} must not import ${forbidden} -- environment observation and World Model mutation are separate concerns`
        );
      }
    }
  });

  it("environment-adapter files never import P4's authorization machinery", () => {
    // Preserves the P5 brief's security requirement: EnvironmentAdapter
    // must not become a backdoor around the typed tool/permission system.
    // An adapter has no concept of AutonomyLevel/Approval/AutonomyGrant --
    // enforcement happens one layer up, in executeTool's authorize hook,
    // when a future (P6+) tool handler wraps an adapter call. If any
    // adapter file ever imports authorization.ts/approval-store.ts/
    // autonomy-grant-store.ts, that means an adapter has started making its
    // OWN policy decisions, which is exactly the bypass this boundary
    // guards against.
    const forbiddenImports = [
      "./authorization.js",
      "./approval-store.js",
      "./autonomy-grant-store.js",
      "@naqsh/core/authorization"
    ];
    const filesToCheck = [
      "packages/core/src/environment-adapter.ts",
      "packages/core/src/environment-adapter-contract.ts",
      ...listTsFiles("packages/adapters/src")
    ];
    for (const relativePath of filesToCheck) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const forbidden of forbiddenImports) {
        assert.equal(
          contents.includes(forbidden),
          false,
          `${relativePath} must not import ${forbidden} -- an adapter is a mechanism, never its own policy decision point`
        );
      }
    }
  });

  it("EnvironmentAdapter's optional methods are real methods on every implementation, not conditionally present", () => {
    // Regression guard for the capability-vs-interface design decision:
    // the P5 brief asks for "capability-oriented design" AND "fail
    // deterministically with a typed error/result" at once. That is only
    // possible if every adapter has the SAME method surface regardless of
    // what it supports (a missing method would force callers to
    // feature-detect per adapter instead of always getting a structured
    // result back). This checks the interface declares all eleven
    // operation methods as non-optional.
    const contents = readFileSync(join(repoRoot, "packages/core/src/environment-adapter.ts"), "utf8");
    const requiredMethods = [
      "describe",
      "health",
      "connect",
      "disconnect",
      "listObjects",
      "inspectObject",
      "createObject",
      "modifyObject",
      "deleteObject",
      "save",
      "checkpoint",
      "restore"
    ];
    for (const method of requiredMethods) {
      assert.doesNotMatch(
        contents,
        new RegExp(`${method}\\?\\s*[(:]`),
        `EnvironmentAdapter.${method} must not be an optional ("${method}?:") member`
      );
    }
  });
});

describe("P7 model provider: dependency direction, vendor SDK isolation, and authorization boundary", () => {
  it("declares @naqsh/core and @naqsh/schemas as dependencies of @naqsh/model-providers", () => {
    const modelProvidersPackageJson = readJson("packages/model-providers/package.json");
    const dependencies = modelProvidersPackageJson.dependencies as Record<string, string> | undefined;
    assert.ok(dependencies?.["@naqsh/core"], "@naqsh/model-providers must depend on @naqsh/core");
    assert.ok(dependencies?.["@naqsh/schemas"], "@naqsh/model-providers must depend on @naqsh/schemas");
  });

  it("does not let @naqsh/core depend on @naqsh/model-providers", () => {
    const corePackageJson = readJson("packages/core/package.json");
    const dependencies = (corePackageJson.dependencies ?? {}) as Record<string, string>;
    assert.equal(
      "@naqsh/model-providers" in dependencies,
      false,
      "@naqsh/core must stay dependency-free of @naqsh/model-providers -- core defines the ModelProvider contract, it never depends on a concrete implementation"
    );
  });

  it("no source file under packages/core/src imports from @naqsh/model-providers", () => {
    const actualImportPattern = /from\s+["'`]@naqsh\/model-providers["'`]|require\s*\(\s*["'`]@naqsh\/model-providers["'`]\s*\)/;
    for (const relativePath of listTsFiles("packages/core/src")) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, actualImportPattern, `${relativePath} must not import @naqsh/model-providers`);
    }
  });

  it("no source file under packages/core/src imports @google/genai or any other provider SDK", () => {
    // The P7 brief's central rule: "core must not become `import {
    // GoogleGenAI } from ...` throughout business logic." The ModelProvider
    // INTERFACE lives in core; the concrete Gemini SDK usage lives strictly
    // in packages/model-providers.
    const forbiddenImportPattern = /from\s+["'`]@google\/genai["'`]|require\s*\(\s*["'`]@google\/genai["'`]\s*\)/;
    for (const relativePath of listTsFiles("packages/core/src")) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, forbiddenImportPattern, `${relativePath} must not import @google/genai`);
    }
  });

  it("model-provider files never import P4's authorization machinery", () => {
    // Mirrors the identical P5/P6 guard: a ModelProvider has no concept of
    // AutonomyLevel/Approval/AutonomyGrant. Authorization happens one layer
    // up, in executeTool's authorize hook, when a tool-call intent reaches
    // executeModelToolCall. If a model-provider file ever imports
    // authorization.ts/approval-store.ts/autonomy-grant-store.ts, that
    // means it has started making its own policy decisions.
    const forbiddenImports = ["./authorization.js", "./approval-store.js", "./autonomy-grant-store.js", "@naqsh/core/authorization"];
    const filesToCheck = [
      "packages/core/src/model-provider.ts",
      "packages/core/src/model-provider-contract.ts",
      ...listTsFiles("packages/model-providers/src")
    ];
    for (const relativePath of filesToCheck) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const forbidden of forbiddenImports) {
        assert.equal(
          contents.includes(forbidden),
          false,
          `${relativePath} must not import ${forbidden} -- a model provider is a mechanism, never its own policy decision point`
        );
      }
    }
  });

  it("model-provider files never import World Model transition/change machinery", () => {
    // A ModelProvider returns data; it never touches WorldModelState,
    // ChangeHistory, or updateWorldModel directly -- exactly the same
    // boundary already enforced for EnvironmentAdapter.
    const forbiddenImports = ["./transitions.js", "./change-history.js", "./record-transition.js", "./bootstrap.js"];
    const filesToCheck = [
      "packages/core/src/model-provider.ts",
      "packages/core/src/model-provider-contract.ts",
      ...listTsFiles("packages/model-providers/src")
    ];
    for (const relativePath of filesToCheck) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const forbidden of forbiddenImports) {
        assert.equal(
          contents.includes(forbidden),
          false,
          `${relativePath} must not import ${forbidden} -- a model provider reports/produces data, it does not mutate the World Model itself`
        );
      }
    }
  });

  it("ModelProvider's methods are real methods, not conditionally present", () => {
    const contents = readFileSync(join(repoRoot, "packages/core/src/model-provider.ts"), "utf8");
    for (const method of ["describe", "generate"]) {
      assert.doesNotMatch(
        contents,
        new RegExp(`${method}\\?\\s*[(:]`),
        `ModelProvider.${method} must not be an optional ("${method}?:") member`
      );
    }
  });

  it("executeModelToolCall is the only core function that hands a ModelToolCallIntent to executeTool", () => {
    // Regression guard against a future shortcut: if some OTHER file in
    // core starts importing executeTool alongside a ModelToolCallIntent
    // type, that is a second, unaudited path from a model's intent to
    // actual execution -- exactly the bypass this boundary exists to
    // prevent.
    for (const relativePath of listTsFiles("packages/core/src")) {
      if (relativePath.endsWith("/execute-model-tool-call.ts") || relativePath.endsWith("/execute-tool.ts")) continue;
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      const importsExecuteTool = /from\s+["'`]\.\/execute-tool\.js["'`]/.test(contents);
      const importsToolCallIntent = /ModelToolCallIntent/.test(contents);
      assert.equal(
        importsExecuteTool && importsToolCallIntent,
        false,
        `${relativePath} must not combine executeTool with ModelToolCallIntent -- executeModelToolCall is the one sanctioned path`
      );
    }
  });
});

describe("P8 observation: read-only, environment-independent, and provider-independent", () => {
  const observationFiles = ["packages/core/src/observe-project.ts", "packages/core/src/observation-tool.ts"];

  it("observation files never import the World Model WRITE path -- observation cannot mutate WorldModelState", () => {
    // The single most important P8 invariant: "An observation operation
    // must NEVER mutate the World Model." updateWorldModel is the ONLY
    // function that can produce a new WorldModelState; ChangeHistory/
    // recordTransition are how a mutation gets audited. If observation
    // code never imports any of them, it structurally CANNOT mutate
    // project state, no matter what a future caller does with its output.
    const forbiddenImports = ["./transitions.js", "./change-history.js", "./record-transition.js", "./bootstrap.js"];
    for (const relativePath of observationFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const forbidden of forbiddenImports) {
        assert.equal(
          contents.includes(forbidden),
          false,
          `${relativePath} must not import ${forbidden} -- observation must never be able to mutate the World Model`
        );
      }
    }
  });

  it("observation files never import a model-provider package or @google/genai -- Gemini never constructs an observation", () => {
    // Matches actual import/require statements only, not a doc comment
    // that merely MENTIONS "ModelProvider"/"ModelResponse" while explaining
    // the architecture (both files do this deliberately, the same way
    // several P5/P6/P7 files reference sibling concepts in prose) -- see
    // the identical reasoning on the "no source file under
    // packages/core/src imports from @naqsh/adapters" check above.
    const forbiddenPatterns = [
      /from\s+["'`]@naqsh\/model-providers["'`]|require\s*\(\s*["'`]@naqsh\/model-providers["'`]\s*\)/,
      /from\s+["'`]@google\/genai["'`]|require\s*\(\s*["'`]@google\/genai["'`]\s*\)/
    ];
    for (const relativePath of observationFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not import ${pattern} -- Gemini never constructs an ObservationResult`);
      }
    }
  });

  it("observation files never import an EnvironmentAdapter or a concrete adapter package -- observation stays environment-independent", () => {
    const forbiddenPatterns = [
      /from\s+["'`]@naqsh\/adapters["'`]|require\s*\(\s*["'`]@naqsh\/adapters["'`]\s*\)/,
      /from\s+["'`]\.\/environment-adapter(-contract)?\.js["'`]/
    ];
    for (const relativePath of observationFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(
          contents,
          pattern,
          `${relativePath} must not import ${pattern} -- observation reads WorldModelState only, never a concrete environment`
        );
      }
    }
  });

  it("observation files declare no module-level mutable state", () => {
    // No singleton "current project" -- every function takes WorldModelState
    // as an explicit argument. A module-level `let`/mutable Map/Set would
    // be exactly the hidden global state the P8 brief forbids.
    const forbiddenPatterns = [/^let\s+\w/m, /^const\s+\w+\s*=\s*new\s+Map/m, /^const\s+\w+\s*=\s*new\s+Set/m];
    for (const relativePath of observationFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not declare module-level mutable state`);
      }
    }
  });

  it("apps/api's observation service stays a thin pass-through -- no Gemini or adapter coupling in the API layer either", () => {
    const relativePath = "apps/api/src/observation-service.ts";
    if (!existsSync(join(repoRoot, relativePath))) return;
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    const forbiddenPatterns = [
      /from\s+["'`]@naqsh\/model-providers["'`]/,
      /from\s+["'`]@google\/genai["'`]/,
      /from\s+["'`]@naqsh\/adapters["'`]/
    ];
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(contents, pattern, `${relativePath} must not reference ${pattern}`);
    }
  });
});

describe("P9 planning: non-mutating, environment-independent, and provider-implementation-independent", () => {
  // Mirrors P8's identical guard block above -- planning must be exactly as
  // structurally incapable of mutating the World Model, touching a concrete
  // environment, or depending on a concrete model-provider SDK as
  // observation already is. `planner.ts`/`plan-tool.ts` import the
  // `ModelProvider` INTERFACE (packages/core/src/model-provider.ts) -- a
  // provider-agnostic contract this package already owns -- never a
  // concrete implementation.
  const planningFiles = [
    "packages/core/src/planner.ts",
    "packages/core/src/plan-tool.ts",
    "packages/core/src/plan-semantics.ts",
    "packages/core/src/plan-query.ts"
  ];

  it("planning files never import the World Model WRITE path -- generating a plan cannot mutate WorldModelState", () => {
    const forbiddenImports = ["./transitions.js", "./change-history.js", "./record-transition.js", "./bootstrap.js"];
    for (const relativePath of planningFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const forbidden of forbiddenImports) {
        assert.equal(
          contents.includes(forbidden),
          false,
          `${relativePath} must not import ${forbidden} -- planning must never be able to mutate the World Model`
        );
      }
    }
  });

  it("planning files never import a concrete model-provider package or @google/genai -- only the provider-agnostic ModelProvider interface", () => {
    const forbiddenPatterns = [
      /from\s+["'`]@naqsh\/model-providers["'`]|require\s*\(\s*["'`]@naqsh\/model-providers["'`]\s*\)/,
      /from\s+["'`]@google\/genai["'`]|require\s*\(\s*["'`]@google\/genai["'`]\s*\)/
    ];
    for (const relativePath of planningFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not import ${pattern} -- planning depends only on the ModelProvider interface`);
      }
    }
  });

  it("planning files never import an EnvironmentAdapter or a concrete adapter package -- planning stays environment-independent", () => {
    const forbiddenPatterns = [
      /from\s+["'`]@naqsh\/adapters["'`]|require\s*\(\s*["'`]@naqsh\/adapters["'`]\s*\)/,
      /from\s+["'`]\.\/environment-adapter(-contract)?\.js["'`]/
    ];
    for (const relativePath of planningFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(
          contents,
          pattern,
          `${relativePath} must not import ${pattern} -- planning never touches a concrete environment or FreeCAD`
        );
      }
    }
  });

  it("planning files declare no module-level mutable state", () => {
    const forbiddenPatterns = [/^let\s+\w/m, /^const\s+\w+\s*=\s*new\s+Map/m, /^const\s+\w+\s*=\s*new\s+Set/m];
    for (const relativePath of planningFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not declare module-level mutable state`);
      }
    }
  });

  it("no arbitrary code execution in the planning files -- a Plan can never carry an executable action", () => {
    const forbiddenPatterns: RegExp[] = [
      /\beval\s*\(/,
      /new\s+Function\s*\(/,
      /require\s*\(\s*["'`]child_process["'`]\s*\)/,
      /from\s+["'`]child_process["'`]/,
      /\bexecSync\s*\(/,
      /\bspawn\s*\(/,
      /import\s*\(\s*[a-zA-Z_$]/
    ];
    for (const relativePath of planningFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not contain ${pattern}`);
      }
    }
  });

  it("apps/api's plan service stays a thin pass-through -- no Gemini or adapter coupling in the API layer either", () => {
    const relativePath = "apps/api/src/plan-service.ts";
    if (!existsSync(join(repoRoot, relativePath))) return;
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    const forbiddenPatterns = [
      /from\s+["'`]@naqsh\/model-providers["'`]/,
      /from\s+["'`]@google\/genai["'`]/,
      /from\s+["'`]@naqsh\/adapters["'`]/
    ];
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(contents, pattern, `${relativePath} must not reference ${pattern}`);
    }
  });
});

describe("P10 proposals: non-mutating, non-executing, and environment-independent", () => {
  // Mirrors P8/P9's identical guard blocks above -- a Proposal describes
  // INTENT, never REALITY. Generating one must be exactly as structurally
  // incapable of mutating the World Model, executing a tool, touching a
  // concrete environment, or depending on a concrete model-provider SDK as
  // observation/planning already are.
  const proposalFiles = ["packages/core/src/proposal-generator.ts", "packages/core/src/proposal-tool.ts", "packages/core/src/proposal-semantics.ts"];

  it("proposal files never import the World Model WRITE path -- generating a proposal cannot mutate WorldModelState", () => {
    const forbiddenImports = ["./transitions.js", "./change-history.js", "./record-transition.js", "./bootstrap.js"];
    for (const relativePath of proposalFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const forbidden of forbiddenImports) {
        assert.equal(
          contents.includes(forbidden),
          false,
          `${relativePath} must not import ${forbidden} -- proposing must never be able to mutate the World Model`
        );
      }
    }
  });

  it("proposal files never import executeTool/invokeRegisteredTool -- a proposal describes an action, it never invokes one", () => {
    // The single most important P10 invariant, checked structurally rather
    // than by convention: PLAN -> PROPOSED CHANGE stops at "proposed" --
    // PROPOSED CHANGE -> EXECUTION is Phase 11's job. If no P10 file ever
    // imports the tool-execution boundary, no P10 code path can reach it,
    // no matter what a future caller does with a generated Proposal.
    // Matches an actual import statement or function CALL, not a doc
    // comment that merely MENTIONS either name while explaining this exact
    // boundary (which every P10 file's own doc comments deliberately do)
    // -- the same reasoning the `@naqsh/adapters`/`@naqsh/model-providers`
    // checks elsewhere in this file already apply.
    const forbiddenPatterns = [/from\s+["'`]\.\/execute-tool\.js["'`]/, /invokeRegisteredTool\s*\(/];
    for (const relativePath of proposalFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not reference ${pattern} -- creating a proposal must never execute it`);
      }
    }
  });

  it("no P10 file defines an approveProposal/rejectProposal/executeProposal function -- approval and execution mechanics belong to later phases", () => {
    // Proves the "proposed -> executed" transition genuinely cannot happen
    // through any Phase 10 operation, not just that nothing currently
    // calls such a function -- the function itself must not exist. Matches
    // an actual function DEFINITION (name immediately followed by an
    // opening paren), not a doc comment that merely names the concept
    // while explaining this exact boundary (every P10 file's own doc
    // comments deliberately do this, in prose, with no trailing paren).
    const forbiddenPatterns = [/function\s+approveProposal\s*\(/, /function\s+rejectProposal\s*\(/, /function\s+executeProposal\s*\(/];
    for (const relativePath of [...proposalFiles, "packages/schemas/src/proposal-types.ts"]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not define ${pattern} -- that belongs to a later phase`);
      }
    }
  });

  it("no P10 file registers a tool literally named 'execute_proposal' -- that tool belongs to a later phase", () => {
    // Matches the specific shape a real registration would take
    // (`name: "execute_proposal"`, as `createTool`'s own input requires),
    // not a bare backtick-quoted mention in prose.
    const pattern = /name:\s*["'`]execute_proposal["'`]/;
    for (const relativePath of proposalFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, pattern, `${relativePath} must not register a tool named "execute_proposal" -- that belongs to a later phase`);
    }
  });

  it("proposal files never import a concrete model-provider package or @google/genai -- only the provider-agnostic ModelProvider interface", () => {
    const forbiddenPatterns = [
      /from\s+["'`]@naqsh\/model-providers["'`]|require\s*\(\s*["'`]@naqsh\/model-providers["'`]\s*\)/,
      /from\s+["'`]@google\/genai["'`]|require\s*\(\s*["'`]@google\/genai["'`]\s*\)/
    ];
    for (const relativePath of proposalFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not import ${pattern} -- proposal generation depends only on the ModelProvider interface`);
      }
    }
  });

  it("proposal files never import an EnvironmentAdapter or a concrete adapter package -- proposals stay environment-independent", () => {
    const forbiddenPatterns = [
      /from\s+["'`]@naqsh\/adapters["'`]|require\s*\(\s*["'`]@naqsh\/adapters["'`]\s*\)/,
      /from\s+["'`]\.\/environment-adapter(-contract)?\.js["'`]/
    ];
    for (const relativePath of proposalFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(
          contents,
          pattern,
          `${relativePath} must not import ${pattern} -- a proposal never touches a concrete environment or FreeCAD`
        );
      }
    }
  });

  it("proposal files declare no module-level mutable state", () => {
    const forbiddenPatterns = [/^let\s+\w/m, /^const\s+\w+\s*=\s*new\s+Map/m, /^const\s+\w+\s*=\s*new\s+Set/m];
    for (const relativePath of proposalFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not declare module-level mutable state`);
      }
    }
  });

  it("no arbitrary code execution in the proposal files -- a Proposal can never carry an executable action", () => {
    const forbiddenPatterns: RegExp[] = [
      /\beval\s*\(/,
      /new\s+Function\s*\(/,
      /require\s*\(\s*["'`]child_process["'`]\s*\)/,
      /from\s+["'`]child_process["'`]/,
      /\bexecSync\s*\(/,
      /\bspawn\s*\(/,
      /import\s*\(\s*[a-zA-Z_$]/
    ];
    for (const relativePath of proposalFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not contain ${pattern}`);
      }
    }
  });

  it("apps/api's proposal service stays a thin pass-through -- no Gemini, adapter, or tool-execution coupling in the API layer either", () => {
    const relativePath = "apps/api/src/proposal-service.ts";
    if (!existsSync(join(repoRoot, relativePath))) return;
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    const forbiddenPatterns = [
      /from\s+["'`]@naqsh\/model-providers["'`]/,
      /from\s+["'`]@google\/genai["'`]/,
      /from\s+["'`]@naqsh\/adapters["'`]/
    ];
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(contents, pattern, `${relativePath} must not reference ${pattern}`);
    }
    assert.doesNotMatch(contents, /executeTool\s*\(/, `${relativePath} must not call executeTool -- proposing is not executing`);
  });
});

describe("P11 agent loop: approval-gated execution, no bypass", () => {
  // The controlled loop OBSERVE -> REASON -> PROPOSE -> APPROVAL -> EXECUTE
  // -> OBSERVE finally lets a proposal actually run -- which makes this
  // phase's structural guards the most safety-critical in the repository.
  // Every check below proves a specific way the "NO APPROVAL -> NO
  // MUTATION" invariant could be silently broken, structurally rather than
  // by convention.
  const agentLoopFiles = [
    "packages/core/src/agent-loop.ts",
    "packages/core/src/proposal-approval.ts",
    "packages/core/src/modify-object-tool.ts",
    "packages/core/src/modify-environment-object-tool.ts"
  ];

  it("agent-loop.ts never imports the World Model write path directly -- every mutation happens inside a registered tool's own handler, never as a shortcut in the orchestrator", () => {
    const forbiddenImports = ["./transitions.js", "./change-history.js", "./record-transition.js", "./bootstrap.js"];
    const relativePath = "packages/core/src/agent-loop.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    for (const forbidden of forbiddenImports) {
      assert.equal(
        contents.includes(forbidden),
        false,
        `${relativePath} must not import ${forbidden} -- the orchestrator itself must have no independent write path`
      );
    }
  });

  it("agent-loop.ts never calls invokeRegisteredTool directly -- executeTool is the one sanctioned execution boundary", () => {
    const relativePath = "packages/core/src/agent-loop.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.doesNotMatch(contents, /invokeRegisteredTool\s*\(/, `${relativePath} must not call invokeRegisteredTool directly`);
    assert.match(contents, /executeTool\s*\(/, `${relativePath} must call executeTool -- that is the one sanctioned execution boundary`);
  });

  it("agent-loop.ts checks proposal staleness and re-reads the approval's CURRENT status before ever executing", () => {
    // Structural proxy for "no unsafe execution": if these calls didn't
    // appear at all, there would be no code path capable of blocking a
    // stale proposal or a since-revoked approval -- this doesn't prove
    // correctness (the runtime test suite does), but it proves the
    // mechanism the runtime tests rely on genuinely exists in source.
    const relativePath = "packages/core/src/agent-loop.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /isProposalStale\s*\(/, `${relativePath} must check proposal staleness before executing`);
    assert.match(
      contents,
      /approvals\.getById\s*\(/,
      `${relativePath} must re-read the Approval by id from the ApprovalStore, never trust a run's own stale snapshot`
    );
  });

  it("modify-object-tool.ts mutates the World Model only through recordTransition -- it has no direct access to the bare updateWorldModel reducer", () => {
    const relativePath = "packages/core/src/modify-object-tool.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /recordTransition\s*\(/, `${relativePath} must call recordTransition`);
    assert.doesNotMatch(
      contents,
      /from\s+["'`]\.\/transitions\.js["'`]/,
      `${relativePath} must not import ./transitions.js directly -- recordTransition is the sole audited write path`
    );
  });

  it("modify-environment-object-tool.ts never imports a concrete adapter package or a FreeCAD-specific module -- only the generic EnvironmentAdapter interface", () => {
    // Matches an actual import/require statement naming a freecad module,
    // not a doc comment that merely MENTIONS FreeCAD while explaining why
    // this tool stays generic (which this file's own header deliberately
    // does) -- the same precision-regex lesson the P8/P9/P10 audits already
    // applied to `@naqsh/adapters`/`@naqsh/model-providers` mentions in
    // prose elsewhere in this file.
    const relativePath = "packages/core/src/modify-environment-object-tool.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.doesNotMatch(contents, /from\s+["'`]@naqsh\/adapters["'`]/, `${relativePath} must not import @naqsh/adapters`);
    assert.doesNotMatch(
      contents,
      /from\s+["'`][^"'`]*freecad[^"'`]*["'`]|require\s*\(\s*["'`][^"'`]*freecad[^"'`]*["'`]\s*\)/i,
      `${relativePath} must not import a FreeCAD-specific module -- no CAD-specific dependency belongs in core orchestration`
    );
  });

  it("no P11 file registers a tool literally named 'execute_proposal' -- proposals execute as themselves (the real named tool), never through a generic execution wrapper", () => {
    const pattern = /name:\s*["'`]execute_proposal["'`]/;
    for (const relativePath of agentLoopFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, pattern, `${relativePath} must not register a tool named "execute_proposal"`);
    }
  });

  it("P11 files declare no module-level mutable state", () => {
    const forbiddenPatterns = [/^let\s+\w/m, /^const\s+\w+\s*=\s*new\s+Map/m, /^const\s+\w+\s*=\s*new\s+Set/m];
    for (const relativePath of agentLoopFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not declare module-level mutable state`);
      }
    }
  });

  it("apps/api's agent-loop service stays a thin pass-through -- no Gemini or adapter coupling in the API layer either", () => {
    const relativePath = "apps/api/src/agent-loop-service.ts";
    if (!existsSync(join(repoRoot, relativePath))) return;
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    const forbiddenPatterns = [/from\s+["'`]@naqsh\/model-providers["'`]/, /from\s+["'`]@google\/genai["'`]/, /from\s+["'`]@naqsh\/adapters["'`]/];
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(contents, pattern, `${relativePath} must not reference ${pattern}`);
    }
  });
});

describe("P12 FreeCAD adapter: isolation, single subprocess boundary, no arbitrary execution", () => {
  // FreeCAD is the first REAL (non-mock) EnvironmentAdapter implementation
  // -- the risk this phase specifically introduces is a Python/subprocess
  // dependency leaking somewhere it shouldn't, or a "run this code" surface
  // appearing anywhere an agent (or a model) could reach it. Every check
  // below proves a specific way that could happen, structurally.

  it("no source file under packages/core/src or packages/schemas/src imports anything FreeCAD-specific -- the core stays environment-independent", () => {
    // Matches an actual import/require specifier naming a freecad module,
    // not a doc comment that merely MENTIONS FreeCAD/FreeCADAdapter while
    // explaining the architecture -- several P5/P11 files already do this
    // deliberately (e.g. environment-adapter.ts's own header names
    // "FreeCADAdapter in P12+" as the reason the interface is generic).
    // Same precision-regex lesson the P8/P9/P10 audits already applied to
    // `@naqsh/adapters`/`@naqsh/model-providers` mentions elsewhere in this
    // file -- a bare substring match would flag legitimate prose.
    const forbiddenPattern = /from\s+["'`][^"'`]*freecad[^"'`]*["'`]|require\s*\(\s*["'`][^"'`]*freecad[^"'`]*["'`]\s*\)/i;
    for (const relativePath of [...listTsFiles("packages/core/src"), ...listTsFiles("packages/schemas/src")]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, forbiddenPattern, `${relativePath} must not import anything FreeCAD-specific -- the core/schemas layer must stay environment-independent`);
    }
  });

  it("declares @naqsh/core and @naqsh/schemas as dependencies of @naqsh/adapters, and does not let @naqsh/core depend on @naqsh/adapters (mirrors the P5 mock-adapter guard, re-verified for the real FreeCAD adapter)", () => {
    const adaptersPackageJson = readJson("packages/adapters/package.json");
    const adapterDependencies = adaptersPackageJson.dependencies as Record<string, string> | undefined;
    assert.ok(adapterDependencies?.["@naqsh/core"], "@naqsh/adapters must depend on @naqsh/core");
    assert.ok(adapterDependencies?.["@naqsh/schemas"], "@naqsh/adapters must depend on @naqsh/schemas");

    const corePackageJson = readJson("packages/core/package.json");
    const coreDependencies = (corePackageJson.dependencies ?? {}) as Record<string, string>;
    assert.equal("@naqsh/adapters" in coreDependencies, false, "@naqsh/core must stay dependency-free of @naqsh/adapters");
  });

  it("freecad-runtime.ts is the ONLY source file in the repo that imports node:child_process -- the subprocess boundary is not duplicated anywhere", () => {
    const forbiddenPattern = /from\s+["'`](?:node:)?child_process["'`]|require\s*\(\s*["'`](?:node:)?child_process["'`]\s*\)/;
    const allSourceFiles = [
      ...listTsFiles("packages/core/src"),
      ...listTsFiles("packages/schemas/src"),
      ...listTsFiles("packages/adapters/src"),
      ...listTsFiles("packages/model-providers/src"),
      ...listTsFiles("apps/api/src")
    ];
    const filesImportingChildProcess = allSourceFiles.filter((relativePath) =>
      forbiddenPattern.test(readFileSync(join(repoRoot, relativePath), "utf8"))
    );
    assert.deepEqual(
      filesImportingChildProcess,
      ["packages/adapters/src/freecad-runtime.ts"],
      "node:child_process must be imported by exactly freecad-runtime.ts and nowhere else -- that is the one sanctioned subprocess boundary"
    );
  });

  it("freecad-adapter.ts never imports node:child_process directly -- it must go through freecad-runtime.ts", () => {
    const relativePath = "packages/adapters/src/freecad-adapter.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.doesNotMatch(contents, /from\s+["'`](?:node:)?child_process["'`]/, `${relativePath} must not import child_process directly`);
    assert.match(contents, /from\s+["'`]\.\/freecad-runtime\.js["'`]/, `${relativePath} must delegate subprocess execution to freecad-runtime.ts`);
  });

  it("no source file anywhere in the repo contains eval(), new Function(), execSync(), or a bare spawn() outside the one sanctioned boundary", () => {
    // Re-asserts the repo-wide P3 "no arbitrary code execution" guard
    // specifically including the new freecad/ TypeScript sources, so this
    // phase's own new files are held to the identical standard rather than
    // assumed compliant.
    const forbiddenPatterns: RegExp[] = [/\beval\s*\(/, /new\s+Function\s*\(/, /\bexecSync\s*\(/, /\bspawn\s*\(/];
    for (const relativePath of ["packages/adapters/src/freecad-adapter.ts", "packages/adapters/src/freecad-runtime.ts"]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not contain ${pattern}`);
      }
    }
  });

  it("runner.py dispatches through a fixed, named operation table -- no eval/exec, no generic 'run this Python' primitive", () => {
    const relativePath = "packages/adapters/freecad/runner.py";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /^OPERATIONS\s*=\s*\{/m, `${relativePath} must define a fixed OPERATIONS dispatch table`);
    const forbiddenPatterns: RegExp[] = [/\beval\s*\(/, /\bexec\s*\(/, /\b__import__\s*\(/, /\bcompile\s*\(/, /\bos\.system\s*\(/, /\bsubprocess\./];
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(contents, pattern, `${relativePath} must not contain ${pattern} -- no arbitrary-execution surface, even inside the adapter implementation`);
    }
  });

  it("FreeCAD's own EnvironmentAdapter never claims create/delete capabilities -- no fabricated unbounded object lifecycle", () => {
    // Superseded from its original Phase 12 form ("exactly the save
    // capability") once Phase 14 deliberately added "modify" and Phase 15
    // deliberately added "checkpoint" -- this guard still proves the
    // important thing Phase 12 established and neither phase touches:
    // create/delete remain unsupported. See the dedicated P14/P15 guard
    // blocks below for the modify/checkpoint-specific assertions.
    const relativePath = "packages/adapters/src/freecad-adapter.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    for (const capability of ["create", "delete"]) {
      assert.doesNotMatch(
        contents,
        new RegExp(`capabilities:\\s*\\[[^\\]]*["'\`]${capability}["'\`]`),
        `${relativePath} must not declare the "${capability}" capability`
      );
    }
  });

  it("apps/api never imports anything FreeCAD-specific or spawns a subprocess -- the application layer stays behind the adapter boundary too", () => {
    const forbiddenPattern = /from\s+["'`][^"'`]*freecad[^"'`]*["'`]|require\s*\(\s*["'`][^"'`]*freecad[^"'`]*["'`]\s*\)/i;
    const childProcessPattern = /from\s+["'`](?:node:)?child_process["'`]/;
    for (const relativePath of listTsFiles("apps/api/src")) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, forbiddenPattern, `${relativePath} must not import anything FreeCAD-specific`);
      assert.doesNotMatch(contents, childProcessPattern, `${relativePath} must not import child_process directly`);
    }
  });
});

describe("P13 FreeCAD document/object/parameter/relationship inspection: generic contract, no FreeCAD-specific leakage, observe-only tools", () => {
  // Phase 13 extends Phase 12's read boundary (richer per-object fields,
  // hierarchy, differentiated relationships, bounded geometry, a new
  // inspectDocument() operation) without turning NAQSH into a FreeCAD-
  // specific application, adding arbitrary execution, or adding broad
  // autonomous CAD modification. Every check below proves one specific way
  // that could have happened, structurally -- not by re-reading the code
  // and trusting it.

  const inspectionToolFiles = [
    "packages/core/src/inspect-environment-document-tool.ts",
    "packages/core/src/inspect-environment-objects-tool.ts",
    "packages/core/src/inspect-environment-object-tool.ts",
    "packages/core/src/inspect-environment-relationships-tool.ts"
  ];

  it("no source file under packages/core/src or packages/schemas/src names a FreeCAD-specific method/type (getFreeCADFeatureTree, getPartDesignBody, getSketchObject, ...) -- the inspection contract stays generic", () => {
    const forbiddenNames = ["getFreeCADFeatureTree", "getPartDesignBody", "getSketchObject", "runFreeCADPython", "runFreecadPython"];
    for (const relativePath of [...listTsFiles("packages/core/src"), ...listTsFiles("packages/schemas/src")]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const name of forbiddenNames) {
        assert.doesNotMatch(contents, new RegExp(name), `${relativePath} must not define/reference "${name}" -- FreeCAD-specific naming belongs only inside the adapter implementation, never in core/schemas`);
      }
    }
  });

  it("no Phase 13 inspection tool file imports the World Model WRITE path -- inspection stays entirely within the EnvironmentAdapter boundary, never reconciling into the World Model (Step 17: FreeCAD document != World Model)", () => {
    // Precision import-specifier match, not a bare word-match regex (the
    // same fix applied to the P14 guard below after it was caught
    // false-flagging a legitimate doc-comment mention) -- a file is free
    // to DISCUSS WorldModelState in prose while never importing the write
    // path that could actually mutate it.
    const forbiddenImports = ["./transitions.js", "./change-history.js", "./record-transition.js", "./bootstrap.js"];
    for (const relativePath of inspectionToolFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const forbidden of forbiddenImports) {
        assert.equal(contents.includes(forbidden), false, `${relativePath} must not import ${forbidden}`);
      }
    }
  });

  it("every Phase 13 inspection tool file imports only the generic EnvironmentAdapter interface, never a concrete adapter package", () => {
    const forbiddenPattern = /from\s+["'`]@naqsh\/adapters["'`]|from\s+["'`][^"'`]*freecad[^"'`]*["'`]/i;
    for (const relativePath of inspectionToolFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, forbiddenPattern, `${relativePath} must depend only on the EnvironmentAdapter interface (./environment-adapter.js), never a concrete adapter package`);
      assert.match(contents, /from\s+["'`]\.\/environment-adapter\.js["'`]/, `${relativePath} must import the EnvironmentAdapter interface`);
    }
  });

  it("every Phase 13 inspection tool is classified mutation:'observe' -- inspection can never smuggle in a mutation", () => {
    for (const relativePath of inspectionToolFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.match(contents, /mutation:\s*["'`]observe["'`]/, `${relativePath} must declare mutation: "observe"`);
      assert.doesNotMatch(contents, /mutation:\s*["'`]mutate["'`]/, `${relativePath} must never declare mutation: "mutate"`);
    }
  });

  it("no Phase 13 inspection tool file calls modifyObject/createObject/deleteObject -- inspection tools never write to the environment", () => {
    const forbiddenPattern = /\.(modifyObject|createObject|deleteObject)\s*\(/;
    for (const relativePath of inspectionToolFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, forbiddenPattern, `${relativePath} must never call a mutating EnvironmentAdapter method`);
    }
  });

  it("runner.py's OPERATIONS table still dispatches through the fixed, named table, including the new inspect_document operation -- no generic execution primitive was added", () => {
    const relativePath = "packages/adapters/freecad/runner.py";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /"inspect_document":\s*op_inspect_document/, `${relativePath} must register inspect_document in the fixed OPERATIONS table`);
    const forbiddenPatterns: RegExp[] = [/\beval\s*\(/, /\bexec\s*\(/, /\b__import__\s*\(/, /\bcompile\s*\(/, /\bos\.system\s*\(/, /\bsubprocess\./];
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(contents, pattern, `${relativePath} must not contain ${pattern} -- Phase 13's richer inspection must not introduce an execution surface`);
    }
  });

  it("EnvironmentAdapter still declares exactly six write-capable methods (create/modify/delete/save/checkpoint/restore) -- Phase 13 added inspectDocument as a read method, not a new write capability", () => {
    const relativePath = "packages/core/src/environment-adapter.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    for (const method of ["createObject", "modifyObject", "deleteObject", "save", "checkpoint", "restore", "inspectDocument", "listObjects", "inspectObject"]) {
      assert.match(contents, new RegExp(`${method}\\s*\\(`), `${relativePath} must still declare ${method}`);
    }
  });

  it("FreeCAD's own EnvironmentAdapter still declares no create/delete capability -- Phase 13 is inspection-only, no new mutation capability was granted", () => {
    // Superseded from its original Phase 13 form the same way the P12
    // guard above was -- Phase 14 deliberately adds "modify" and Phase 15
    // deliberately adds "checkpoint"; this guard still proves Phase 13
    // itself granted nothing beyond inspection/save.
    const relativePath = "packages/adapters/src/freecad-adapter.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    for (const capability of ["create", "delete"]) {
      assert.doesNotMatch(
        contents,
        new RegExp(`capabilities:\\s*\\[[^\\]]*["'\`]${capability}["'\`]`),
        `${relativePath} must not declare the "${capability}" capability`
      );
    }
  });
});

describe("P14 safe real CAD modification: narrow allowlist, validated before mutation, no arbitrary property writes", () => {
  // Phase 14 grants the FreeCAD adapter its FIRST genuine mutation
  // capability -- deliberately narrow (Step 8's explicit allowlist), with
  // every requested change validated (target/property/value/state) BEFORE
  // anything touches FreeCAD, and never through a generic "write any
  // property" escape hatch. Every check below proves one specific way
  // this narrowness/safety could have been silently lost, structurally.

  it("FreeCAD's own EnvironmentAdapter declares 'save' and 'modify' -- create/delete remain unsupported (checkpoint is Phase 15's own concern, see the P15 guard block below)", () => {
    const relativePath = "packages/adapters/src/freecad-adapter.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /capabilities:\s*\[[^\]]*["'`]save["'`][^\]]*\]/, `${relativePath} must declare "save"`);
    assert.match(contents, /capabilities:\s*\[[^\]]*["'`]modify["'`][^\]]*\]/, `${relativePath} must declare "modify"`);
    for (const capability of ["create", "delete"]) {
      assert.doesNotMatch(
        contents,
        new RegExp(`capabilities:\\s*\\[[^\\]]*["'\`]${capability}["'\`]`),
        `${relativePath} must not declare the "${capability}" capability`
      );
    }
  });

  it("runner.py's mutation allowlist (SUPPORTED_MUTATIONS) is the ONLY path to setattr() on a FreeCAD object -- no generic property-write primitive exists", () => {
    const relativePath = "packages/adapters/freecad/runner.py";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /^SUPPORTED_MUTATIONS\s*=\s*\{/m, `${relativePath} must define an explicit SUPPORTED_MUTATIONS allowlist`);
    // The only setattr(obj, ...) call site in this script must be inside
    // op_modify_object, gated by that allowlist -- not a bare, unguarded
    // "set any attribute the caller names" helper anywhere else. Matches
    // the real call shape (`setattr(obj, key, value)`) specifically, not
    // this file's own prose mentions of "setattr()" in comments (the exact
    // "match code, not comments" precision-regex lesson this suite already
    // applies everywhere else -- see the P8-P13 guard blocks above).
    const setattrCallSites = contents.match(/setattr\s*\(\s*obj\s*,/g) ?? [];
    assert.equal(setattrCallSites.length, 1, `${relativePath} must contain exactly one real setattr(obj, ...) call site (inside op_modify_object's own validated loop)`);
  });

  it("no source file anywhere in the repo defines executePython/executeFreeCADScript/runFreeCADCode or an equivalent arbitrary-execution tool name", () => {
    const forbiddenNames = ["executePython", "executeFreeCADScript", "runFreeCADCode", "execute_python", "execute_freecad_script", "run_freecad_code"];
    const allSourceFiles = [
      ...listTsFiles("packages/core/src"),
      ...listTsFiles("packages/schemas/src"),
      ...listTsFiles("packages/adapters/src"),
      ...listTsFiles("packages/model-providers/src"),
      ...listTsFiles("apps/api/src")
    ];
    for (const relativePath of allSourceFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const name of forbiddenNames) {
        assert.doesNotMatch(contents, new RegExp(name, "i"), `${relativePath} must not define/reference "${name}"`);
      }
    }
    const runnerContents = readFileSync(join(repoRoot, "packages/adapters/freecad/runner.py"), "utf8");
    for (const name of forbiddenNames) {
      assert.doesNotMatch(runnerContents, new RegExp(name, "i"), `runner.py must not define/reference "${name}"`);
    }
  });

  it("modify_environment_object is classified mutation:'mutate' -- Phase 14's real mutation still goes through P4's approval-required path, not observe/suggest", () => {
    const relativePath = "packages/core/src/modify-environment-object-tool.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /mutation:\s*["'`]mutate["'`]/, `${relativePath} must declare mutation: "mutate"`);
  });

  it("modify-environment-object-tool.ts never imports the World Model WRITE path -- an environment mutation still never touches the World Model directly", () => {
    // Same precision-import-specifier convention the P8/P9/P10 guards
    // above already use (matching an actual import specifier string, not
    // a bare word) -- this file's own doc comments legitimately DISCUSS
    // WorldModelState/reconciliation in prose (explaining what it
    // deliberately does NOT do), which a broader word-match regex would
    // wrongly flag.
    const relativePath = "packages/core/src/modify-environment-object-tool.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    const forbiddenImports = ["./transitions.js", "./change-history.js", "./record-transition.js", "./bootstrap.js"];
    for (const forbidden of forbiddenImports) {
      assert.equal(contents.includes(forbidden), false, `${relativePath} must not import ${forbidden}`);
    }
  });
});

describe("P15 checkpoints/snapshots/rollback/history: real capability, real audit trail, no bypass", () => {
  // Phase 15 grants the FreeCAD adapter its FIRST real recoverable-state
  // capability (checkpoint/restore) and gives core a genuine rollback
  // mutation (restore_checkpoint). Every check below proves one specific
  // way this could have silently become a bypass -- an unapproved
  // rollback, a fabricated snapshot, or a second competing history system
  // -- not by re-reading the code and trusting it.

  it("FreeCAD's own EnvironmentAdapter now declares 'checkpoint' -- a real capability, not still stubbed to unsupported_capability", () => {
    const relativePath = "packages/adapters/src/freecad-adapter.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /capabilities:\s*\[[^\]]*["'`]checkpoint["'`][^\]]*\]/, `${relativePath} must declare "checkpoint"`);
  });

  it("create_checkpoint is classified mutation:'suggest' (no approval required to capture a snapshot) -- restore_checkpoint is classified mutation:'mutate' (approval required to roll back)", () => {
    const createContents = readFileSync(join(repoRoot, "packages/core/src/create-checkpoint-tool.ts"), "utf8");
    assert.match(createContents, /mutation:\s*["'`]suggest["'`]/, "create-checkpoint-tool.ts must declare mutation: \"suggest\"");
    assert.doesNotMatch(createContents, /mutation:\s*["'`]mutate["'`]/, "create-checkpoint-tool.ts must never declare mutation: \"mutate\"");

    const restoreContents = readFileSync(join(repoRoot, "packages/core/src/restore-checkpoint-tool.ts"), "utf8");
    assert.match(restoreContents, /mutation:\s*["'`]mutate["'`]/, "restore-checkpoint-tool.ts must declare mutation: \"mutate\"");
  });

  it("restore_checkpoint reuses recordTransition/ChangeHistory -- rollback is recorded through the existing Change Model, not a second competing history system", () => {
    const relativePath = "packages/core/src/restore-checkpoint-tool.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.ok(contents.includes("./record-transition.js"), `${relativePath} must reuse recordTransition, not reimplement audited writes`);
    assert.doesNotMatch(contents, /new\s+Map\s*<[^>]*Change[^>]*>|class\s+\w*History/, `${relativePath} must not define a parallel history/ledger data structure`);
  });

  it("Checkpoint is genuinely append-only: CheckpointStore/ArtifactStore expose no update/delete/overwrite method", () => {
    // Negative lookbehind for a preceding "." excludes a legitimate METHOD
    // CALL on some unrelated object (e.g. artifact-store.ts's own
    // `createHash(...).update(content, ...)`, Node's crypto API, nothing
    // to do with mutating a stored artifact) -- only an INTERFACE/object-
    // literal method DEFINITION named update/delete/remove/overwrite would
    // match this.
    for (const relativePath of ["packages/core/src/checkpoint-store.ts", "packages/core/src/artifact-store.ts"]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(
        contents,
        /(?<!\.)\bupdate\s*\(|(?<!\.)\bdelete\s*\(|(?<!\.)\bremove\s*\(|(?<!\.)\boverwrite\s*\(/,
        `${relativePath} must not expose an update/delete/remove/overwrite method`
      );
    }
  });

  it("runner.py's checkpoint/restore operations are plain file copies -- no eval/exec/shell/subprocess execution surface was added", () => {
    const relativePath = "packages/adapters/freecad/runner.py";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /def op_checkpoint/, `${relativePath} must define op_checkpoint`);
    assert.match(contents, /def op_restore/, `${relativePath} must define op_restore`);
    assert.match(contents, /shutil\.copy2/, `${relativePath} must implement checkpoint/restore via a real file copy`);
    const forbiddenPatterns: RegExp[] = [/\beval\s*\(/, /\bexec\s*\(/, /\b__import__\s*\(/, /\bcompile\s*\(/, /\bos\.system\s*\(/, /\bsubprocess\./, /\bos\.popen\s*\(/];
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(contents, pattern, `${relativePath} must not contain ${pattern} -- Phase 15's checkpoint/restore must not introduce an execution surface`);
    }
  });

  it("no source file under packages/core/src or packages/schemas/src references a FreeCAD-specific file extension or path (.FCStd, .naqsh_checkpoints) -- the checkpoint contract stays environment-independent", () => {
    const forbiddenPatterns = [/\.FCStd/i, /naqsh_checkpoints/i];
    for (const relativePath of [...listTsFiles("packages/core/src"), ...listTsFiles("packages/schemas/src")]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not reference FreeCAD-specific file naming -- that belongs only inside the adapter`);
      }
    }
  });

  it("restore-checkpoint-tool.ts validates checkpoint.projectId against current state BEFORE touching the environment or World Model -- cross-project restore is a structural rejection, not left to opaque-id luck", () => {
    const relativePath = "packages/core/src/restore-checkpoint-tool.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /cross_project_forbidden/, `${relativePath} must reject a cross-project restore with a named, specific reason`);
  });
});

describe("P16 deterministic verification: pure evaluator, no arbitrary expressions, environment-independent", () => {
  // Phase 16's central architectural rule: "Gemini reasons and proposes.
  // Tools execute. Adapters observe. Verification independently
  // evaluates." verify.ts/evidence.ts are the PURE core of that rule --
  // every check below proves one specific way they could have silently
  // stopped being pure, environment-independent, or Gemini-independent.
  const verifierFiles = ["packages/core/src/verify.ts", "packages/core/src/evidence.ts"];
  const verificationToolFiles = ["packages/core/src/create-check-tool.ts", "packages/core/src/run-verification-tool.ts"];

  it("verify.ts/evidence.ts never import the World Model WRITE path -- the pure evaluator cannot mutate the World Model, a checkpoint, or anything else", () => {
    const forbiddenImports = ["./transitions.js", "./change-history.js", "./record-transition.js", "./bootstrap.js", "./checkpoint-store.js", "./artifact-store.js"];
    for (const relativePath of verifierFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const forbidden of forbiddenImports) {
        assert.equal(contents.includes(forbidden), false, `${relativePath} must not import ${forbidden} -- verification must never be able to mutate anything`);
      }
    }
  });

  it("verify.ts/evidence.ts never import a model-provider package, @google/genai, or an EnvironmentAdapter/concrete adapter -- the verdict is never Gemini's, and the pure evaluator never talks to an environment itself", () => {
    const forbiddenPatterns = [
      /from\s+["'`]@naqsh\/model-providers["'`]|require\s*\(\s*["'`]@naqsh\/model-providers["'`]\s*\)/,
      /from\s+["'`]@google\/genai["'`]|require\s*\(\s*["'`]@google\/genai["'`]\s*\)/,
      /from\s+["'`]@naqsh\/adapters["'`]/,
      /from\s+["'`]\.\/environment-adapter(-contract)?\.js["'`]/
    ];
    for (const relativePath of verifierFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not import ${pattern} -- the verdict must be deterministic, not Gemini's judgment, and evaluation itself never reaches into an environment`);
      }
    }
  });

  it("no source file under packages/core/src or packages/schemas/src imports anything FreeCAD-specific -- verification stays environment-independent (the P26 boundary this phase must not compromise)", () => {
    const forbiddenPattern = /from\s+["'`][^"'`]*freecad[^"'`]*["'`]|require\s*\(\s*["'`][^"'`]*freecad[^"'`]*["'`]\s*\)/i;
    for (const relativePath of [...verifierFiles, ...verificationToolFiles, "packages/schemas/src/verification-types.ts"]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, forbiddenPattern, `${relativePath} must not import anything FreeCAD-specific`);
    }
  });

  it("verify.ts declares no module-level mutable state -- every evaluation is a pure function of its own arguments, never a hidden global", () => {
    const forbiddenPatterns = [/^let\s+\w/m, /^const\s+\w+\s*=\s*new\s+Map/m, /^const\s+\w+\s*=\s*new\s+Set/m];
    const contents = readFileSync(join(repoRoot, "packages/core/src/verify.ts"), "utf8");
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(contents, pattern, "verify.ts must not declare module-level mutable state");
    }
  });

  it("no arbitrary code execution in the verifier -- a Check can never carry an executable expression", () => {
    const forbiddenPatterns: RegExp[] = [
      /\beval\s*\(/,
      /new\s+Function\s*\(/,
      /require\s*\(\s*["'`]child_process["'`]\s*\)/,
      /from\s+["'`]child_process["'`]/,
      /\bexecSync\s*\(/,
      /\bspawn\s*\(/,
      /import\s*\(\s*[a-zA-Z_$]/
    ];
    for (const relativePath of [...verifierFiles, ...verificationToolFiles]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not contain ${pattern}`);
      }
    }
  });

  it("run_verification is classified mutation:'verify'; create_check is classified mutation:'suggest' -- neither bypasses the approval boundary a real mutation would need", () => {
    const runContents = readFileSync(join(repoRoot, "packages/core/src/run-verification-tool.ts"), "utf8");
    assert.match(runContents, /mutation:\s*["'`]verify["'`]/, "run-verification-tool.ts must declare mutation: \"verify\"");
    assert.doesNotMatch(runContents, /mutation:\s*["'`]mutate["'`]/, "run-verification-tool.ts must never declare mutation: \"mutate\"");

    const createContents = readFileSync(join(repoRoot, "packages/core/src/create-check-tool.ts"), "utf8");
    assert.match(createContents, /mutation:\s*["'`]suggest["'`]/, "create-check-tool.ts must declare mutation: \"suggest\"");
    assert.doesNotMatch(createContents, /mutation:\s*["'`]mutate["'`]/, "create-check-tool.ts must never declare mutation: \"mutate\"");
  });

  it("run-verification-tool.ts never mutates via the EnvironmentAdapter -- it only calls the read-only inspectObject, never modifyObject/createObject/deleteObject", () => {
    const relativePath = "packages/core/src/run-verification-tool.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.doesNotMatch(contents, /\.(modifyObject|createObject|deleteObject)\s*\(/, `${relativePath} must never call a mutating EnvironmentAdapter method`);
    assert.match(contents, /\.inspectObject\s*\(/, `${relativePath} must call inspectObject to observe current evidence`);
  });

  it("CheckStore/VerificationResultStore expose no update/delete/overwrite method -- Checks and VerificationResults are immutable/append-only, matching CheckpointStore's precedent", () => {
    for (const relativePath of ["packages/core/src/check-store.ts", "packages/core/src/verification-result-store.ts"]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(
        contents,
        /(?<!\.)\bupdate\s*\(|(?<!\.)\bdelete\s*\(|(?<!\.)\bremove\s*\(|(?<!\.)\boverwrite\s*\(/,
        `${relativePath} must not expose an update/delete/remove/overwrite method`
      );
    }
  });

  it("Check.kind is a closed allowlist (CHECK_KINDS), never an open string or an executable expression field", () => {
    const relativePath = "packages/schemas/src/verification-types.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /export const CHECK_KINDS:/, `${relativePath} must export a closed CHECK_KINDS allowlist`);
    for (const forbiddenField of ["expression", "formula", "script", "code"]) {
      assert.doesNotMatch(contents, new RegExp(`${forbiddenField}\\s*:`), `${relativePath} must not carry a "${forbiddenField}" field on Check -- checks are typed and allowlisted, never arbitrary expressions`);
    }
  });
});

describe("P17 objective satisfaction: pure aggregation engine, no re-verification, no LLM verdict, no arbitrary expressions", () => {
  // Phase 17's central architectural rule mirrors Phase 16's exactly one
  // level up: "Gemini reasons. Tools execute. Adapters observe.
  // Verification independently evaluates." objective-satisfaction.ts is
  // the PURE core of that rule at the objective level -- every check below
  // proves one specific way it could have silently stopped being pure,
  // FreeCAD-independent, Gemini-independent, or a re-implementation of
  // verification logic instead of a consumer of it.
  const engineFiles = ["packages/core/src/objective-satisfaction.ts"];
  const toolFiles = ["packages/core/src/evaluate-objective-satisfaction-tool.ts"];

  it("objective-satisfaction.ts never imports the World Model WRITE path, an EnvironmentAdapter, or a store -- the pure engine cannot mutate anything or perform its own I/O", () => {
    const forbiddenImports = [
      "./transitions.js",
      "./change-history.js",
      "./record-transition.js",
      "./bootstrap.js",
      "./checkpoint-store.js",
      "./artifact-store.js",
      "./check-store.js",
      "./verification-result-store.js",
      "./objective-satisfaction-store.js",
      "./environment-adapter.js"
    ];
    for (const relativePath of engineFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const forbidden of forbiddenImports) {
        assert.equal(contents.includes(forbidden), false, `${relativePath} must not import ${forbidden} -- the pure engine must never mutate anything or look anything up itself`);
      }
    }
  });

  it("objective-satisfaction.ts never imports a model-provider package, @google/genai, or anything FreeCAD-specific -- the verdict is never Gemini's, and stays environment-independent", () => {
    const forbiddenPatterns = [
      /from\s+["'`]@naqsh\/model-providers["'`]|require\s*\(\s*["'`]@naqsh\/model-providers["'`]\s*\)/,
      /from\s+["'`]@google\/genai["'`]|require\s*\(\s*["'`]@google\/genai["'`]\s*\)/,
      /from\s+["'`]@naqsh\/adapters["'`]/,
      /from\s+["'`][^"'`]*freecad[^"'`]*["'`]/i
    ];
    for (const relativePath of engineFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not import ${pattern}`);
      }
    }
  });

  it("objective-satisfaction.ts never re-implements deterministic verification -- it only consumes VerificationResult, it never imports or duplicates verify.ts's own check-evaluation logic", () => {
    const contents = readFileSync(join(repoRoot, "packages/core/src/objective-satisfaction.ts"), "utf8");
    assert.doesNotMatch(contents, /from\s+["'`]\.\/verify\.js["'`]/, "objective-satisfaction.ts must not import verify.ts -- P17 consumes VerificationResults, it never re-runs a Check itself");
    assert.doesNotMatch(contents, /from\s+["'`]\.\/evidence\.js["'`]/, "objective-satisfaction.ts must not import evidence.ts -- P17 never builds its own Evidence");
  });

  it("objective-satisfaction.ts declares no module-level mutable state", () => {
    const forbiddenPatterns = [/^let\s+\w/m, /^const\s+\w+\s*=\s*new\s+Map/m, /^const\s+\w+\s*=\s*new\s+Set/m];
    const contents = readFileSync(join(repoRoot, "packages/core/src/objective-satisfaction.ts"), "utf8");
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(contents, pattern, "objective-satisfaction.ts must not declare module-level mutable state");
    }
  });

  it("no arbitrary code execution in the satisfaction engine or its tool -- an ObjectiveConditionOutcome can never carry an executable expression", () => {
    const forbiddenPatterns: RegExp[] = [
      /\beval\s*\(/,
      /new\s+Function\s*\(/,
      /require\s*\(\s*["'`]child_process["'`]\s*\)/,
      /from\s+["'`]child_process["'`]/,
      /\bexecSync\s*\(/,
      /\bspawn\s*\(/,
      /import\s*\(\s*[a-zA-Z_$]/
    ];
    for (const relativePath of [...engineFiles, ...toolFiles]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not contain ${pattern}`);
      }
    }
  });

  it("evaluate_objective_satisfaction is classified mutation:'verify' -- it never bypasses the approval boundary a real mutation would need", () => {
    const contents = readFileSync(join(repoRoot, "packages/core/src/evaluate-objective-satisfaction-tool.ts"), "utf8");
    assert.match(contents, /mutation:\s*["'`]verify["'`]/, "evaluate-objective-satisfaction-tool.ts must declare mutation: \"verify\"");
    assert.doesNotMatch(contents, /mutation:\s*["'`]mutate["'`]/, "evaluate-objective-satisfaction-tool.ts must never declare mutation: \"mutate\"");
  });

  it("evaluate-objective-satisfaction-tool.ts never imports an EnvironmentAdapter or a concrete adapter package -- P17 never touches the environment directly, only P16's already-produced VerificationResults", () => {
    const relativePath = "packages/core/src/evaluate-objective-satisfaction-tool.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.doesNotMatch(contents, /from\s+["'`]@naqsh\/adapters["'`]/, `${relativePath} must not import @naqsh/adapters`);
    assert.doesNotMatch(contents, /from\s+["'`]\.\/environment-adapter(-contract)?\.js["'`]/, `${relativePath} must not import the EnvironmentAdapter interface -- it has no business talking to an environment at all`);
  });

  it("evaluate-objective-satisfaction-tool.ts never imports the World Model WRITE path -- it only reads WorldModelState, never mutates it", () => {
    const relativePath = "packages/core/src/evaluate-objective-satisfaction-tool.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    const forbiddenImports = ["./transitions.js", "./change-history.js", "./record-transition.js", "./bootstrap.js"];
    for (const forbidden of forbiddenImports) {
      assert.equal(contents.includes(forbidden), false, `${relativePath} must not import ${forbidden}`);
    }
  });

  it("ObjectiveSatisfactionStore exposes no update/delete/overwrite method -- results are append-only, matching VerificationResultStore's precedent", () => {
    const relativePath = "packages/core/src/objective-satisfaction-store.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.doesNotMatch(
      contents,
      /(?<!\.)\bupdate\s*\(|(?<!\.)\bdelete\s*\(|(?<!\.)\bremove\s*\(|(?<!\.)\boverwrite\s*\(/,
      `${relativePath} must not expose an update/delete/remove/overwrite method`
    );
  });

  it("ObjectiveSatisfactionStatus is a closed allowlist (satisfied/not_satisfied/inconclusive), never an open string", () => {
    const relativePath = "packages/schemas/src/objective-satisfaction-types.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /export const OBJECTIVE_SATISFACTION_STATUSES:/, `${relativePath} must export a closed OBJECTIVE_SATISFACTION_STATUSES allowlist`);
    for (const forbiddenField of ["expression", "formula", "script", "code"]) {
      assert.doesNotMatch(contents, new RegExp(`${forbiddenField}\\s*:`), `${relativePath} must not carry a "${forbiddenField}" field -- satisfaction is computed from typed VerificationResults, never an arbitrary expression`);
    }
  });
});

describe("P18 natural language -> structured requirement: bounded interpretation, deterministic validation, no LLM authority", () => {
  // Phase 18's central architectural rule: "Natural language may propose
  // meaning. Structured state records meaning. Deterministic systems
  // validate what can be validated." interpret-requirement-tool.ts is the
  // bounded Gemini-facing half (never touches WorldModelState);
  // add-requirement-tool.ts is the approval-gated mutation half (never
  // trusts a candidate's shape without re-validating it). Every check
  // below proves one specific way that boundary could have silently
  // eroded.
  const interpreterFiles = ["packages/core/src/requirement-interpreter.ts"];
  const interpretToolFiles = ["packages/core/src/interpret-requirement-tool.ts"];
  const addToolFiles = ["packages/core/src/add-requirement-tool.ts"];

  it("requirement-interpreter.ts and interpret-requirement-tool.ts never import the World Model WRITE path -- interpreting text cannot mutate anything", () => {
    const forbiddenImports = ["./transitions.js", "./change-history.js", "./record-transition.js", "./bootstrap.js"];
    for (const relativePath of [...interpreterFiles, ...interpretToolFiles]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const forbidden of forbiddenImports) {
        assert.equal(contents.includes(forbidden), false, `${relativePath} must not import ${forbidden} -- interpretation must never be able to mutate the World Model`);
      }
    }
  });

  it("requirement-interpreter.ts never imports executeTool/invokeRegisteredTool, an EnvironmentAdapter, or a concrete adapter package -- interpreting text cannot execute a tool or touch an environment", () => {
    const forbiddenPatterns = [
      /from\s+["'`]\.\/execute-tool\.js["'`]/,
      /invokeRegisteredTool\s*\(/,
      /from\s+["'`]@naqsh\/adapters["'`]/,
      /from\s+["'`]\.\/environment-adapter(-contract)?\.js["'`]/
    ];
    for (const relativePath of interpreterFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not reference ${pattern}`);
      }
    }
  });

  it("interpret_requirement is classified mutation:'suggest'; add_requirement is classified mutation:'mutate' -- interpreting text is never itself a World Model write", () => {
    const interpretContents = readFileSync(join(repoRoot, "packages/core/src/interpret-requirement-tool.ts"), "utf8");
    assert.match(interpretContents, /mutation:\s*["'`]suggest["'`]/, "interpret-requirement-tool.ts must declare mutation: \"suggest\"");
    assert.doesNotMatch(interpretContents, /mutation:\s*["'`]mutate["'`]/, "interpret-requirement-tool.ts must never declare mutation: \"mutate\"");

    const addContents = readFileSync(join(repoRoot, "packages/core/src/add-requirement-tool.ts"), "utf8");
    assert.match(addContents, /mutation:\s*["'`]mutate["'`]/, "add-requirement-tool.ts must declare mutation: \"mutate\" -- adding a requirement is a real World Model mutation, gated the same as any other");
  });

  it("add_requirement mutates the World Model only through recordTransition, reusing the EXISTING add_requirement transition -- no direct state.project.requirements.push, no new transition kind invented", () => {
    const relativePath = "packages/core/src/add-requirement-tool.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /recordTransition\s*\(/, `${relativePath} must call recordTransition`);
    assert.match(contents, /kind:\s*["'`]add_requirement["'`]/, `${relativePath} must use the existing "add_requirement" transition kind`);
    assert.doesNotMatch(contents, /\.requirements\.push\s*\(/, `${relativePath} must never directly push onto project.requirements`);
    assert.doesNotMatch(
      contents,
      /from\s+["'`]\.\/transitions\.js["'`]/,
      `${relativePath} must not import ./transitions.js directly -- recordTransition is the sole audited write path`
    );
  });

  it("add_requirement rejects an ambiguous candidate outright -- an underspecified natural-language statement can never become an authoritative requirement", () => {
    const relativePath = "packages/core/src/add-requirement-tool.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /ambiguous_candidate/, `${relativePath} must explicitly reject an ambiguous candidate`);
  });

  it("requirement-interpreter.ts never imports a concrete model-provider package or @google/genai -- only the provider-agnostic ModelProvider interface", () => {
    const forbiddenPatterns = [
      /from\s+["'`]@naqsh\/model-providers["'`]|require\s*\(\s*["'`]@naqsh\/model-providers["'`]\s*\)/,
      /from\s+["'`]@google\/genai["'`]|require\s*\(\s*["'`]@google\/genai["'`]\s*\)/
    ];
    for (const relativePath of interpreterFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not import ${pattern} -- requirement interpretation depends only on the ModelProvider interface`);
      }
    }
  });

  it("requirement-interpreter.ts declares no module-level mutable state", () => {
    const forbiddenPatterns = [/^let\s+\w/m, /^const\s+\w+\s*=\s*new\s+Map/m, /^const\s+\w+\s*=\s*new\s+Set/m];
    for (const relativePath of interpreterFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not declare module-level mutable state`);
      }
    }
  });

  it("no arbitrary code execution anywhere in the P18 files -- natural-language input can never become executable input", () => {
    const forbiddenPatterns: RegExp[] = [
      /\beval\s*\(/,
      /new\s+Function\s*\(/,
      /require\s*\(\s*["'`]child_process["'`]\s*\)/,
      /from\s+["'`]child_process["'`]/,
      /\bexecSync\s*\(/,
      /\bspawn\s*\(/,
      /import\s*\(\s*[a-zA-Z_$]/
    ];
    for (const relativePath of [...interpreterFiles, ...interpretToolFiles, ...addToolFiles]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not contain ${pattern}`);
      }
    }
  });

  it("RequirementCandidate carries no expression/formula/script field -- interpretation output is typed data, never an executable payload", () => {
    const relativePath = "packages/schemas/src/requirement-candidate-types.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    for (const forbiddenField of ["expression", "formula", "script", "code"]) {
      assert.doesNotMatch(contents, new RegExp(`${forbiddenField}\\s*:`), `${relativePath} must not carry a "${forbiddenField}" field on RequirementCandidate`);
    }
  });

  it("add-requirement-tool.ts never imports an EnvironmentAdapter, a concrete adapter package, or a model-provider package -- accepting a requirement is a pure World Model write, not an environment or Gemini operation", () => {
    const relativePath = "packages/core/src/add-requirement-tool.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    const forbiddenPatterns = [
      /from\s+["'`]@naqsh\/adapters["'`]/,
      /from\s+["'`]\.\/environment-adapter(-contract)?\.js["'`]/,
      /from\s+["'`]@naqsh\/model-providers["'`]/,
      /from\s+["'`]@google\/genai["'`]/
    ];
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(contents, pattern, `${relativePath} must not import ${pattern}`);
    }
  });

  it("apps/api's requirement service stays a thin pass-through -- no adapter coupling, no direct executeTool/invokeRegisteredTool path in the API layer either", () => {
    const relativePath = "apps/api/src/requirement-service.ts";
    if (!existsSync(join(repoRoot, relativePath))) return;
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    const forbiddenPatterns = [/from\s+["'`]@naqsh\/adapters["'`]/, /invokeRegisteredTool\s*\(/, /from\s+["'`]\.\/execute-tool\.js["'`]/];
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(contents, pattern, `${relativePath} must not reference ${pattern}`);
    }
  });

  it("P16/P17 boundary: P18 creates requirements, it never verifies or evaluates objective satisfaction itself", () => {
    // Phase 18 stops at producing a candidate and, once accepted, a real
    // Requirement -- it must never re-implement or reach into P16
    // (deterministic verification) or P17 (objective satisfaction). The
    // pipeline stays Requirement -> Verification -> Objective Satisfaction,
    // never collapsed or short-circuited by this phase.
    const forbiddenImports = [
      "./verify.js",
      "./evidence.js",
      "./verification-result-store.js",
      "./run-verification-tool.js",
      "./objective-satisfaction.js",
      "./objective-satisfaction-store.js",
      "./evaluate-objective-satisfaction-tool.js"
    ];
    for (const relativePath of [...interpreterFiles, ...interpretToolFiles, ...addToolFiles]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const forbidden of forbiddenImports) {
        assert.equal(contents.includes(forbidden), false, `${relativePath} must not import ${forbidden} -- P18 never performs verification or objective satisfaction`);
      }
    }
  });

  it("add_requirement never declares a Requirement 'satisfied'/'violated' itself -- only P16/P17 (via a separate, later pipeline stage) determine that", () => {
    const relativePath = "packages/core/src/add-requirement-tool.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.doesNotMatch(contents, /status:\s*["'`](satisfied|violated)["'`]/, `${relativePath} must not itself assign a satisfied/violated status to the Requirement it creates`);
  });
});

describe("P19 requirement clarification: deterministic completeness analysis, bounded re-interpretation, no LLM authority over completeness", () => {
  // Phase 19's central architectural rule mirrors P18's exactly one level
  // up: "NAQSH must ASK when information is genuinely missing. It must
  // NOT invent engineering assumptions to make the requirement look
  // complete." requirement-completeness.ts is the PURE, Gemini-free half
  // (decides WHETHER to ask); answer-clarification-tool.ts is the bounded
  // Gemini-facing half (re-interprets an answer, via the EXISTING P18
  // pipeline, never a new prompt); clarification-store.ts never touches
  // the World Model. Every check below proves one specific way this
  // boundary could have silently eroded.
  const analyzerFiles = ["packages/core/src/requirement-completeness.ts"];
  const analyzeToolFiles = ["packages/core/src/analyze-requirement-completeness-tool.ts"];
  const answerToolFiles = ["packages/core/src/answer-clarification-tool.ts"];
  const dismissToolFiles = ["packages/core/src/dismiss-clarification-tool.ts"];
  const storeFiles = ["packages/core/src/clarification-store.ts"];
  const allP19Files = [...analyzerFiles, ...analyzeToolFiles, ...answerToolFiles, ...dismissToolFiles, ...storeFiles];

  it("requirement-completeness.ts (the pure analyzer) never imports a model-provider package, @google/genai, or the World Model write path -- completeness analysis is fully deterministic, no Gemini call", () => {
    const forbiddenPatterns = [
      /from\s+["'`]@naqsh\/model-providers["'`]/,
      /from\s+["'`]@google\/genai["'`]/,
      /from\s+["'`]\.\/transitions\.js["'`]/,
      /from\s+["'`]\.\/change-history\.js["'`]/,
      /from\s+["'`]\.\/record-transition\.js["'`]/,
      /from\s+["'`]\.\/execute-tool\.js["'`]/,
      /from\s+["'`]@naqsh\/adapters["'`]/
    ];
    const contents = readFileSync(join(repoRoot, analyzerFiles[0]!), "utf8");
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(contents, pattern, `${analyzerFiles[0]} must not reference ${pattern} -- completeness analysis must stay pure and Gemini-free`);
    }
  });

  it("none of the P19 files import the World Model WRITE path -- clarification (asking, answering, or dismissing) can never itself mutate WorldModelState", () => {
    const forbiddenImports = ["./transitions.js", "./change-history.js", "./record-transition.js", "./bootstrap.js"];
    for (const relativePath of allP19Files) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const forbidden of forbiddenImports) {
        assert.equal(contents.includes(forbidden), false, `${relativePath} must not import ${forbidden} -- P19 never mutates the World Model directly`);
      }
    }
  });

  it("answer-clarification-tool.ts reuses interpretRequirementFromText (P18) unchanged -- P19 never defines its own Gemini prompt/system instruction", () => {
    const contents = readFileSync(join(repoRoot, answerToolFiles[0]!), "utf8");
    assert.match(contents, /from\s+["'`]\.\/requirement-interpreter\.js["'`]/, "answer-clarification-tool.ts must import interpretRequirementFromText from requirement-interpreter.js (P18)");
    assert.doesNotMatch(contents, /systemInstruction\s*[:=]/, "answer-clarification-tool.ts must not define its own systemInstruction -- it reuses P18's");
    assert.doesNotMatch(contents, /from\s+["'`]@google\/genai["'`]/, "answer-clarification-tool.ts must not import @google/genai directly");
  });

  it("all three P19 tools are classified mutation:'suggest' -- never 'mutate'; none touches the environment adapter", () => {
    for (const relativePath of [...analyzeToolFiles, ...answerToolFiles, ...dismissToolFiles]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.match(contents, /mutation:\s*["'`]suggest["'`]/, `${relativePath} must declare mutation: "suggest"`);
      assert.doesNotMatch(contents, /mutation:\s*["'`]mutate["'`]/, `${relativePath} must never declare mutation: "mutate"`);
      assert.doesNotMatch(contents, /from\s+["'`]@naqsh\/adapters["'`]/, `${relativePath} must not import @naqsh/adapters`);
      assert.doesNotMatch(contents, /from\s+["'`]\.\/environment-adapter(-contract)?\.js["'`]/, `${relativePath} must not import an EnvironmentAdapter -- clarification can never touch CAD`);
    }
  });

  it("dismiss_clarification and clarification-store.ts never call interpretRequirementFromText or import a model-provider package -- only answer_clarification is Gemini-facing", () => {
    for (const relativePath of [...dismissToolFiles, ...storeFiles]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, /interpretRequirementFromText/, `${relativePath} must not call interpretRequirementFromText`);
      assert.doesNotMatch(contents, /from\s+["'`]@naqsh\/model-providers["'`]/, `${relativePath} must not import @naqsh/model-providers`);
    }
  });

  it("no arbitrary code execution anywhere in the P19 files -- a clarification answer can never become executable input", () => {
    const forbiddenPatterns: RegExp[] = [
      /\beval\s*\(/,
      /new\s+Function\s*\(/,
      /require\s*\(\s*["'`]child_process["'`]\s*\)/,
      /from\s+["'`]child_process["'`]/,
      /\bexecSync\s*\(/,
      /\bspawn\s*\(/,
      /import\s*\(\s*[a-zA-Z_$]/
    ];
    for (const relativePath of allP19Files) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not contain ${pattern}`);
      }
    }
  });

  it("Clarification carries no expression/formula/script field -- a clarification is typed data, never an executable payload", () => {
    const relativePath = "packages/schemas/src/clarification-types.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    for (const forbiddenField of ["expression", "formula", "script", "code"]) {
      assert.doesNotMatch(contents, new RegExp(`${forbiddenField}\\s*:`), `${relativePath} must not carry a "${forbiddenField}" field on Clarification`);
    }
  });

  it("answer_clarification rejects a candidate that is still 'ambiguous' after re-interpretation -- an unresolved answer can never become authoritative", () => {
    const contents = readFileSync(join(repoRoot, answerToolFiles[0]!), "utf8");
    assert.match(contents, /answer_insufficient/, "answer-clarification-tool.ts must explicitly reject an answer that leaves the candidate ambiguous");
  });

  it("analyze_requirement_completeness never itself creates a Requirement -- only add_requirement (P18, unmodified) does", () => {
    const contents = readFileSync(join(repoRoot, analyzeToolFiles[0]!), "utf8");
    assert.doesNotMatch(contents, /createRequirement\s*\(/, "analyze-requirement-completeness-tool.ts must not call createRequirement");
  });

  it("no P19 file duplicates P16/P17's verification/objective-satisfaction machinery", () => {
    const forbiddenImports = [
      "./verify.js",
      "./evidence.js",
      "./verification-result-store.js",
      "./run-verification-tool.js",
      "./objective-satisfaction.js",
      "./objective-satisfaction-store.js",
      "./evaluate-objective-satisfaction-tool.js"
    ];
    for (const relativePath of allP19Files) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const forbidden of forbiddenImports) {
        assert.equal(contents.includes(forbidden), false, `${relativePath} must not import ${forbidden} -- P19 never performs verification or objective satisfaction`);
      }
    }
  });
});

describe("P20 intent -> requirements -> plan -> design -> build -> verify: environment-independent design, bounded build, no verification duplication", () => {
  // Phase 20's central architectural rule: "P20 is NOT 'generate random CAD
  // from a prompt'. P20 IS 'transform a validated engineering intent into
  // a structured, inspectable, bounded design/build workflow.'"
  // design-generator.ts/design-semantics.ts are the PURE, Gemini-bounded
  // half (never touch WorldModelState or an environment); create-environment-object-tool.ts/
  // build-executor.ts are the bounded EXECUTION half (real mutations, only
  // through the EXISTING P3/P4 boundary); build_success is NEVER conflated
  // with verification/objective satisfaction (P16/P17, untouched). Every
  // check below proves one specific way these boundaries could have
  // silently eroded.
  const designGeneratorFiles = ["packages/core/src/design-generator.ts"];
  const designSemanticsFiles = ["packages/core/src/design-semantics.ts"];
  const designStoreFiles = ["packages/core/src/design-specification-store.ts"];
  const createEnvObjectToolFiles = ["packages/core/src/create-environment-object-tool.ts"];
  const buildOperationsFiles = ["packages/core/src/build-operations.ts"];
  const buildExecutorFiles = ["packages/core/src/build-executor.ts"];
  const buildResultStoreFiles = ["packages/core/src/build-result-store.ts"];
  const allP20Files = [
    ...designGeneratorFiles,
    ...designSemanticsFiles,
    ...designStoreFiles,
    ...createEnvObjectToolFiles,
    ...buildOperationsFiles,
    ...buildExecutorFiles,
    ...buildResultStoreFiles
  ];

  it("design-generator.ts/design-semantics.ts never import the World Model write path, executeTool, or an EnvironmentAdapter -- generating/validating a design cannot mutate or execute anything", () => {
    const forbiddenPatterns = [
      /from\s+["'`]\.\/transitions\.js["'`]/,
      /from\s+["'`]\.\/change-history\.js["'`]/,
      /from\s+["'`]\.\/record-transition\.js["'`]/,
      /from\s+["'`]\.\/execute-tool\.js["'`]/,
      /from\s+["'`]@naqsh\/adapters["'`]/,
      /from\s+["'`]\.\/environment-adapter(-contract)?\.js["'`]/
    ];
    for (const relativePath of [...designGeneratorFiles, ...designSemanticsFiles]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not reference ${pattern} -- design generation/validation must stay pure`);
      }
    }
  });

  it("design-specification-types.ts is environment-independent -- no FreeCAD-specific concept in the CODE itself (doc comments are allowed to name FreeCAD when explaining the boundary, e.g. 'never carries a FreeCAD document-object reference')", () => {
    const relativePath = "packages/schemas/src/design-specification-types.ts";
    const raw = readFileSync(join(repoRoot, relativePath), "utf8");
    // Strip block comments (/** ... */) and line comments (// ...) so the
    // check inspects only actual field names/types/logic, not the doc
    // prose that legitimately explains what FreeCAD-specific data this
    // file deliberately excludes.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").toLowerCase();
    for (const forbidden of ["freecad", "part::feature", "part::box", "activedocument", "@google/genai"]) {
      assert.equal(code.includes(forbidden), false, `${relativePath}'s actual code (outside doc comments) must not reference "${forbidden}" -- the design representation must remain environment-independent (P26 depends on this)`);
    }
  });

  it("create_environment_object is classified mutation:'mutate', target:'environment' -- a real, permission-gated environment mutation, never a World Model write", () => {
    const relativePath = "packages/core/src/create-environment-object-tool.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /mutation:\s*["'`]mutate["'`]/, `${relativePath} must declare mutation: "mutate"`);
    assert.match(contents, /target:\s*["'`]environment["'`]/, `${relativePath} must declare target: "environment"`);
    assert.doesNotMatch(contents, /from\s+["'`]\.\/transitions\.js["'`]/, `${relativePath} must not import the World Model write path`);
  });

  it("build-operations.ts (the deterministic DesignSpecification -> BuildOperation translator) never imports a model-provider package, @google/genai, executeTool, or an EnvironmentAdapter -- planning build operations is mechanical, not a new Gemini call or an execution path", () => {
    const relativePath = buildOperationsFiles[0]!;
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    const forbiddenPatterns = [
      /from\s+["'`]@naqsh\/model-providers["'`]/,
      /from\s+["'`]@google\/genai["'`]/,
      /from\s+["'`]\.\/execute-tool\.js["'`]/,
      /from\s+["'`]@naqsh\/adapters["'`]/,
      /from\s+["'`]\.\/environment-adapter(-contract)?\.js["'`]/
    ];
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(contents, pattern, `${relativePath} must not reference ${pattern}`);
    }
  });

  it("build-executor.ts mutates the environment ONLY through executeTool (the existing P3/P4 boundary) -- no direct EnvironmentAdapter import, no second execution mechanism, no direct World Model write", () => {
    const relativePath = buildExecutorFiles[0]!;
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /from\s+["'`]\.\/execute-tool\.js["'`]/, `${relativePath} must call the existing executeTool boundary`);
    assert.doesNotMatch(contents, /from\s+["'`]@naqsh\/adapters["'`]/, `${relativePath} must not import a concrete adapter package`);
    assert.doesNotMatch(contents, /from\s+["'`]\.\/environment-adapter(-contract)?\.js["'`]/, `${relativePath} must not import EnvironmentAdapter directly -- it only knows the generic Tool boundary`);
    assert.doesNotMatch(contents, /from\s+["'`]\.\/transitions\.js["'`]/, `${relativePath} must not import the World Model write path`);
    assert.doesNotMatch(contents, /from\s+["'`]\.\/record-transition\.js["'`]/, `${relativePath} must not import recordTransition`);
  });

  it("Step 14: BuildResult (build-types.ts) is never conflated with verification/objective satisfaction -- no P16/P17 type or store imported by the build layer", () => {
    const forbiddenImports = [
      "./verify.js",
      "./evidence.js",
      "./verification-result-store.js",
      "./run-verification-tool.js",
      "./objective-satisfaction.js",
      "./objective-satisfaction-store.js",
      "./evaluate-objective-satisfaction-tool.js"
    ];
    for (const relativePath of [...buildOperationsFiles, ...buildExecutorFiles, ...buildResultStoreFiles]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const forbidden of forbiddenImports) {
        assert.equal(contents.includes(forbidden), false, `${relativePath} must not import ${forbidden} -- build_success is never verification or objective satisfaction`);
      }
    }
    const buildTypesContents = readFileSync(join(repoRoot, "packages/schemas/src/build-types.ts"), "utf8");
    for (const forbidden of ["verificationResult", "objectiveSatisfaction", "verificationPassed", "objectiveSatisfied"]) {
      assert.equal(buildTypesContents.includes(forbidden), false, `build-types.ts must not carry a "${forbidden}" field -- BuildResult only ever claims build_success`);
    }
  });

  it("no arbitrary code execution anywhere in the P20 files -- a design/build cannot become executable input", () => {
    const forbiddenPatterns: RegExp[] = [
      /\beval\s*\(/,
      /new\s+Function\s*\(/,
      /require\s*\(\s*["'`]child_process["'`]\s*\)/,
      /from\s+["'`]child_process["'`]/,
      /\bexecSync\s*\(/,
      /\bspawn\s*\(/,
      /import\s*\(\s*[a-zA-Z_$]/
    ];
    for (const relativePath of allP20Files) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not contain ${pattern}`);
      }
    }
  });

  it("design-generator.ts never imports a concrete model-provider package or @google/genai -- only the provider-agnostic ModelProvider interface, same discipline as every prior Gemini-facing file", () => {
    const relativePath = designGeneratorFiles[0]!;
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    const forbiddenPatterns = [/from\s+["'`]@naqsh\/model-providers["'`]/, /from\s+["'`]@google\/genai["'`]/];
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(contents, pattern, `${relativePath} must not import ${pattern}`);
    }
  });

  it("DesignSpecificationStore/BuildResultStore are immutable-once-saved -- no update/delete method exists on either interface", () => {
    for (const relativePath of [...designStoreFiles, ...buildResultStoreFiles]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, /^\s*update\s*\(/m, `${relativePath} must not expose an update() method`);
      assert.doesNotMatch(contents, /^\s*delete\s*\(/m, `${relativePath} must not expose a delete() method`);
    }
  });
});
