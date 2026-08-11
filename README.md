# vayada

Vayada is a hospitality platform with three connected products:

- **Creator Marketplace** — connects hotels with travel creators.
- **Booking Engine** — powers direct, branded guest bookings.
- **Property Management System (PMS)** — manages hotel operations, inventory,
  reservations, and channel connectivity.

This repository is the product application monorepo. It contains every web app,
the target TypeScript API, the legacy FastAPI services still used during
migration, shared packages, database migration tooling, and local development
support.

## Architecture

Vayada is in a staged backend and identity migration. The repository
intentionally contains both backend generations; it is not currently a set of
fully isolated product microservices.

```mermaid
flowchart LR
  WEB["Seven Next.js applications"] --> API["apps/api<br/>TypeScript + Fastify"]
  WEB --> LEGACY["Legacy FastAPI APIs"]
  API --> TARGET["Target PostgreSQL<br/>domain schemas"]
  LEGACY --> DBS["Legacy product and auth<br/>PostgreSQL databases"]
  API --> WORKOS["WorkOS / AuthKit"]
  API --> MEDIA["S3-compatible media"]
  LEGACY --> MEDIA
```

| Layer               | Current role                                                                                                                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web applications    | Seven Next.js apps serve the marketplace, platform admin, booking storefront/admin, PMS, affiliate dashboard, and public landing site.                                                                                             |
| Target API          | `apps/api` is the modular TypeScript/Fastify backend for WorkOS/AuthKit, identity and authorization, migrated product routes, platform media, jobs, and target-domain APIs.                                                        |
| Legacy APIs         | `apps/marketplace-api`, `apps/booking-api`, and `apps/pms-api` remain in service while routes and data move to the target backend.                                                                                                 |
| Target data model   | `packages/backend-migration` owns reviewed SQL migrations and parity tooling for the schema-organized target PostgreSQL database. Runtime source flags select target, compatibility, or disabled implementations during migration. |
| Local support stack | Docker Compose starts the historical PostgreSQL databases, auth migrations, MinIO/media services, and the FastAPI APIs. `apps/api` and the web apps run from the npm workspace.                                                    |

The main design and migration references are:

- [Target TypeScript backend structure](engineering/typescript-backend-structure.md)
- [API contract ownership](engineering/api-contract-ownership.md)
- [Target schema ownership](engineering/target-schema-ownership-map.md)
- [Current next-stack legacy dependency inventory](engineering/next-stack-legacy-dependency-inventory.md)
- [Backend migration tooling](packages/backend-migration/README.md)

## Repository layout

| Path                                      | Purpose                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| [`apps/`](apps)                           | Deployable APIs and web applications                                   |
| [`packages/`](packages)                   | Shared TypeScript backend, domain, adapter, migration, and UI packages |
| [`auth-db/`](auth-db)                     | Shared legacy-auth migrations and migration runner                     |
| [`engineering/`](engineering)             | Architecture decisions, contracts, inventories, and runbooks           |
| [`scripts/`](scripts)                     | Local development, seeding, migration, and repository checks           |
| [`tests/e2e/`](tests/e2e)                 | Playwright browser smoke tests                                         |
| [`.github/workflows/`](.github/workflows) | CI and application delivery workflows                                  |

## Technology

| Layer                 | Current stack                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| Target API            | Node.js 24+, TypeScript, Fastify 5, `pg`, Kysely, WorkOS                                                    |
| Web applications      | Next.js 16 App Router, React 18, TypeScript, Tailwind CSS                                                   |
| Legacy APIs           | Python 3.11, FastAPI, AsyncPG                                                                               |
| Data and media        | PostgreSQL 15, AWS S3-compatible storage, MinIO and nginx locally                                           |
| Identity              | WorkOS/AuthKit provider identity with Vayada-owned authorization; legacy JWT compatibility during migration |
| Payments and channels | Stripe, Xendit, and Channex                                                                                 |
| Verification          | Vitest, pytest, ESLint, Ruff, and Playwright                                                                |

