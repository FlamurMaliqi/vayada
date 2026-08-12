# scripts

Helper scripts for the Vayada monorepo.

## `dev-workos-local.sh`

Start the current local stack for AuthKit and next-stack development.

```sh
./scripts/dev-workos-local.sh
# or
npm run dev:workos-local
```

The script starts the Docker support services needed by the legacy FastAPI APIs,
loads `apps/api/.env`, applies the target identity/API migrations to the local
auth DB, ensures the local WorkOS role slugs exist, starts `apps/api` on port
8003, and runs all Next.js apps through portless. It also starts portless with
wildcard routing for `*.booking.localhost`.

Use this for WorkOS/AuthKit, target API, and current next-stack frontend work.
It requires staging WorkOS settings in `apps/api/.env`; production `sk_live_*`
keys are refused locally. Keep the local/staging login UI aligned by copying
the production AuthKit branding into the staging WorkOS environment. Disable
AuthKit's built-in public "Sign up" control for the staging/local environment in
the WorkOS dashboard; Vayada signups must start from product-specific `/signup`
routes so the callback carries a `creator` or `hotel` organization intent.

The launcher registers an exact Google callback for Vayada Admin, Marketplace,
Booking Admin, PMS, and Affiliate, plus the temporary `api.localhost`
compatibility callback. Portless review ports and worktree-qualified hosts are
preserved. Each authenticated frontend receives these server-only settings:

```dotenv
AUTH_PUBLIC_ORIGIN=https://<that-frontend-origin>
AUTH_GATEWAY_UPSTREAM_ORIGIN=http://127.0.0.1:8003
```

Browser auth uses the literal relative `/auth` path on all five migrated
frontends. `NEXT_PUBLIC_AUTH_API_URL` continues to point at
`api.localhost` for existing non-auth TypeScript API consumers; do not repoint
it to a frontend. The launcher enables all five values in
`AUTH_FIRST_PARTY_SURFACES` by default; override the variable only when testing
a deliberate compatibility scenario.

To stop the Docker backend services and portless proxy started by the script:

```sh
./scripts/dev-workos-local.sh --stop
```

Run the focused origin-shape checks for canonical, review-port, worktree, and
plain-port examples without starting the stack:

```sh
npm run test:workos-local-config
```

## `dev-portless.sh`

Start the transitional local stack with Docker databases/FastAPI backends and
repo-root portless apps.

```sh
./scripts/dev-portless.sh
# or
npm run dev:portless
```

The script starts the Docker services needed by the FastAPI APIs in the
background, registers the legacy FastAPI portless aliases, then runs `portless`
in the foreground for locally configured apps. Use `dev-workos-local.sh` when
the local run needs WorkOS/AuthKit env wiring.

To stop the Docker backend services started by the script:

```sh
./scripts/dev-portless.sh --stop
```

## `run_migration.sh`

Run database migrations against the production AWS RDS instance for a given
service. Temporarily opens the RDS security group to your public IP, runs the
service's `scripts/run_migrations.py`, then revokes the ingress rule on exit.

```sh
./scripts/run_migration.sh <pms|booking|marketplace|auth>
```

Requires AWS CLI credentials and Python 3 with `asyncpg`. DB passwords are stored in AWS SSM under `/vayada/prod/`.

## Seed scripts

Populate local databases with mock data for development. All seed scripts
default to `localhost` Postgres URLs; override via `DATABASE_URL`,
`AUTH_DATABASE_URL`, `PMS_DATABASE_URL` env vars.

| Script                | Purpose                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `seed_users.py`       | Seeds the shared auth DB with the admin user and mock hotel/creator accounts. **Run this first.**                  |
| `seed_marketplace.py` | Seeds the marketplace DB with profiles, listings, collaborations, chats, and reviews.                              |
| `seed_booking.py`     | Seeds the booking-engine DB (hotel properties, translations) and the PMS DB (hotels, room types, sample bookings). |
| `seed_all.py`         | Runs the three above in order (`users → marketplace → booking`) and prints credentials at the end.                 |

```sh
npm run seed:test-data
```

Default credentials after seeding:

- Admin: `admin@vayada.com` / `Vayada123`
- Hotels: `hotel[1-5]@mock.com` / `Test1234`
- Creators: `creator[1-4]@mock.com` / `Test1234`
