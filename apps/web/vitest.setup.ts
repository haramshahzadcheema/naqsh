import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/dom";

// Testing Library's default `findBy*` budget is 1000ms. That is genuinely
// too tight for this suite's heaviest tests, which render the ENTIRE app
// and drive a multi-step async workflow (type -> send -> extraction ->
// re-render) inside jsdom, while Vitest runs other test files in parallel
// on the same machine. Measured: the chat-first workflow test takes ~3.2s
// in isolation but ~5.6s under full-suite load, and it was intermittently
// failing on a single `findByText` that had not yet resolved at the 1s
// mark -- a flaky FALSE failure about timing, not about behavior.
//
// Raising the budget does not weaken any assertion: `findBy*` still fails
// if the element never appears, it simply waits long enough to tell the
// difference between "never appears" and "this machine was busy". A test
// that genuinely regresses still fails, just 5s later.
configure({ asyncUtilTimeout: 5000 });

// jsdom does not implement matchMedia. A safe default (never reduced
// motion, never dark) keeps every component that reads
// prefers-reduced-motion/prefers-color-scheme from crashing on render;
// individual tests override `window.matchMedia` when they need to assert
// reduced-motion behavior specifically.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false
    }) as MediaQueryList;
}

// jsdom does not implement the Blob URL registry -- the export/download
// feature (chat/exportThread.ts) needs createObjectURL/revokeObjectURL to
// exist so building the temporary <a download> element doesn't throw.
if (typeof URL.createObjectURL !== "function") {
  URL.createObjectURL = () => "blob:mock-url";
}
if (typeof URL.revokeObjectURL !== "function") {
  URL.revokeObjectURL = () => {};
}

// The suite must not depend on whether a dev server happens to be
// listening on the API port.
//
// `ApiConnectionProvider` probes `GET /health` on mount through a real
// `fetch`, and nothing stubbed it -- so with `npm run dev` running, that
// probe SUCCEEDED and the app took its "connected to a real backend"
// path instead of the offline/demo path several tests assert against.
// Three tests failed for that reason alone, and only that reason:
// verified by stopping the server and re-running (137/137).
//
// That is a real hazard for anyone evaluating this repo, who is very
// likely to have the app running while they try `npm test`.
//
// Failing the default `fetch` makes "no server" the deterministic
// baseline. Tests that genuinely exercise a connected backend (see
// `OnlineChat.test.tsx`, `FreeCADConnect.test.tsx`) spy on the
// `apiClient` functions directly and never reach this, so they are
// unaffected -- and any test that DOES want real transport can still
// override `global.fetch` itself.
global.fetch = (async () => {
  throw new TypeError("fetch is disabled in tests -- mock the apiClient function you need");
}) as unknown as typeof fetch;
