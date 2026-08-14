# TypeScript backend runtime and DB tooling decision

_VAY-607 decision record. Official tool documentation checked on 2026-06-03._

## Recommendation

Use this stack for the first TypeScript backend:

- **HTTP runtime/framework:** Fastify.
- **Application query layer:** Kysely over `pg` / node-postgres.
- **Schema migrations:** explicit reviewed SQL migrations, applied by a small
  migration runner over `pg`.
- **Legacy introspection:** Prisma CLI may be used as an optional analysis tool
  for `prisma db pull --print` or throwaway legacy schemas, but Prisma should
  not be the target schema source of truth and Prisma Client should not be the
  first application query layer.
- **Tests:** Vitest for unit, contract, migration-harness, and HTTP tests;
  Fastify's `inject()` for route tests.

This keeps the rewrite aligned with VAY-603 and VAY-605: target-schema contracts
come before product implementation, production Python services remain the source
of truth until cutover, and the target database is designed from Vayada's domain
model rather than auto-converted from legacy tables.

## Why Fastify

Fastify is the best fit for a serverful Node.js API on ECS:

- It is small enough for a modular backend and does not impose an application
  architecture on domain packages.
- Route validation and response serialization are first-class through JSON
  Schema and Ajv.
- The plugin model is a good match for route groups such as marketplace,
  booking, PMS, platform, and AI.
- `fastify.inject()` lets tests exercise routes without binding a real port.
- It has an established TypeScript story without requiring decorators or a
  framework-specific dependency injection container.

Alternatives:

| Option  | Decision | Reason                                                                                                                                                                     |
| ------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hono    | Defer    | Strong fit for Fetch-standard and edge/runtime-portable APIs, but Vayada's first target is ECS/Node and needs mature serverful plugin, lifecycle, and validation patterns. |
| NestJS  | Defer    | Useful for large teams that want a prescriptive framework, but too heavy for the first scaffold and likely to leak framework architecture into domain boundaries.          |
| Express | Defer    | Stable and familiar, but too minimal for this rewrite's validation, typing, plugin, and testability needs without adding several separate conventions.                     |

## Why Kysely over `pg`

Kysely gives Vayada a thin, SQL-shaped query layer with TypeScript types. That
fits the target database program better than starting with a full ORM:

- The target schema will use domain-owned tables, read models, migration
  fixtures, parity checks, and cutover scripts. The team needs SQL to stay
  visible and reviewable.
- Kysely keeps query construction close to SQL while adding compile-time table,
  column, and result typing.
- `pg` remains the driver and pooling layer, so transaction behavior is explicit
  and can be wrapped in `backend-db` helpers.
- Kysely can use generated DB types after the target DDL exists; generated types
  are an output of the schema, not the design source.

Use `pg` directly for:

- migration runner internals,
- bulk ETL/migration scripts where raw SQL is clearer,
- operations that need driver-specific behavior,
- transaction and advisory-lock helpers.

## Migration approach

Use explicit SQL migrations as the source of truth for the target schema.

Recommended shape:

```text
packages/backend-migration
  migrations/
    0001_identity.sql
    0002_resource_links.sql
    ...
  src
    runner.ts
    checks.ts
    fixtures.ts
```

Rules:

- Migrations are reviewed SQL files, not generated artifacts accepted blindly.
- The runner records applied migrations in the target database.
- Local and staging can rebuild the target schema from scratch.
- Production migration is an explicit reviewed operation; it must not run as a
  side effect of starting `apps/api`.
- The migration harness owns source-to-target counts, uniqueness checks,
  checksums where practical, ownership parity, and public/private exposure
  checks.

Prisma Migrate and Drizzle Kit both generate SQL migrations, and those tools are
valid for projects where the ORM schema is the desired source of truth. For this
rewrite, the safer source of truth is reviewed SQL plus target-schema contract
docs, because the production cutover depends on deterministic DDL, explicit ETL,
and staging rehearsal output.

## Prisma decision

Do not use Prisma Client for the first TypeScript application query layer.

Allowed Prisma use:

- Run `prisma db pull --print` or a separate throwaway schema path against a
  legacy database to understand current tables.
- Compare Prisma's introspected model against the manual schema audit as an
  investigation aid.
- Use `prisma migrate diff` only as a schema comparison aid, not as an
  authoritative migration generator.

