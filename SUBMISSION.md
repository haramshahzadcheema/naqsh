# Naqsh — Submission Kit (All Things Agentic Hackathon)

Everything needed to go from this repository to a submitted entry. The code is done;
this file is the checklist, the Devpost text, and the shot-by-shot video script.

---

## 1. Pre-submission checklist (in order — each step depends on the one before)

### Step 1 — No hosted URL (see DEPLOYMENT.md)

Naqsh's differentiator is that it drives a **real FreeCAD document** through a
headless subprocess boundary. That only works on a machine with FreeCAD installed,
so a hosted URL would demo the weaker half of the product. Judges run it locally.

`JUDGES.md` is the entry point and offers three paths by setup cost:

1. **No credentials at all** — `npm install && npm run dev`, then pick the
   **Deterministic (testing)** model. A real scripted provider that runs the whole
   requirements → plan → proposal → approval → execute → verify loop offline.
2. **Own free Gemini key** — `cp .env.example .env`, three minutes.
3. **Real FreeCAD** — the actual differentiator.

No API key ships with the submission. A key published in a submission gets scraped
and revoked, and a shared free-tier quota dies the moment two judges use it at once.
Path 1 removes the need for one entirely.

> The repo contains a COMPLETE two-service Cloud Run pipeline — `apps/api/Dockerfile`
> (with FreeCAD installed, so a hosted instance builds real geometry),
> `apps/web/Dockerfile`, and a `cloudbuild.yaml` that deploys both and wires CORS
> between them. It has never been run: Cloud Run needs a billing account, and
> creating one places a temporary US$50 authorisation hold on a payment card. The
> only card available belongs to a family member, and we were not willing to place a
> hold on someone else's card for a deadline. `DEPLOYMENT.md` states this plainly,
> along with exactly what is and is not verified.

### Step 2 — One live Gemini rehearsal BEFORE recording (~10 min)

Locally, with the key set (`GEMINI_API_KEY=... npm run dev`), run one full session:
create a project → state a requirement → "make the bracket lighter" → approve →
verify. This is the only seam of the system never yet exercised against the live
API — do not discover a surprise on camera.

### Step 3 — FreeCAD on the recording machine

Install FreeCAD (freecad.org), confirm `freecadcmd` resolves (or set
`NAQSH_FREECAD_CMD`), open a document, and connect it from Naqsh's Environment tab.
If FreeCAD is genuinely unavailable, record with `mock_cad` and SAY SO on camera —
the app labels it honestly and so should the narration.

### Step 4 — Record the video (script in §3)

**Done:** https://www.youtube.com/watch?v=uQXj_l76ppc

### Step 5 — Devpost form

- Track: **The Collaborative Partner**
- Paste the description from §2
- Hosted URL: none — say plainly that Naqsh runs locally because it drives real CAD (see `JUDGES.md`)
- Repo: https://github.com/haramshahzadcheema/naqsh — grant access to
  **testing@devpost.com** and **cloudhackathons@google.com**
- Upload the video; add the FreeCAD screenshots (real geometry Naqsh built) to the gallery
- Attach the architecture diagram (required field)

---

## 2. Devpost description (paste-ready draft)

