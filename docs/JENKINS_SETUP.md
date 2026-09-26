# Jenkins setup (Sukruti, Phase 2 Step 3)

The `Jenkinsfile` at the repo root defines *what* runs. This document covers
the one-time Jenkins server config for *how it gets triggered* — this part
lives in the Jenkins UI/config, not in this repo, so it can't be a script
you run against the repo the way the merge and test steps can.

## 1. Plugins

Install (Manage Jenkins → Plugins) if not already present:
- **GitHub Branch Source** — auto-discovers branches/PRs from this repo
- **Pipeline** (usually bundled) — runs the `Jenkinsfile`
- **NodeJS Plugin** — pins a Node version for `npm ci` / `tsc` / `mocha`
- **JUnit Plugin** (usually bundled) — renders the `junit` step's results
- **Credentials Binding Plugin** (usually bundled) — for the PAT in the
  Package stage

## 2. NodeJS tool

Manage Jenkins → Tools → NodeJS installations → Add NodeJS:
- Name: `node20` (must match `tools { nodejs 'node20' }` in the Jenkinsfile)
- Version: Node 20.x (matches `Dockerfile`'s `node:20-bookworm`)

## 3. Credential for the Package stage

Manage Jenkins → Credentials → (System or a folder scope) → Add Credentials:
- Kind: **Secret text**
- Secret: your VS Code Marketplace Personal Access Token
- ID: `vsce-marketplace-pat` (must match the Jenkinsfile's `credentialsId`)

This is only needed once you actually want the Package stage to run for
real — per the roadmap's demo checklist, `.vsix` packaging isn't required
to demo the project, so it's fine to leave this unconfigured. The stage
is also gated to `branch 'main'`, so PR builds never need it.

## 4. Multibranch Pipeline job

New Item → **Multibranch Pipeline**:
- Branch Source: **GitHub**
  - Credentials: a GitHub token/app with read access to this repo
  - Repository: `sukrutimogili/kairos`
  - Behaviors: default (discover branches + discover PRs from origin)
- Build Configuration: Mode **by Jenkinsfile**, path `Jenkinsfile` (default)
- Scan Multibranch Pipeline Triggers: enable **"Scan by webhook"** if you
  set up a GitHub webhook (Settings → Webhooks → payload URL
  `<jenkins-url>/github-webhook/`, content type `application/json`), or a
  periodic scan interval (e.g. every 5 minutes) if you're demoing without
  exposing Jenkins publicly — webhook-triggered is the "no polling" version
  the roadmap calls for, but a periodic scan is a reasonable fallback for a
  local/demo Jenkins that isn't reachable from GitHub.

Once created, Jenkins scans the repo, finds `main` and every
`feature/*`/`integration/*` branch with a `Jenkinsfile`, and creates a job
per branch automatically — no per-branch job setup needed going forward.

## 5. First run

Click into the `main` (or `integration/phase2`) branch job → **Build Now**.
Checkout, Analyzer Tests, Extension Compile, and Extension Tests should all
go green without any credentials configured; only the Package stage (main
only) needs the PAT from step 3.
