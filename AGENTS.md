# vayada — agent guide

Hospitality platform with three products — **Creator Marketplace**, **Booking Engine**, and **PMS** — sharing a central auth DB. This repo is the product application monorepo: app code lives under `apps/`, shared code belongs under `packages/`, and root tooling owns cross-app workflow, docs, Docker Compose, scripts, and auth DB setup.

This file is the **canonical, tool-neutral agent guide**. Claude Code, Codex, and any other agent should read this first. `README.md` covers architecture, ports, DBs, test accounts, and seeding in depth — this file covers what those references don't: how to actually do work in the repo.

`CLAUDE.md` is a thin Claude-specific wrapper that defers to this file; it only adds notes that are specific to Claude Code's runtime.

## App map

| Path                       | Stack      | Port | Local URL                           |
| -------------------------- | ---------- | ---- | ----------------------------------- |
| `apps/api`                 | Node/TS    | 8003 | `https://api.localhost`             |
| `apps/marketplace-api`     | FastAPI    | 8000 | `https://api.marketplace.localhost` |
| `apps/marketplace-web`     | Next.js 14 | 3000 | `https://marketplace.localhost`     |
| `apps/vayada-admin`        | Next.js 14 | 3001 | `https://admin.localhost`           |
| `apps/booking-api`         | FastAPI    | 8001 | `https://api.booking.localhost`     |
| `apps/booking-web`         | Next.js 14 | 3002 | `https://booking.localhost`         |
| `apps/booking-admin`       | Next.js 14 | 3003 | `https://admin.booking.localhost`   |
| `apps/pms-api`             | FastAPI    | 8002 | `https://api.pms.localhost`         |
| `apps/pms-web`             | Next.js 14 | 3004 | `https://pms.localhost`             |
| `apps/landing`             | Next.js 14 | 3006 | `https://landing.localhost`         |