> **Naqsh — an engineering copilot that proves its work.**
>
> AI assistants will happily tell you they fixed your design. Naqsh is built on the
> opposite premise: **no claim without evidence**. It converses with an engineer,
> captures requirements as structured state, generates plans and concrete change
> proposals with **Gemini 3.5 Flash**, and then — only after explicit human
> approval — executes the change against a real CAD environment (a live FreeCAD
> document, driven through a locked-down subprocess boundary) and **re-verifies the
> result with deterministic code**, never by asking the model whether it worked.
>
> **The loop:** observe → plan → propose → human approval → authorized tool
> execution → before/after discrepancy detection → deterministic verification →
> long-term memory that measurably changes future reasoning. Every stage is real,
> persisted, and covered by 2,685 tests. Approval cannot be bypassed: mutating
> tools pass through a single authorization choke point that validates input
> schema, checks a real approval store (replay-protected), and only then invokes
> the tool. If Gemini is unconfigured, every AI surface says so honestly — nothing
> in Naqsh fabricates success.
>
> **Google technologies:** Gemini 3.5 Flash via the **GenAI SDK** (structured
> output for plans/proposals/designs, streaming chat, and **multimodal viewport
> analysis** — Naqsh captures the actual CAD window and has Gemini reason about
> the geometry it sees). Runs locally by design — the FreeCAD subprocess boundary
> is the point, and it needs FreeCAD on the machine (a Cloud Run pipeline ships in
> the repo for the mock environments).
> The agent loop is deliberately hand-rolled on the SDK rather than a framework:
> in a system whose whole thesis is verifiable authorization, the approval
> boundary must be first-party code we can test line by line — and it is.
>
> **Why it's different:** most agents act. Naqsh is one of the few that can show
> you, with a deterministic check and a structural before/after diff, that what it
> said happened actually happened — and that refuses, visibly and honestly, when
> it isn't allowed to act.

---

## 3. Four-minute video script (shot-by-shot)

**Setup before recording:** clean data dir, Gemini key set (and quota checked —
the free tier 429s quickly), FreeCAD installed and a document connected, browser at
the app, FreeCAD window ready to bring forward, terminal visible for one moment.

| Time | Screen | Say |
|---|---|---|
| 0:00–0:20 | Title card → chat, empty project | "Every AI assistant will tell you it fixed your design. Almost none can prove it. Naqsh is an engineering copilot built on one rule: no claim without evidence." |
| 0:20–1:00 | Type a real brief: "I need a mounting bracket that holds a 2 kg camera, aluminum, 100×60×20 mm envelope." Show the Requirements tab filling with structured entries; answer one clarifying question | "Naqsh doesn't chat about requirements — it captures them as structured, versioned state. Notice it asked a clarifying question instead of guessing." |
| 1:00–1:50 | Type: "Make the bracket lighter." Real Gemini Plan card renders, then Proposal card naming the exact tool + target object | "Natural engineering language — no magic phrases. Gemini 3.5 generates a plan, then a single concrete proposal: which tool, which object, what change. Nothing has executed yet." |
| 1:50–2:10 | **The refusal beat.** Attempt execute WITHOUT approving (or show a second mutating action being denied) — honest failure banner | "And it can't execute. Mutating tools pass one authorization gate; without my approval the tool call is denied and the failure is shown honestly. This is enforced in code, not in a prompt." |
| 2:10–2:50 | **The moment.** Click Approve. FreeCAD window visible beside the browser: geometry actually changes. Verification panel: deterministic check → PASS; consistency check line | "I approve — and the real FreeCAD document changes. Then Naqsh re-observes, diffs before and after, and runs a deterministic numeric check. That PASS came from comparison code, not from the model's opinion of itself." |
| 2:50–3:15 | Environment tab → Live View → capture frame → Gemini's analysis of the actual viewport | "Gemini's multimodality earns its place: Naqsh captures the live CAD viewport and Gemini reasons about the geometry it can actually see." |
| 3:15–3:40 | Kill the server in the terminal; restart; refresh — project, memory, history all intact. Ask a follow-up; reply visibly references the earlier decision | "Restart the server — nothing is lost, and memory isn't decoration: it re-enters Gemini's context and changes future answers." |
| 3:40–4:00 | Terminal: `npm run test --workspaces` scrolling green → back to app | "2,685 tests. The FreeCAD suite runs against a real install and skips honestly when there isn't one — it never passes vacuously. Naqsh: the engineering copilot that proves its work." |

**Risk notes:** rehearse the full path twice; keep the deterministic model as an
on-camera fallback ONLY with narration ("this is the offline test model — here's
the same flow on Gemini" + cut); never present mock_cad as FreeCAD.
