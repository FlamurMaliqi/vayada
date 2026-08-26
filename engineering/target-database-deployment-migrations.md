# Target database deployment migrations

VAY-1316 makes target TypeScript migrations a startup gate for the deployed
`next-api` release. The release image runs the existing
`@vayada/backend-migration` runner before it starts the HTTP server. A failed
migration exits the container, so ECS cannot route target traffic to that task
or report the new service deployment healthy.

This applies only to the target TypeScript database. Legacy Python and auth-db
migration procedures are unchanged.

## Normal deployment

1. `.github/workflows/deploy-next-api.yml` builds one SHA-tagged image and embeds
   the application commit in `APPLICATION_RELEASE`.
2. The platform deployment resolves that image to an ECR digest and rolls out
   the immutable task definition.
3. `scripts/start-next-api.sh` runs all pending target migrations with
   `--env production --git-sha "$APPLICATION_RELEASE"`.
4. Only an exit code of zero starts `apps/api`. The runner advisory lock and
   migration ledger make repeated or overlapping task starts idempotent.

CloudWatch group `/ecs/vayada-next-api` records the release SHA and the applied,
already-applied, or failed migration versions. The durable ledger is
`platform.schema_migrations`.

## Verification

Confirm the service is stable, then verify the release and ledger:

```sql
SELECT version, name, status, git_sha, applied_at, failure_reason
FROM platform.schema_migrations
ORDER BY applied_at DESC;
```

A repeated deploy of the same image must log `No pending migrations` and start
normally. A release with a new migration must log that version as applied before
the API startup line and before its task passes the load-balancer health check.

## Failed migration recovery

1. Treat the platform deployment as blocked. The previous healthy task remains
   the serving release; do not bypass the startup gate.
2. Find `Failed at version NNNN` in `/ecs/vayada-next-api`, then inspect the
   matching failed ledger row and `failure_reason`.
3. For a transactional failure, fix the migration in a new application release.
   For a non-transactional migration, inspect partial effects and make the
   roll-forward migration idempotent before retrying. Do not automatically roll
   back destructive DDL.
4. Publish the corrected release through the normal deploy workflow. Do not
   edit the ECS task definition or run an untracked database command manually.
5. Verify the corrected release SHA, applied migration row, service stability,
   and a target-stack smoke before accepting the deployment.

If the runner cannot acquire its advisory lock, allow the active migration to
finish and retry the deployment. Do not increase database connections or remove
the lock to force concurrent DDL.
