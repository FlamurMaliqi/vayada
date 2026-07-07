---
name: run-local-portless
description: Use when a user asks to deploy, run, start, boot, launch, or test the Vayada monorepo locally, even if they do not mention portless or Docker.
---

# Run Vayada Locally

Use this as the default local deployment workflow for Vayada. Do not require the
user to mention portless or Docker; those are implementation details handled by
the repo script.

From the repo root:

```sh
npm run dev:portless
```

Equivalent direct command:

```sh
./scripts/dev-portless.sh
```

What this does:

- Starts Docker databases, MinIO, auth migrations, and the three FastAPI backends in the background.
- Applies `docker-compose.portless.yml` so backend CORS allows portless frontend origins.
- Registers the `api.marketplace`, `api.booking`, and `api.pms` portless aliases.
- Starts the TypeScript API with WorkOS/AuthKit env wiring and runs `portless`
  in the foreground for all Next.js frontends.

The old FastAPI-only transitional stack is explicit:

```sh
./scripts/dev-portless.sh --legacy
```

After the Docker databases/backends are healthy, seed the local test data from a
second shell/tool call:

```sh
npm run seed:test-data
```

This seeds auth users, marketplace demo profiles/listings/collaborations, booking
engine hotels/translations, and PMS hotels/room types/sample bookings. The seed
runner is intended to be rerunnable for local development. If `asyncpg` or
`bcrypt` is missing, follow the wrapper's install message and rerun the same npm
command.

To stop the Docker backend services started by this workflow:

```sh
./scripts/dev-portless.sh --stop
```

If `portless` is missing, tell the user to run:

```sh
npm install -g portless
./scripts/portless-setup.sh
```

Do not recommend manually starting every frontend/API unless the script fails or the user specifically asks for the lower-level commands.