Local URLs are the recommended way to reach each app — see [Local dev — portless](#local-dev--portless). Plain `localhost:PORT` still works for contributors not on portless.

`apps/landing` is the **public marketing/landing site**, split out of `apps/marketplace-web`. The marketplace frontend is the authenticated app only; its `/` redirects to `/login`. The marketing pages (home, `/booking-engine`, `/pms`, `/hotel-creator-network`, `/partner-program`, `/pricing`, about/contact/benefits, legal) live in `apps/landing`; `/hotel-creator-network` there fetches live creators/hotels from the marketplace API cross-origin. The public chrome (`Navigation` / `Footer` / `LandingFooter`) is intentionally duplicated in both apps because app pages (`/hotels/[id]`, `/creators`, `/properties`) still use it. `vayada.com` is the shared public landing surface and is served by the `vayada-landing` App Runner service; the authenticated app and APIs remain on their separate hostnames.

## Local dev — portless

[portless](https://portless.sh) maps every app to a stable HTTPS URL on `*.localhost` (column 4 of the App map above). No port numbers to remember, no per-worktree port collisions, and frontends reach their backends via the same named URLs whether you're in the main tree or a worktree. **`npm run dev:workos-local` is the current local workflow for AuthKit and next-stack work.** Plain `localhost:PORT` still works — see [Plain-port fallback](#plain-port-fallback) below.

### One-time setup

```bash
nvm use                                # picks Node 24 from .nvmrc (use fnm/asdf if you prefer)
npm install -g portless                # requires Node 24+
./scripts/portless-setup.sh            # trusts local CA (sudo) + registers the FastAPI aliases
```

`portless trust` adds the local CA to your system trust store so browsers don't show TLS warnings (may prompt for sudo on first run). The proxy then binds **port 443** and requires sudo to do so — accept the prompt when launching an app for the first time. If you skip sudo, portless falls back to **port 1355** and all URLs become `https://<name>.localhost:1355`; functional but loses the "clean URL" payoff. The checked-in frontend defaults assume port 443, so when you are on the 1355 fallback you must override API URLs with the explicit port, e.g. `NEXT_PUBLIC_API_URL=https://api.marketplace.localhost:1355`. To recover, stop the proxy and re-run `portless proxy start` accepting the sudo prompt, or install the proxy as a launch-time service: `portless service install`.

### Running apps

| What                                  | Command                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| Start AuthKit / next-stack local dev  | `npm run dev:workos-local` or `npm run dev:portless`                             |
| Start transitional legacy local stack | `./scripts/dev-portless.sh --legacy`                                             |
| Start one Next.js app                 | `cd apps/<name> && portless`                                                     |
| Start `apps/api`                      | `cd apps/api && npm run dev`                                                     |
| Start a FastAPI backend               | `cd apps/<api> && uvicorn app.main:app --reload --port <P>` (P from the App map) |

The Next.js apps and `apps/api` register their portless names via a `"portless"` key in `apps/<name>/package.json`. The FastAPI apps run on their existing uvicorn ports (8000 / 8001 / 8002) and are reached at `https://api.<product>.localhost` thanks to the static aliases registered by `scripts/portless-setup.sh`.

`npm run dev:workos-local` requires `apps/api/.env` with local WorkOS settings and wires AuthKit/target frontend calls to `https://api.localhost`. `npm run dev:portless` delegates to that AuthKit-capable workflow so signup/login routes work by default. Use `./scripts/dev-portless.sh --legacy` only for the old FastAPI-backed surfaces without WorkOS/AuthKit env wiring.

### Worktrees

`git worktree add /tmp/vayada-<branch> <branch>` then `cd /tmp/vayada-<branch>/apps/<name> && portless` automatically prefixes the worktree as a subdomain: `https://<branch>.<name>.localhost`. Worktrees on different branches don't collide.

For Flamur's side-by-side local review deployments, do not use worktree- or
role-prefixed hostnames such as `creator.*.localhost` or `hotel.*.localhost`.
Always deploy through portless; do not expose review deployments as plain
`http://localhost:<app-port>` URLs. Keep the canonical portless hostname and
isolate each checkout with its own state directory and nearby proxy port:

```bash
# Run from checkout A
PORTLESS_STATE_DIR=/tmp/vayada-review-1355 PORTLESS_PORT=1355 npm run dev:workos-local

# Run from checkout B
PORTLESS_STATE_DIR=/tmp/vayada-review-1356 PORTLESS_PORT=1356 npm run dev:workos-local
```

These commands start independent proxies and produce matching app and API URLs,
for example `https://marketplace.localhost:1355` with
`https://api.localhost:1355`, and the same pair on `:1356`. Do not attach either
checkout to the default proxy. `dev:workos-local` derives browser origins,
OAuth callback URLs, and `AUTH_ALLOWED_ORIGINS` from that checkout's suffixed
URLs; preserve the suffix on any manual overrides too. This avoids Next.js
development-origin hydration failures, keeps OAuth callbacks consistent, and
makes comparison links predictable.

### Multi-tenant subdomains (booking-web)

`booking-web` extracts the hotel slug from the hostname (`<slug>.booking.localhost` → that hotel's booking page). portless does not forward arbitrary subdomains in its default proxy mode, but v0.13 supports this with the proxy-level `--wildcard` flag. Verified with curl: after `portless proxy start --wildcard`, both `https://booking.localhost` and `https://acme.booking.localhost` route to the same `booking` app/alias.

If you are testing booking tenants, start the proxy with wildcard enabled before launching booking-web:

```bash
portless proxy stop
portless proxy start --wildcard
cd apps/booking-web && portless
```

Plain-port fallback still works: `cd apps/booking-web && npm run dev` and reach the tenant at `http://<slug>.localhost:3002` (the pre-portless path; booking-web's middleware reads `Host` regardless of port).

### Plain-port fallback

Without portless, `npm run dev` in each Next.js app binds to its conventional port (3000-3006), `apps/api` binds to 8003, and uvicorn binds to 8000/8001/8002 as before. To make the frontends talk to plain-port backends, override the API URLs in `apps/<name>/.env.local` — each `apps/*/.env.example` lists the plain-port URL alongside the portless default.

### Pre-1.0 caveat

portless is pre-1.0 (currently 0.13.x). Upgrades occasionally change the state-dir format; if `portless list` shows nothing or HTTPS suddenly fails, re-run `portless trust` and `./scripts/portless-setup.sh`.

## Per-stack commands

**TypeScript backend** (`apps/api`):

```bash
cd apps/api
npm install
npm run dev      # port 8003; portless URL https://api.localhost
npm run build
npm run typecheck
npm run test
```

**FastAPI backends** (Python 3.11):

```bash
cd apps/<api>
pip install -r requirements.txt
python -m pytest                         # pytest.ini at app root; tests/ dir
uvicorn app.main:app --reload --port <P> # P = port from table above
```

**Next.js frontends**:

```bash
cd apps/<web>
npm install
npm run dev      # plain-port (3000–3006); use `portless` for HTTPS named URL — see Local dev
npm run build    # always run before declaring a frontend change done
npm run lint
```

Root npm workspace commands:

```bash
npm run dev:booking-web
npm run dev:workos-local
npm run dev:portless
npm run build:booking-web
npm run lint:booking-web
npm run build       # all workspaces with build scripts
npm run lint        # all workspaces with lint scripts
npm run typecheck   # all workspaces with typecheck scripts
```

The repo uses **npm workspaces** because the imported apps already use npm `package-lock.json` files. Do not introduce pnpm/Yarn or rewrite lockfiles without a dedicated migration issue.

## Validation expectations

Before claiming a change is complete:

- **Backend (FastAPI)** — run `python -m pytest` in the affected app. `ruff check <changed-paths>` for new code.
- **Frontend (Next.js)** — run `npm run build` (and `npm run lint` if the change is non-trivial). The dev server is not enough — Next builds catch type/import errors the dev server misses.
- **Cross-app or workspace changes** — also run root `npm run build` / `npm run typecheck` to confirm no workspace consumer broke.
- **UI changes** — start the dev server and exercise the feature in a browser before declaring it done. Type checks and tests verify code correctness, not feature correctness. When the changed surface is covered by the Playwright pilot, run the focused smoke command too (see table below); use `E2E_START_SERVERS=1` if you want Playwright to start plain-port dev servers for the pilot apps.

**Playwright surface-to-command mapping:**

| Surface                    | Command                           | portless URL                                |
| -------------------------- | --------------------------------- | ------------------------------------------- |
| `apps/landing`             | `npm run e2e:landing`             | `https://landing.localhost`                 |
| `apps/booking-web`         | `npm run e2e:booking-web`         | `https://hotel-alpenrose.booking.localhost` |
| `apps/booking-admin`       | `npm run e2e:booking-admin`       | `https://admin.booking.localhost`           |
| `apps/marketplace-web`     | `npm run e2e:marketplace-web`     | `https://marketplace.localhost`             |
| `apps/pms-web`             | `npm run e2e:pms-web`             | `https://pms.localhost`                     |
| `apps/vayada-admin`        | `npm run e2e:vayada-admin`        | `https://admin.localhost`                   |

`npm run e2e` runs all of the above. URL overrides and debugging are documented in `tests/e2e/README.md`.

Playwright is currently a **pilot smoke layer**, not a replacement for build, lint, typecheck, or pytest. Local Playwright defaults target portless URLs and tolerate local HTTPS certificates; plain-port overrides are documented in `tests/e2e/README.md`. Agents should say which browser flow they actually exercised — starting a server alone is not enough.

Formatting (Prettier for JS/TS/MD/YAML/CSS, Ruff for Python) is wired up but **not enforced** across the existing codebase yet. Touched files should be clean; pre-existing drift is acceptable. Full operating model: [`engineering/code-quality-gates.md`](engineering/code-quality-gates.md).

If a check cannot be run locally (env, secrets, infra), say so explicitly rather than claiming success.

## Complexity guardrail — Ponytail

Ponytail comes from the installed plugin; its hooks and skills own the detailed rules. In this repo, treat it as a **complexity-control layer**, not as the top-level workflow or a replacement for verification.

- Keep implementation changes small and scoped to the ticket.
- Before adversarial review or PR finalization, run `/ponytail-review` (or a manual complexity pass if the plugin is unavailable), fix valid simplifications, then rerun affected checks.
- Do not use Ponytail to remove acceptance criteria, trust-boundary validation, security measures, accessibility basics, data-loss prevention, required tests, browser checks, migrations safety, or adversarial review.

## Shipping conventions

- **Protected `main`, PR-based workflow.** Do not commit directly to `main` for implementation work.
- For each Linear implementation issue, create a branch linked to the issue, commit with a descriptive message, push the branch, and open a GitHub PR.
- For large architecture or rewrite work, use stacked PRs. Keep each PR focused and around 400 changed non-generated lines or fewer unless the ticket explicitly justifies a larger slice.
- For TypeScript backend rewrite, WorkOS, Ask Intelligence, target-schema, migration, or cutover work, load `.agents/skills/typescript-rewrite-workflow/SKILL.md` before coding. Architecture/design contracts must be written or linked before implementation PRs.
- Run the complexity and adversarial review passes described above before PR finalization.
- For shared packages, cross-domain architecture, auth, tenant boundaries, booking, payment, availability, or PMS workflows: explicitly use an independent subagent adversarial review before opening or finalizing the PR. Do not count a local self-review as satisfying this requirement.
- PR descriptions should include the Linear issue ID, summary, validation, and risk notes.
- CodeRabbit is expected to review every non-draft PR; address or explicitly resolve its findings before merge.
- Merge with squash merge after required checks pass.
- Do not reintroduce app submodules or submodule pointer commits.

## Linear workflow

For this repository, Linear work defaults to the Vayada workspace. Agents should use
the `linear_vayada` MCP server for all `VAY-*` issue lookups, comments, updates, and
issue creation unless the user explicitly names another workspace.

- Ticket → **In Progress** when implementation starts (via the `linear` MCP).
- Ticket stays **In Progress** when the agent finishes implementation, pushes the branch, and opens the PR.
- Ticket → **Done** only after the human merges the PR, smoke tests the shipped change, and confirms no required follow-up remains.
- Shipping/merging does **not** auto-transition any status. Move to `Done` because the merged work has been smoke tested and accepted, not just because code landed in `main`.
- If QA later finds an issue, the human reopens the ticket (back to `In Progress`) or opens a follow-up.

Task-specific scope and acceptance criteria live in the Linear issue itself — read it before starting.

Full operating model (projects, labels, statuses, priorities, issue quality, agent rules) is in [`engineering/linear-workspace.md`](engineering/linear-workspace.md). Read that before creating issues or restructuring tickets.

## Deployment

Production runs on AWS ECS Fargate and App Runner, fronted by an ALB where
applicable. The legacy Python APIs and parallel `next-*` stack deploy through
GitHub Actions under `.github/workflows/`. Canonical frontend builds are frozen
on the legacy APIs and intentionally have no active deploy workflow; restoring
their delivery requires explicit rollback-compatibility or cutover work.

- **PMS migrations** auto-run on ECS container start. Do not suggest manually running `scripts/run_migration.sh` after a push to `main`.
- **auth-db** does **not** auto-migrate in production — run `scripts/run_migration.sh auth` against RDS for any schema change. Locally, the `auth-db-migrate` one-shot service in `docker-compose.yml` runs migrations on `docker compose up`.
- Infrastructure is managed with Terraform in the [`vayada-platform`](https://github.com/vayada-marketplace/vayada-platform) repository. This repo contains no infrastructure code.

## Skills

Shared agent skills live under `.agents/skills/<name>/SKILL.md`. The directory is intentionally tool-neutral; Codex, Claude Code, and any other agent should read the same shared skill content instead of maintaining per-tool copies.

Start with `.agents/skills/vayada-skills-storage/SKILL.md` to understand the three-layer model (shared skill / repo-local instructions / Linear issue) and where new skills should go.

Use `.agents/skills/typescript-rewrite-workflow/SKILL.md` for the TypeScript backend rewrite and adjacent WorkOS, Ask Intelligence, target-schema, migration, and cutover work.

## Gotchas

- **SMTP** — port 587 SES uses `start_tls=True`, **not** `use_tls=True`. Recurring regression — check on any email/SMTP change.
- **Booking Engine guest copy** — guest-facing direct-booking pages and emails speak as the property in first person (`we` / `our` / `us`). Do not refer to the property as `the host`, `the hotel`, or `the property` when it is reviewing, accepting, declining, confirming, or verifying a guest booking/payment/change.
- **PMS migrations auto-run** on ECS container start. After a push to `main`, do **not** suggest manually running `scripts/run_migration.sh`.
- **auth-db** does **not** auto-migrate **in production** (unlike PMS). Locally, `docker compose up` runs auth migrations via the `auth-db-migrate` one-shot service. For prod schema changes, run `scripts/run_migration.sh auth` against RDS.
- **`vw` worktree helper is gone.** Ticket work uses normal git branches and direct-to-main commits — no worktree scripts, no shipping helpers.
