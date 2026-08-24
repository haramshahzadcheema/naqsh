/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Relative, not absolute ("/assets/..."), asset paths in the build
  // output -- an absolute path resolves against the filesystem ROOT (not
  // this file's own directory) when the built index.html is loaded via
  // `file://`, which is exactly how the NAQSH Desktop packaged app opens
  // it (apps/desktop/src/main.ts's `loadFile`). Harmless for the normal
  // browser/HTTP-served deployment, since the app is always served from
  // its origin's root.
  base: "./",
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    css: false,
    // Vitest's own per-test default is 5000ms, which is LOWER than the
    // worst-case runtime of this suite's full-app integration tests under
    // parallel load (measured ~5.6s for the chat-first workflow test).
    // That ceiling has to sit comfortably above the 5000ms
    // `asyncUtilTimeout` configured in vitest.setup.ts, otherwise a single
    // slow `findBy*` would blow the whole test's budget before it could
    // even report which element it was waiting for.
    testTimeout: 20_000
  }
});
