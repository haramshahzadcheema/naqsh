# Running Naqsh locally

Naqsh drives **real FreeCAD** — a genuine `.FCStd` file on disk, mutated
through a headless subprocess boundary. That only works on a machine that
has FreeCAD installed, which is why this runs locally rather than from a
hosted URL. The interesting half of this project is the half a web host
cannot show you.

Two paths below. The first needs nothing but Node.

**Short on time?** The [demo video](https://www.youtube.com/watch?v=uQXj_l76ppc) shows the whole loop, including real geometry appearing in FreeCAD.

---

## Path 1 — Full walkthrough, no credentials (2 minutes)

```bash
npm install
npm run dev
```

Open **http://localhost:5173**.

In the composer, set the model to **Deterministic (testing)**. This is a
real, scripted provider — not a stub that fakes success — and it runs the
entire mechanical loop offline:

> requirements → plan → proposal → **your approval** → execute → verify

Try, one message at a time:

```
The bracket must be no more than 100mm long.
The bracket must be no more than 60mm wide.
generate
```

Approve the proposal that appears. Naqsh takes a checkpoint before it
touches anything, executes, then verifies the result against the
requirements you set.

Without a `GEMINI_API_KEY`, every AI surface says so plainly. Nothing
fabricates a reply — that is the point.

---

## Path 2 — With real Gemini reasoning (+3 minutes)

Get a free key at <https://aistudio.google.com/apikey>, then:

```bash
cp .env.example .env
```

Put the key in `.env` as `GEMINI_API_KEY=...` and restart
`npm run dev`. `.env` is git-ignored.

> **Gotcha:** Node's `--env-file` does not override a variable already set
> in your shell. If you previously ran `setx GEMINI_API_KEY ...` (Windows)
> or exported it, that value still wins.

Now the same flow uses real Gemini for requirement interpretation,
planning and proposals.

---

## Path 3 — Real CAD (needs FreeCAD installed)

Install [FreeCAD](https://www.freecad.org/) 1.x. Naqsh auto-detects a
standard install; no configuration needed.

1. Open the **Environment** tab — FreeCAD should show as `connectable`
   with its real version and resolved path.
2. Under **Connect a FreeCAD document**, give it an absolute path to any
   existing `.FCStd` file.
3. Describe a part in chat, then `generate`, then approve.

Naqsh writes real geometry into that file. To see it, **close and reopen
the document in FreeCAD** — the GUI does not re-read a file changed
underneath it, and if a part looks invisible, select it in the tree and
press **Space**, then **View → Fit All**.

What it can build today: boxes, cylinders, tori, and tapered wedges;
positioned and rotated; combined with boolean cut/fuse; and rounded with
fillets. Every one of those is an explicit allowlist entry in
`packages/adapters/freecad/runner.py` — there is no arbitrary-execution
path into FreeCAD.

---

## Verifying the claims

```bash
npm run typecheck --workspaces
npm run test --workspaces
```

~2,685 tests. The FreeCAD integration suite runs against a real FreeCAD
install and **skips honestly** if one is not present, rather than passing
vacuously.

---

## What is deliberately not here

- **No hosted URL.** The differentiator is real local CAD.
- **No bundled API key.** Keys published in a submission get scraped and
  revoked, and a shared quota dies the moment two people use it. Path 1
  needs no key; Path 2 takes three minutes with your own.
- **No `delete` capability on FreeCAD.** Naqsh can create and modify, but
  never delete — see the capability list in the Environment tab.
