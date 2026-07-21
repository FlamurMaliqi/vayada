# GitHub Actions Runner Spike

_VAY-808 spike output. Evaluates moving Vayada CI jobs off default
GitHub-hosted runners, with Blacksmith as the primary candidate._

## Recommendation

Treat making the repository public again as the immediate mitigation for
GitHub-hosted runner minutes. Keep Blacksmith as a follow-up pilot for `PR
Checks` if PR feedback time, queueing, or service-container startup remains a
problem after public-repo Actions minutes are available again.

If Vayada pilots Blacksmith, start with the backend matrix and then the frontend
job if the backend pilot is stable. Do not move production deploy workflows in
the first pilot.

The reason is practical: Vayada's current pain is PR feedback and GitHub-hosted
runner limits, not production deploy throughput. When the repository was
private, standard GitHub-hosted runner minutes counted against the organization
quota. Recent failed `PR Checks` runs, including
[`27414220366`](https://github.com/vayada-marketplace/vayada/actions/runs/27414220366),
failed all jobs in roughly three to eight seconds with no recorded steps. That
shape is consistent with a runner/account/limit failure rather than test code.
After the repository was made public again on June 12, 2026, rerunning those
jobs started normal setup, checkout, dependency, and service-container steps.

Blacksmith is a reasonable pilot candidate because it is designed as a
`runs-on` replacement, advertises unlimited concurrency, has faster dependency
cache behavior without workflow changes, and has specific acceleration for
service containers and Docker builds. The pilot should still be gated by a short
security/account setup review because Blacksmith runs repository code on a
third-party runner fleet.

## Current Workflow Inventory

| Workflow                                 | Trigger                                | Jobs                                                                                                                  | Current runner  | Runner sensitivity                                                                                                                                                                                                                 |
| ---------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/pr-checks.yml`        | PRs to `main`                          | Frontend typecheck/lint/build; backend matrix for `marketplace-api`, `booking-api`, `pms-api`; required aggregate job | `ubuntu-latest` | Best pilot target if public-repo runner behavior is still too slow or queue-prone. Backend jobs use two PostgreSQL service containers each. Frontend is CPU/cache heavy because it runs root `npm ci`, typecheck, lint, and build. |
| `deploy-*.yml`                           | `push` to `main` with app path filters | One Docker/ECR build job per app                                                                                      | `ubuntu-latest` | Promising later candidate because most workflows use Docker Buildx and `cache-from/cache-to: type=gha`, but deployment credentials and rollback risk make this a second phase.                                                     |
| `.github/workflows/migrate-auth-db.yml`  | `push` to `main` for auth DB paths     | Applies auth DB migrations to prod RDS                                                                                | `ubuntu-latest` | Keep on GitHub-hosted runners for now. It is production-sensitive, low-frequency, and depends on AWS access.                                                                                                                       |

Recent successful `PR Checks` run
[`27406874542`](https://github.com/vayada-marketplace/vayada/actions/runs/27406874542)
completed in about six minutes wall-clock:

- frontend: about 5m40s, with build as the longest step;
- marketplace backend: about 2m50s, including about 25s container init;
- booking backend: about 1m25s, including about 20s container init;
- PMS backend: about 3m05s, including about 22s container init.

The workflow normally runs five jobs. When the repository is private, GitHub
bills standard hosted runner use by job runtime, so parallel PR activity can
burn minutes quickly even when wall-clock time is acceptable. When the
repository is public, standard GitHub-hosted runner minutes are not the same
cost pressure, but the workflow can still be evaluated for queueing, wall-clock
latency, and service-container startup time.

## GitHub Baseline

GitHub's current docs say standard GitHub-hosted runners are free for public
repositories, but private repositories receive quota-limited included minutes
and storage; additional use is billed to the repo owner
([GitHub billing docs](https://docs.github.com/en/billing/concepts/product-billing/github-actions)).
GitHub also documents Actions limits where jobs can be cancelled when limits
are reached, including job concurrency, cache upload rate, and storage
constraints
([Actions limits](https://docs.github.com/en/actions/reference/limits)).

GitHub larger runners are the official way to buy more CPU/RAM, but they do not
use included minutes and are always charged per minute, even for public repos
([larger runner billing](https://docs.github.com/en/actions/concepts/runners/larger-runners)).
They may help raw speed but do not directly address the current "hosted runner
quota/spending limit stopped all jobs before step 1" failure mode unless the
organization also changes billing settings.

## Blacksmith Fit

Blacksmith's runner docs describe migration as changing `runs-on` from
`ubuntu-latest` to labels like `blacksmith-2vcpu-ubuntu-2404` or
`blacksmith-4vcpu-ubuntu-2404`
([Blacksmith instance types](https://docs.blacksmith.sh/blacksmith-runners/overview)).
They also claim ephemeral Firecracker microVMs, runner startup under three
seconds, GitHub-compatible runner images, and no GitHub-hosted runner
concurrency ceiling for Blacksmith capacity.

For Vayada specifically:

- PR backend jobs should benefit from faster service-container startup.
  Blacksmith documents container pre-hydration for service containers and
  Docker pulls, with the "Initialize Containers" step dropping from minutes to
  seconds when the cache is hot
  ([container caching](https://docs.blacksmith.sh/blacksmith-caching/docker-container-caching)).
- PR frontend jobs should benefit from colocated dependency caches. Blacksmith
  says native cache actions such as `actions/cache`, `actions/setup-node`, and
  `actions/setup-python` transparently use its colocated cache with no workflow
  changes, with branch-scoped cache access similar to GitHub's model
  ([dependency caching](https://docs.blacksmith.sh/blacksmith-caching/dependencies-actions)).
- Deploy jobs may benefit from Blacksmith's Docker layer cache, but that requires
  replacing `docker/setup-buildx-action` and `docker/build-push-action` with
  Blacksmith actions, and Docker cache storage is billed separately
  ([Docker build caching](https://docs.blacksmith.sh/blacksmith-caching/docker-builds)).
  This should wait until PR checks prove the runner path.

## Security And Operations

Blacksmith requires installing a GitHub integration and granting access to the
repositories that may use its runners. Its security page says the integration
does not directly access organization or repository secrets, but it does need
read/write access to actions, code, pull requests, workflows, and organization
self-hosted runners to create just-in-time runner tokens
([Blacksmith security](https://www.blacksmith.sh/security)).

Operational notes for Vayada:

- Treat Blacksmith as a third-party CI processor for source code, logs, and job
  environment. Do not pilot on production deploy or migration jobs first.
- Keep check names unchanged by changing only `runs-on`. Branch protection
  should continue to see `Frontend Typecheck, Lint, Build`,
  `Backend Tests (...)`, and `Required Checks`.
- Keep the existing workflow `concurrency` groups unchanged. GitHub should
  still own PR run cancellation and pending-run behavior; Blacksmith only
  changes where eligible jobs execute after GitHub schedules them.
- `Required Checks` can stay on GitHub-hosted initially, because it is tiny and
  depends only on the other job results. Moving it is optional.
- OIDC/secrets should be avoided in phase 1 by excluding deploy workflows.
  Production workflows use AWS credentials and ECR pushes; those should move
  only after PR checks are proven.
- If the GitHub organization has IP allowlists, Blacksmith documents control
  plane IPs that must be allowlisted for runner registration; runner static IPs
  are a separate paid feature for CI jobs reaching external services
  ([network allowlisting](https://docs.blacksmith.sh/blacksmith-administration/network-allowlisting),
  [static IP](https://docs.blacksmith.sh/blacksmith-runners/static-ip)).
- Rollback is simple for the PR pilot: revert `runs-on` labels to
  `ubuntu-latest`.

## Alternatives

| Option                                 | Pros                                                                                                                                                      | Cons                                                                                                                                                                                                | Recommendation                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Stay on standard GitHub-hosted runners | No vendor change; best-known security and branch protection behavior. Public repos get more favorable standard-runner billing.                            | If the repo becomes private again, it can hit GitHub-hosted runner quota/spending/concurrency limits. It may still be slower than specialized runners for service containers and Docker-heavy jobs. | Default path after making the repo public again. Revisit if checks remain slow or queued. |
| GitHub larger runners                  | Official GitHub path, more CPU/RAM, no third-party CI vendor.                                                                                             | Always billed per minute and not eligible for included minutes. Does not improve Docker/cache behavior as much as runner-specialized providers.                                                     | Not first choice for this repo. Consider only if third-party runner security is rejected. |
| Blacksmith                             | Drop-in `runs-on` labels, lower listed Ubuntu x64 rate, colocated dependency caches, service-container caching, Docker build cache option, observability. | Requires new GitHub App/vendor trust. Docker cache and static IPs are paid add-ons. Real Vayada performance must be measured.                                                                       | Go for PR-checks pilot.                                                                   |
| Self-hosted ARC or own runners         | Full control over network and environment.                                                                                                                | Ongoing ops burden, patching, autoscaling, isolation, secret exposure risk, and more failure modes for a one-engineer repo.                                                                         | No-go for now. Too much maintenance.                                                      |

## Pilot Plan

### Phase 0: unblock current PRs

1. Confirm GitHub sees `vayada-marketplace/vayada` as public.
2. Re-run PR #273 and any other failed PR checks after the visibility change.
3. If jobs still fail before step execution, check the GitHub organization
   billing/minutes/spending limit state and Actions policy settings.
4. If the repo becomes private again, temporarily raise the GitHub Actions
   spending limit or wait for quota reset so urgent PRs can merge.

This is separate from the runner migration. Making the repo public again is the
right first mitigation for minute exhaustion. Blacksmith should be evaluated for
speed, reliability, and future private-repo cost control, not as the only way to
unblock already-open PRs.

### Phase 1: PR backend matrix pilot

Create a small PR that changes only the backend matrix in
`.github/workflows/pr-checks.yml`:

```yaml
backend:
  runs-on: blacksmith-2vcpu-ubuntu-2404
```

Use `blacksmith-2vcpu-ubuntu-2404` first because the backend jobs are currently
short and service-container-heavy. If CPU becomes the bottleneck, compare
`blacksmith-4vcpu-ubuntu-2404`.

Setup steps:

1. Create or connect the Vayada organization in Blacksmith.
2. Install the Blacksmith GitHub App for `vayada-marketplace/vayada` only.
3. Confirm `blacksmith-*` runners appear for the repository.
4. If Vayada has GitHub org IP allowlisting, allowlist Blacksmith control-plane
   IPs before the first run.
5. Open the backend-only runner-label PR.

Success metrics:

- Jobs start reliably and do not fail before step execution.
- Backend matrix success rate is at least as good as GitHub-hosted over ten PR
  runs or manual dispatches.
- Wall-clock backend matrix time improves by at least 20%, or total billed CI
  cost materially drops.
- `Initialize containers` time improves from the current roughly 20-25s range
  after cache warm-up.
- No branch protection/check-name change is required.

Rollback:

- Revert the `runs-on` label to `ubuntu-latest`.
- Disable repository access in Blacksmith if the pilot is abandoned.

### Phase 2: frontend PR job

If the backend pilot is stable, move the frontend PR job to
`blacksmith-4vcpu-ubuntu-2404` and measure:

- `npm ci`;
- `npm run typecheck`;
- `npm run lint`;
- `npm run build`;
- total wall-clock and failure rate.

Do not change the commands in this phase. The purpose is runner comparison, not
CI gate redesign.

### Phase 3: optional deploy workflow experiment

Only after PR checks are proven, test one low-risk Docker deploy workflow on
Blacksmith. Prefer a frontend workflow with existing Buildx usage, not
`migrate-auth-db.yml`.

Candidate: `deploy-next-marketplace-web.yml` or
`deploy-next-affiliate-dashboard.yml`.

Measure before changing Docker actions:

- image build duration;
- cache hit behavior using existing `type=gha`;
- ECR push reliability;
- platform dispatch reliability.

Only then consider replacing Docker actions with Blacksmith's Docker builder and
build-push actions. That follow-up needs its own ticket because it changes cache
semantics and adds Docker cache storage cost.

## Follow-Up Tickets

Created from this spike:

1. VAY-835: Pilot Blacksmith runners on PR backend checks.
2. VAY-836: Extend Blacksmith pilot to the frontend PR check after backend
   validation.
3. VAY-837: Evaluate one Docker deploy workflow on Blacksmith after PR checks
   are stable.

Do not create a ticket to move auth DB migration or all production deploys yet.

## Go / No-Go

Go for staying on standard GitHub-hosted runners now that the repository is
public again, while keeping a limited Blacksmith PR-check pilot queued as a
follow-up if public-runner performance or queueing remains painful.

No-go for immediate production deploy migration.

The pilot remains worthwhile if Vayada wants faster PR feedback or protection
against future private-repo minute pressure, because Blacksmith directly targets
runner capacity, cache locality, and service-container startup. The first PR
should be small enough to roll back in one commit and should not touch AWS
deployment or database migration workflows.
