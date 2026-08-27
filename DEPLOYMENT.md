# Deployment

**Status: the pipeline is complete and reviewable. It has not been run.**

This document exists because it would be easy to quietly imply otherwise,
and the whole premise of this project is that a claim should come with
evidence. So, plainly:

Naqsh has a working two-service Cloud Run deployment path in this
repository. Nobody has executed it. Google Cloud requires a billing
account before Cloud Run can be enabled, and creating one places a
temporary **US$50 authorisation hold** on a payment card. The only card
available to this submission belongs to a family member, and placing a
hold on someone else's card without their knowledge is not something we
were willing to do for a hackathon deadline.

So there is no hosted URL. Everything below is real, committed code that
a reviewer can read and run themselves — it simply has not been billed to
anyone.

---

## What exists

| File | What it does |
|---|---|
| `apps/api/Dockerfile` | Bundles the API with esbuild, **installs FreeCAD** (`freecad-python3`, headless) so a hosted instance builds genuine geometry, and ships `runner.py` as data with `NAQSH_FREECAD_RUNNER` pointing at it |
| `apps/web/Dockerfile` | Builds the Vite bundle from the monorepo root, serves it with `serve --single` so client-side routes survive a refresh |
| `cloudbuild.yaml` | Deploys **both** services, in the order the dependency between them requires |

### The ordering is not arbitrary

Vite inlines `import.meta.env.VITE_API_BASE_URL` at **build** time, so the
web image cannot be built until the API has a real URL. The pipeline
therefore:

1. builds and deploys `naqsh-api`
2. reads back its live URL
3. builds `naqsh-web` against that URL
4. deploys `naqsh-web`
5. sets `NAQSH_ALLOWED_ORIGIN` on the API to the web origin — the server
   refuses to start in production without it rather than silently
   allowing `*`

The API is given 2Gi/2cpu because every FreeCAD call spawns a real
`freecadcmd` subprocess.

---

## Running it

With a billing-enabled project and `gcloud` authenticated:

```bash
gcloud services enable cloudbuild.googleapis.com run.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com

# Cloud Build needs permission to deploy to Cloud Run. Missing this is the
# usual cause of "build succeeded, deploy failed".
PROJECT_NUMBER=$(gcloud projects describe "$(gcloud config get-value project)" --format='value(projectNumber)')
gcloud projects add-iam-policy-binding "$(gcloud config get-value project)" \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/run.admin"
gcloud projects add-iam-policy-binding "$(gcloud config get-value project)" \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser"

# The key lives in Secret Manager, never in an image or in this repo.
gcloud secrets create gemini-api-key --replication-policy=automatic
printf '%s' "YOUR_GEMINI_API_KEY" | gcloud secrets versions add gemini-api-key --data-file=-

gcloud builds submit --config cloudbuild.yaml --substitutions=_REGION=us-central1

gcloud run services update naqsh-api --region us-central1 \
  --update-secrets GEMINI_API_KEY=gemini-api-key:latest
```

The last pipeline step prints the live URL.

---

## What is verified, and what is not

**Verified:**

- Both Dockerfiles are syntactically valid and their build contexts are
  correct (each copies every sibling workspace package it imports).
- The `NAQSH_FREECAD_RUNNER` indirection is real and tested. Without it
  the bundled API would resolve `runner.py` to a path that does not exist
  inside the image, and **every FreeCAD call in production would fail** —
  found by reading the resolution path, not by deploying and watching it
  break. See `freecad-adapter.test.ts`.
- The download endpoint works end to end against a real FreeCAD document:
  correct headers, and the returned bytes open as a valid `.FCStd`.

**Not verified — stated so no one assumes otherwise:**

- **The FreeCAD container image has never finished building.** A local
  build was abandoned after 47 minutes at 152 of ~460MB. That was this
  machine's network rather than anything about the approach, but the fact
  remains: it is unproven.
- **Debian bookworm ships FreeCAD 0.20.2**, not the 1.1.x this project is
  developed against. Every TypeId the adapter uses (`Part::Box`,
  `Part::Cylinder`, `Part::Torus`, `Part::Wedge`), plus `Placement`, the
  boolean features and `Part::Fillet`, exist in 0.20 — so it *should*
  work. It has not been demonstrated. The first thing to check on a live
  deployment is whether the Environment tab reports FreeCAD as
  `connectable`.

---

## Running it locally instead

See **[JUDGES.md](JUDGES.md)**. It takes two minutes and needs no API key
and no cloud account, because the deterministic model provider runs the
entire requirements → plan → proposal → approval → execute → verify loop
offline.

And for what it's worth: local is where Naqsh is *most* itself. Driving a
real FreeCAD document through a headless subprocess boundary is the point
of the project, and that only ever happens on a machine with FreeCAD on
it.
