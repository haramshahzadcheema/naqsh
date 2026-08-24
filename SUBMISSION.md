# Naqsh — Submission Kit (All Things Agentic Hackathon)

Everything needed to go from this repository to a submitted entry. The code is done;
this file is the checklist, the Devpost text, and the shot-by-shot video script.

---

## 1. Pre-submission checklist (in order — each step depends on the one before)

### Step 1 — Deploy to Google Cloud Run (~15 min)

Requires: a GCP project with billing enabled (the hackathon's $150 credit form is on
the Devpost Resources tab), `gcloud` CLI authenticated.

```bash
# One-time: store the Gemini key as a secret (never in the image or repo)
gcloud secrets create gemini-api-key --replication-policy=automatic
printf '%s' "YOUR_GEMINI_API_KEY" | gcloud secrets versions add gemini-api-key --data-file=-

# Build + push + deploy (cloudbuild.yaml handles Artifact Registry bootstrap itself)
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_REGION=us-central1,_SERVICE=naqsh-api

# Attach runtime config (the server REFUSES to start in production without the origin)
gcloud run services update naqsh-api --region us-central1 \
  --set-env-vars NAQSH_ALLOWED_ORIGIN=https://YOUR-FRONTEND-ORIGIN \
  --update-secrets GEMINI_API_KEY=gemini-api-key:latest
```

Verify, and screenshot both for the video/README:

```bash
curl https://YOUR-CLOUD-RUN-URL/health
# expect: {"status":"ok","geminiConfigured":true}
```

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

### Step 5 — Devpost form

- Track: **The Collaborative Partner**
- Paste the description from §2
- Hosted URL: the Cloud Run URL
- Repo: https://github.com/haramshahzadcheema/naqsh — grant access to
  **testing@devpost.com** and **cloudhackathons@google.com**
- Upload the video; add the Cloud Run console screenshot to the gallery

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
> persisted, and covered by 2,500+ tests. Approval cannot be bypassed: mutating
> tools pass through a single authorization choke point that validates input
> schema, checks a real approval store (replay-protected), and only then invokes
> the tool. If Gemini is unconfigured, every AI surface says so honestly — nothing
> in Naqsh fabricates success.
>
> **Google technologies:** Gemini 3.5 Flash via the **GenAI SDK** (structured
> output for plans/proposals/designs, streaming chat, and **multimodal viewport
> analysis** — Naqsh captures the actual CAD window and has Gemini reason about
> the geometry it sees). Deployed on **Cloud Run** (Cloud Build pipeline in-repo).
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

**Setup before recording:** clean data dir, Gemini key set, FreeCAD connected,
browser at the app, Cloud Run console tab open, terminal visible for one moment.

| Time | Screen | Say |
|---|---|---|
| 0:00–0:20 | Title card → chat, empty project | "Every AI assistant will tell you it fixed your design. Almost none can prove it. Naqsh is an engineering copilot built on one rule: no claim without evidence." |
| 0:20–1:00 | Type a real brief: "I need a mounting bracket that holds a 2 kg camera, aluminum, 100×60×20 mm envelope." Show the Requirements tab filling with structured entries; answer one clarifying question | "Naqsh doesn't chat about requirements — it captures them as structured, versioned state. Notice it asked a clarifying question instead of guessing." |
| 1:00–1:50 | Type: "Make the bracket lighter." Real Gemini Plan card renders, then Proposal card naming the exact tool + target object | "Natural engineering language — no magic phrases. Gemini 3.5 generates a plan, then a single concrete proposal: which tool, which object, what change. Nothing has executed yet." |
| 1:50–2:10 | **The refusal beat.** Attempt execute WITHOUT approving (or show a second mutating action being denied) — honest failure banner | "And it can't execute. Mutating tools pass one authorization gate; without my approval the tool call is denied and the failure is shown honestly. This is enforced in code, not in a prompt." |
| 2:10–2:50 | **The moment.** Click Approve. FreeCAD window visible beside the browser: geometry actually changes. Verification panel: deterministic check → PASS; consistency check line | "I approve — and the real FreeCAD document changes. Then Naqsh re-observes, diffs before and after, and runs a deterministic numeric check. That PASS came from comparison code, not from the model's opinion of itself." |
| 2:50–3:15 | Environment tab → Live View → capture frame → Gemini's analysis of the actual viewport | "Gemini's multimodality earns its place: Naqsh captures the live CAD viewport and Gemini reasons about the geometry it can actually see." |
| 3:15–3:40 | Kill the server in the terminal; restart; refresh — project, memory, history all intact. Ask a follow-up; reply visibly references the earlier decision | "Restart the server — nothing is lost, and memory isn't decoration: it re-enters Gemini's context and changes future answers." |
| 3:40–4:00 | Cloud Run console + `curl /health` on the live URL → back to app | "Running on Cloud Run, built by the Cloud Build pipeline in the repo, 2,500 tests green. Naqsh: the engineering copilot that proves its work." |

**Risk notes:** rehearse the full path twice; keep the deterministic model as an
on-camera fallback ONLY with narration ("this is the offline test model — here's
the same flow on Gemini" + cut); never present mock_cad as FreeCAD.
