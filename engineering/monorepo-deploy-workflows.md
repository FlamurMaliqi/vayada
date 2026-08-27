# Monorepo deploy workflows

Updated: 2026-08-22

## Active delivery lanes

The monorepo keeps deploy workflows only for the production Python APIs and the
parallel `next-*` validation stack. They are manually dispatchable and also run
on relevant pushes to `main`.

| Runtime                  | Workflow                                                |
| ------------------------ | ------------------------------------------------------- |
| Marketplace API          | `.github/workflows/deploy-marketplace-api.yml`          |
| Booking API              | `.github/workflows/deploy-booking-api.yml`              |
| PMS API                  | `.github/workflows/deploy-pms-api.yml`                  |
| Next TypeScript API      | `.github/workflows/deploy-next-api.yml`                 |
| Next Marketplace Web     | `.github/workflows/deploy-next-marketplace-web.yml`     |
| Next Vayada Admin        | `.github/workflows/deploy-next-vayada-admin.yml`        |
| Next Booking Web         | `.github/workflows/deploy-next-booking-web.yml`         |
| Next Booking Admin       | `.github/workflows/deploy-next-booking-admin.yml`       |
| Next PMS Web             | `.github/workflows/deploy-next-pms-web.yml`             |
| Next Affiliate Dashboard | `.github/workflows/deploy-next-affiliate-dashboard.yml` |

ECS-backed workflows publish a SHA-pinned image and send an
`app-image-published` repository dispatch to `vayada-platform`, which owns the
service update. GitHub Actions authenticates through
`arn:aws:iam::269416271598:role/vayada-github-actions-deploy`.

Next Booking Web also publishes its source SHA through `/api/health`. The
`vayada-platform` deployment workflow waits for ECS service stability, then
verifies that exact SHA against an unmocked persistent tenant through host
resolution, the public-bookability profile, and public page reachability. The
app repository's Playwright-based `Next Booking public canary` workflow repeats
the tenant checks every 15 minutes and on manual dispatch so publication
regressions are detected between deployments without racing the ECS cutover.

The Next TypeScript API image applies pending target migrations before its HTTP
server starts. See
[`target-database-deployment-migrations.md`](target-database-deployment-migrations.md)
for the deployment gate, evidence, and recovery procedure.

## Frozen canonical frontends

Canonical frontend services continue to run their existing legacy-API images.
Their stale, disabled target-backend workflows were removed under VAY-868 so an
unrelated change cannot accidentally rebuild them against the retired staging
API. Reintroducing canonical frontend delivery requires a dedicated change that
proves either legacy rollback compatibility or the intended TypeScript cutover.

Documentation-only changes do not deploy applications.