Disallowed Prisma use for the first cutover path:

- Do not generate the target schema by introspecting legacy databases.
- Do not make `schema.prisma` the source of truth for the target schema.
- Do not use Prisma Client as the default domain repository layer.
- Do not rely on Prisma Migrate for production cutover DDL.

Reasoning:

- Prisma introspection reflects the database that exists today. It cannot infer
  Vayada's target domains: WorkOS identity mappings, internal organizations,
  resource links, bookability read models, jobs, audit, or migration-only
  ownership columns.
- The rewrite needs explicit SQL review and parity harness output more than it
  needs an ORM abstraction.
- Prisma remains useful for discovery, but discovery output should not drive the
  architecture.

## Drizzle decision

Do not choose Drizzle as the first query/migration layer, but keep it as the
main fallback if Kysely proves insufficient before scaffold.

Drizzle is attractive because it provides TypeScript schema definitions,
type-safe queries, and Drizzle Kit migration commands. The tradeoff is that it
encourages a TypeScript schema definition to become the canonical schema source.
That is not the safest first posture for Vayada's coordinated target-schema
cutover.

Revisit Drizzle if:

- the target-schema ownership map stays simple enough to benefit from
  schema-in-TypeScript,
- the team wants generated SQL migrations from TypeScript declarations,
- Kysely type generation becomes too manual.

## Testing setup

Use Vitest as the backend test runner.

Recommended first scaffold checks:

- `npm run typecheck` for `apps/api` and shared backend packages.
- `npm run test` for Vitest.
- One Fastify `inject()` health/readiness route test.
- Contract fixture tests for `RequestContext`, bookability, evidence, and
  migration parity as those contracts are added.
- Postgres-backed integration tests through `backend-test` helpers once the
  target schema harness exists.

Avoid browser or frontend E2E tests for the initial backend scaffold; those
belong to later compatibility-route or UI slices.

## Local, staging, and production implications

Local:

- `apps/api` runs as an npm workspace.
- The target database can be created separately from the current auth,
  marketplace, booking, and PMS databases.
- Local migrations may be reset/replayed freely against target fixtures.

Staging:

- Staging must support full target-schema rebuilds from production-like
  snapshots.
- Migration/parity checks must fail on ambiguous ownership, uniqueness failures,
  critical count mismatches, and public/private exposure mistakes.

Production:

- Do not auto-run target schema migrations on `apps/api` container start.
- Apply final migration/cutover through a reviewed operation with backups,
  go/no-go gates, and rollback window.
- Keep legacy Python services and databases authoritative until the cutover
  runbook says traffic can move.

## Follow-up tickets

Create or confirm these as separate tickets:

1. Scaffold `apps/api` with Fastify, Vitest, health/readiness, route groups,
   typecheck/test scripts, and portless wiring.
2. Define the `RequestContext` contract.
3. Define the target schema ownership map.
4. Design the migration/parity harness and explicit SQL migration runner.

## References

- Fastify TypeScript and validation docs:
  <https://fastify.dev/docs/latest/Reference/TypeScript/>,
  <https://fastify.dev/docs/v5.7.x/Reference/Validation-and-Serialization/>
- Fastify testing docs: <https://fastify.dev/docs/v5.7.x/Guides/Testing/>
- Hono web standards and Node docs:
  <https://hono.dev/docs/concepts/web-standard>,
  <https://hono.dev/docs/getting-started/nodejs>
- NestJS overview and testing docs: <https://docs.nestjs.com/v10>,
  <https://docs.nestjs.com/fundamentals/testing>
- Express middleware and routing docs:
  <https://expressjs.com/en/guide/using-middleware>,
  <https://expressjs.com/en/guide/routing.html>
- Kysely docs: <https://www.kysely.dev/>
- node-postgres pooling and transactions:
  <https://node-postgres.com/features/pooling>,
  <https://node-postgres.com/features/transactions>
- Prisma introspection and migration docs:
  <https://docs.prisma.io/docs/orm/prisma-schema/introspection>,
  <https://docs.prisma.io/docs/cli/migrate/diff>,
  <https://docs.prisma.io/docs/orm/prisma-migrate>
- Drizzle Kit docs: <https://orm.drizzle.team/kit-docs/overview>
- Vitest writing tests docs: <https://vitest.dev/guide/learn/writing-tests>