Exact dependency versions live in the root and app package manifests,
requirements files, and Dockerfiles.

## Applications and local endpoints

[portless](https://portless.sh) is the recommended local interface. It normally
exposes HTTPS on port 443; the plain ports remain available when running
processes directly.

| Path                                                   | Role                          | Runtime | Portless URL                                | Plain port |
| ------------------------------------------------------ | ----------------------------- | ------- | ------------------------------------------- | ---------: |
| [`apps/api`](apps/api)                                 | Target cross-product API      | Fastify | `https://api.localhost`                     |       8003 |
| [`apps/marketplace-api`](apps/marketplace-api)         | Legacy Marketplace API        | FastAPI | `https://api.marketplace.localhost`         |       8000 |
| [`apps/marketplace-web`](apps/marketplace-web)         | Authenticated marketplace     | Next.js | `https://marketplace.localhost`             |       3000 |
| [`apps/vayada-admin`](apps/vayada-admin)               | Platform administration       | Next.js | `https://admin.localhost`                   |       3001 |
| [`apps/booking-api`](apps/booking-api)                 | Legacy Booking API            | FastAPI | `https://api.booking.localhost`             |       8001 |
| [`apps/booking-web`](apps/booking-web)                 | Guest booking storefront      | Next.js | `https://hotel-alpenrose.booking.localhost` |       3002 |
| [`apps/booking-admin`](apps/booking-admin)             | Booking Engine administration | Next.js | `https://admin.booking.localhost`           |       3003 |
| [`apps/pms-api`](apps/pms-api)                         | Legacy PMS API                | FastAPI | `https://api.pms.localhost`                 |       8002 |
| [`apps/pms-web`](apps/pms-web)                         | PMS operations                | Next.js | `https://pms.localhost`                     |       3004 |
| [`apps/affiliate-dashboard`](apps/affiliate-dashboard) | Affiliate dashboard           | Next.js | `https://affiliate.localhost`               |       3005 |
| [`apps/landing`](apps/landing)                         | Public marketing site         | Next.js | `https://landing.localhost`                 |       3006 |

FastAPI documentation is available at `/docs` on each legacy API origin.

Booking Web is multi-tenant. Use
`https://<hotel-slug>.booking.localhost`; bare `booking.localhost` does not
select a property. The integrated local workflow enables wildcard routing.

### Local support ports

| Service                | Port | Local database      | Local user            |
| ---------------------- | ---: | ------------------- | --------------------- |
| Marketplace PostgreSQL | 5432 | `vayada_db`         | `vayada_user`         |
| Booking PostgreSQL     | 5434 | `vayada_booking_db` | `vayada_booking_user` |
| Auth PostgreSQL        | 5435 | `vayada_auth_db`    | `vayada_auth_user`    |
| PMS PostgreSQL         | 5436 | `vayada_pms_db`     | `vayada_pms_user`     |
| MinIO API              | 9000 | —                   | —                     |
| MinIO console          | 9001 | —                   | —                     |
| Local media CDN        | 9002 | —                   | —                     |

The canonical local mappings are maintained in
[`scripts/portless-setup.sh`](scripts/portless-setup.sh), app package
manifests, [`scripts/dev-workos-local.sh`](scripts/dev-workos-local.sh), and
[`docker-compose.yml`](docker-compose.yml).

## Getting started

### Prerequisites

- Git
- Docker with Docker Compose v2
- Node.js 24 and npm 11 (`.nvmrc` and `package.json` pin the supported versions)
- Python 3.11+
- portless for the recommended HTTPS workflow
- The WorkOS CLI for current AuthKit development

One-time machine and repository setup:

```bash
nvm use
npm ci
npm install -g portless workos
./scripts/portless-setup.sh
```

`portless-setup.sh` trusts the local certificate authority and may prompt for
`sudo`.

### WorkOS configuration

Current AuthKit development requires `apps/api/.env` with approved,
non-production WorkOS settings. If the file does not exist, start from
`apps/api/.env.example`, then add the values below. At minimum, configure the
complete token-verification group and the WorkOS client credentials:

```dotenv
AUTH_DATABASE_URL=postgresql://vayada_auth_user:vayada_auth_password@localhost:5435/vayada_auth_db

WORKOS_CLIENT_ID=<staging-client-id>
WORKOS_API_KEY=<staging-api-key>
WORKOS_JWKS_URL=<staging-jwks-url>
WORKOS_ISSUER=<staging-issuer>
WORKOS_AUDIENCE=<staging-audience>
```

Obtain the WorkOS values through the team's approved secret-sharing process.
They are intentionally not committed. The launcher supplies local
cookie/origin defaults, ensures the required roles and redirect/CORS entries
exist in the configured project, and refuses a production `sk_live_*` key.

Without staging WorkOS access, the Docker support stack and legacy APIs can
still run, but current AuthKit-backed sign-in will not work.

### Start the current local stack

```bash
npm run dev:workos-local
```

`npm run dev:portless` delegates to the same workflow. The launcher:

- starts Postgres, MinIO, the media CDN, and all three legacy FastAPI APIs;
- applies auth, legacy-service, and target-schema migrations;
- starts `apps/api` and all seven Next.js apps;
- enables wildcard routing for Booking Web tenant subdomains; and
- seeds legacy test data unless `SKIP_SEED=1` is set.

Stop the foreground apps with `Ctrl-C`. Then stop the Docker support services
and portless proxy with:

```bash
npm run dev:workos-local -- --stop
```

Use `./scripts/dev-portless.sh --legacy` only for legacy-backed development
that does not need the current WorkOS environment wiring.

### Plain-port development

Plain ports are useful when running one process directly, but they are not a
credential-free replacement for the integrated AuthKit stack.

Start the Docker support services:

```bash
docker compose up -d
```

This starts the databases, MinIO/media services, auth migrations, and legacy
FastAPI APIs. It does not run `apps/api` or a Next.js app. Run the required
host processes in separate terminals.

For example, to run PMS Web with first-party AuthKit over plain HTTP, register
`http://localhost:3004/auth/oauth/google/callback` and the matching API/PMS
origins in the staging WorkOS project. Keep the temporary
`http://localhost:8003/auth/oauth/google/callback` registration only while the
direct compatibility transport is still enabled. `npm run dev:api` does not
load `apps/api/.env`, and the integrated launcher's session defaults are not
present, so start the API with:

```bash
# Terminal 1
set -a
source apps/api/.env
set +a
export TARGET_DATABASE_URL="${TARGET_DATABASE_URL:-$AUTH_DATABASE_URL}"
export AUTH_COOKIE_SECRET=local-dev-auth-cookie-secret-0123456789abcdef
export AUTH_LOGOUT_URL=http://localhost:3004/login
export AUTH_ALLOWED_ORIGINS=http://localhost:8003,http://localhost:3004
export AUTH_COOKIE_SECURE=false
export AUTH_PMS_WEB_ORIGIN=http://localhost:3004
# Enable only after the PMS /auth gateway is present.
export AUTH_FIRST_PARTY_SURFACES=pms-web
export AUTH_LEGACY_PMS_JWT_SECRET=your-secret-key-change-in-production
npm run target:migrate -- --env local
npm run dev:api
```

In the second terminal, configure `apps/pms-web/.env.local` with the matching
plain-port URLs and the required compatibility bridge:

```dotenv
NEXT_PUBLIC_AUTH_API_URL=http://localhost:8003
NEXT_PUBLIC_PMS_API_URL=http://localhost:8002
NEXT_PUBLIC_PMS_OPERATIONS_API_URL=http://localhost:8003
NEXT_PUBLIC_PLATFORM_MEDIA_API_URL=http://localhost:8003
NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED=true
NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED=true
AUTH_PUBLIC_ORIGIN=http://localhost:3004
AUTH_GATEWAY_UPSTREAM_ORIGIN=http://127.0.0.1:8003
```

The two `AUTH_*` frontend values are server-only. Browser code uses relative
`/auth/*`; `NEXT_PUBLIC_AUTH_API_URL` stays on `apps/api` for existing product
API consumers.

Then run `npm run dev:pms-web`. Other web apps follow the same pattern using
their nearest `.env.example`.

For the seeded Booking Web tenant, use
`http://hotel-alpenrose.localhost:3002` or
`http://localhost:3002?slug=hotel-alpenrose`.

To replace a Compose FastAPI backend with a host process, stop that backend
first and populate its `.env` from `.env.example`. For example:

```bash
docker compose stop pms-backend
cd apps/pms-api
pip install -r requirements.txt
python scripts/run_migrations.py
uvicorn app.main:app --reload --port 8002
```

## Seed data and legacy test accounts

For standalone seeding, prepare the small Python environment once and pass it
to the seed runner:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install asyncpg bcrypt
PYTHON_BIN=.venv/bin/python npm run seed:test-data
```

The integrated local stack runs this automatically unless `SKIP_SEED=1` is
set. The seed command populates the legacy auth, marketplace, booking, and PMS
PostgreSQL data.

**The seed command does not create users or passwords in WorkOS.** Use an
approved staging WorkOS account for current AuthKit-backed UIs. The credentials
below are for legacy-auth and data testing only.

| Email               | Password    | Legacy account/data state                                      |
| ------------------- | ----------- | -------------------------------------------------------------- |
| `admin@vayada.com`  | `Vayada123` | Legacy `admin` record; not automatically a platform superadmin |
| `creator1@mock.com` | `Test1234`  | Verified, with social platforms                                |
| `creator2@mock.com` | `Test1234`  | Verified                                                       |
| `creator3@mock.com` | `Test1234`  | Pending                                                        |
| `creator4@mock.com` | `Test1234`  | Verified                                                       |
| `hotel1@mock.com`   | `Test1234`  | Verified; Hotel Alpenrose booking data                         |
| `hotel2@mock.com`   | `Test1234`  | Verified; Grand Hotel Riviera                                  |
| `hotel3@mock.com`   | `Test1234`  | Verified; The Birchwood Lodge                                  |
| `hotel4@mock.com`   | `Test1234`  | Pending; minimal City Center Hotel data                        |
| `hotel5@mock.com`   | `Test1234`  | Verified; marketplace profile without a booking record         |

See [`scripts/README.md`](scripts/README.md) for seed inputs and individual
commands.

## Databases and migrations

Docker Compose provisions the legacy/compatibility databases listed under
[Local support ports](#local-support-ports). Those names and ports are local
defaults, not a production topology contract.

Migration ownership is split across three paths:

| Scope                    | Location                                 | Local behavior                                                 | Production behavior                                                                                   |
| ------------------------ | ---------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Legacy product APIs      | `apps/*-api/migrations/`                 | FastAPI containers apply pending migrations before serving     | Each legacy API image applies its own migrations on container start                                   |
| Legacy shared auth       | `auth-db/migrations/`                    | Compose runs the `auth-db-migrate` one-shot service            | The dedicated `migrate-auth-db` workflow applies changes                                              |
| TypeScript target schema | `packages/backend-migration/migrations/` | `dev:workos-local` applies migrations to `TARGET_DATABASE_URL` | Follow the reviewed target migration and cutover runbook; `apps/api` does not auto-migrate on startup |

The target database is organized into domain schemas for platform, identity,
hotel catalog, booking, PMS, finance, marketplace, distribution, and
intelligence. The local launcher uses `AUTH_DATABASE_URL` as the target URL
when `TARGET_DATABASE_URL` is not set.

To apply target migrations manually to a configured local database:

```bash
set -a
source apps/api/.env
set +a
export TARGET_DATABASE_URL="${TARGET_DATABASE_URL:-$AUTH_DATABASE_URL}"
npm run target:migrate -- --env local
```

Detailed target migration, fixture, parity, and WorkOS backfill commands live
in [`packages/backend-migration/README.md`](packages/backend-migration/README.md).
Production database operations are service-specific; do not treat
`scripts/run_migration.sh` as a universal migration command.

## Authentication and authorization

Two auth models coexist during migration:

- **Target path:** WorkOS/AuthKit owns provider authentication and sessions.
  `apps/api` maps provider identities and memberships to Vayada-owned users,
  organizations, permissions, resource links, and product entitlements in the
  target identity schema.
- **Legacy compatibility path:** `auth-db/` and the FastAPI services retain
  password/JWT-era tables and flows required by unmigrated routes and rollback
  compatibility.

Legacy `users.type` values (`hotel`, `creator`, `admin`, and `affiliate`) are
migration inputs, not the target authorization model. Target authorization
resolves an authenticated identity to an internal user, selected organization,
active membership, permissions, linked product resources, and entitlements.

## Environment variables

Environment variables are app-specific. Use the nearest
`apps/<app>/.env.example`, [`apps/api/src/config.ts`](apps/api/src/config.ts),
and the checked-in deploy workflow as the source of truth. Production values
and secrets are owned by the platform repository.

The current AuthKit group is shown in [Getting started](#getting-started).
Target rollout selectors and platform-media options are documented in
`apps/api/.env.example` and `apps/api/src/config.ts`.

`NEXT_PUBLIC_*` values are bundled into frontend builds and must never contain
server secrets. Do not assume a variable with the same name has the same
semantic role in every app; follow that app's example file and deployment
workflow.

## Workspace commands and validation

The npm workspace globs are `apps/*` and `packages/*`. Python services remain
outside npm workspaces and use their own requirements and pytest commands.

Common root commands:

```bash
npm ci
npm run build
npm run lint
npm run typecheck
npm run test:api
npm run test:architecture-boundaries
```

For a changed FastAPI backend:

```bash
cd apps/<api>
python -m pytest
ruff check <changed-paths>
```

For a changed Next.js app, run its build and lint commands. Root app-specific
aliases include `build:<app>` and `lint:<app>` for each web app.

UI changes also require browser exercise. Run the full Playwright smoke layer
or an app-specific command, for example:

```bash
npm run e2e
npm run e2e:booking-web
```

See [`tests/e2e/README.md`](tests/e2e/README.md) for URL overrides,
`E2E_START_SERVERS=1`, supported app commands, and focused smoke coverage.

## Production infrastructure and deployment

Production infrastructure, DNS, secrets, certificates, load balancing, and
runtime configuration are owned in the
[`vayada-platform`](https://github.com/vayada-marketplace/vayada-platform)
repository. Its environment documentation is the canonical source for the
current service and hostname inventory.

The active application-repository delivery flow is service-specific:

1. Pull requests run the shared check workflow.
2. Legacy Python API and parallel `deploy-next-*` workflows build Docker images
   and publish them to ECR.
3. ECS-backed workflows send an `app-image-published` repository-dispatch event
   to `vayada-platform`, which owns the deployment after that handoff.

Parallel `deploy-next-*` workflows and `next-*` hostnames are used to validate
the target stack before canonical routing is cut over. Canonical product
frontends remain frozen on their legacy API builds and have no active deploy
workflow in this repository; only the parallel `next-*` services use the
TypeScript backend. Restoring canonical frontend delivery requires an explicit
rollback-compatibility or cutover change. Exact host routing is deliberately not
duplicated here; use the platform environment documentation as the authoritative
mapping.

## Development workflow

Before changing the repository, read [`AGENTS.md`](AGENTS.md) for branch,
validation, and shipping rules. Target-backend, WorkOS, target-schema,
migration, and cutover work also follows the
[TypeScript rewrite workflow](.agents/skills/typescript-rewrite-workflow/SKILL.md);
Linear conventions live in
[`engineering/linear-workspace.md`](engineering/linear-workspace.md).
