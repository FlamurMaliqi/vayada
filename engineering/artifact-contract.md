# App Artifact Contract

Defines what the `vayada` app repository produces and what the `vayada-platform` repository consumes. Both sides must implement against this contract without hidden assumptions.

## Registry

All images are published to Amazon ECR in `eu-west-1`:

```
269416271598.dkr.ecr.eu-west-1.amazonaws.com/<ecr-repo>
```

ECR repositories are created and owned by `vayada-platform` (via `ecr.tf`). The app repository publishes images to them but does not create or manage them.

## Services

| App directory              | ECR repository                       | Deploy target                  |
| -------------------------- | ------------------------------------ | ------------------------------ |
| `apps/booking-api`         | `vayada-booking-backend`             | ECS Fargate                    |
| `apps/booking-web`         | `vayada-booking-frontend`            | ECS Fargate                    |
| `apps/booking-admin`       | `vayada-booking-admin-frontend`      | ECS Fargate                    |
| `apps/pms-api`             | `vayada-pms-backend`                 | ECS Fargate                    |
| `apps/pms-web`             | `vayada-pms-frontend`                | ECS Fargate                    |
| `apps/marketplace-api`     | `vayada-creator-marketplace-backend` | ECS Fargate                    |
| `apps/vayada-admin`        | `vayada-admin-frontend`              | ECS Fargate                    |
| `apps/affiliate-dashboard` | `vayada-affiliate-dashboard`         | ECS Fargate                    |
| `apps/landing`             | `vayada-landing`                     | App Runner (planned; inactive) |

## Image tagging

For services with an active deployment workflow, app CI pushes two tags on
every successful main-branch build:

- `:latest` — mutable, points to the most recent build
- `:<git-sha>` — immutable, the full 40-character commit SHA

**Platform CI must deploy using the SHA-pinned tag.** The `:latest` tag is used by App Runner (which polls ECR natively) and as a build cache source.

Tag format: `269416271598.dkr.ecr.eu-west-1.amazonaws.com/<ecr-repo>:<git-sha>`

## App CI responsibilities

App CI owns everything up to and including image publication:

1. Run tests for the changed service
2. Build a `linux/amd64` Docker image
3. Push both tags (`:latest` and `:<git-sha>`) to ECR
4. Dispatch a deploy trigger to `vayada-platform` (see below)

App CI does **not** update ECS task definitions, register new task definition revisions, or trigger ECS service updates.

## Deploy trigger

After a successful image push, app CI sends a `repository_dispatch` event to `vayada-platform`:

```
event_type: app-image-published
client_payload:
  service: <service-key>       # e.g. "booking-backend"
  ecr_repo: <ecr-repo-name>    # e.g. "vayada-booking-backend"
  image_sha: <git-sha>         # full 40-char commit SHA
  environment: production
```

Platform CI listens for this event and executes the ECS deploy for the named service using the SHA-pinned image.

### Landing status

The landing artifact and App Runner target describe the intended target-stack
contract, not an active deployment path. This repository currently has no
workflow that publishes `apps/landing`, so App Runner does not receive a new
`:latest` image when landing changes merge.

`vayada.com` remains the legacy system and is outside this contract. Do not
deploy `apps/landing` to that hostname or change its DNS or runtime. Landing
publication requires an explicit, reviewed workflow and a target-stack
hostname before the App Runner polling model can be activated.

## Platform CI responsibilities

Platform CI owns ECS deployment:

1. Receive the `app-image-published` dispatch
2. Download the current ECS task definition for the service
3. Render a new task definition revision with the SHA-pinned image
4. Deploy the new revision to the ECS service and wait for stability

Platform CI does **not** build application code or push images to ECR.

## IAM

The `vayada-github-actions-deploy` IAM role is used by both repositories via OIDC. Its policy must grant:

- **App repo**: `ecr:GetAuthorizationToken`, `ecr:BatchCheckLayerAvailability`, `ecr:PutImage`, and related push actions
- **Platform repo**: `ecs:RegisterTaskDefinition`, `ecs:UpdateService`, `ecs:DescribeTaskDefinition`, `ecs:DescribeServices`, and related deploy actions

Each repo should only hold the permissions it needs. Platform repo does not need ECR push; app repo does not need ECS deploy.

## Runtime configuration

Configuration is split across both repositories:

| Type                            | Owner    | Location                                    |
| ------------------------------- | -------- | ------------------------------------------- |
| Plaintext environment variables | Platform | `ecs.tf` `environment` blocks               |
| Secrets                         | Platform | AWS SSM Parameter Store at `/vayada/prod/*` |
| Required env var names          | App      | Each service's README or `.env.example`     |

The app repository documents which environment variables each service requires. The platform repository owns the values and how they are injected.

## ECS lifecycle note

The ECS service resources in Terraform use `lifecycle { ignore_changes = [task_definition] }`. This means Terraform apply does not roll back in-flight CI deploys. Task definition updates are exclusively managed by platform CI, not by `terraform apply`.

## Preview environments

Preview environment artifact handling is not yet defined. It will be specified as part of VAY-423 (platform CI) and VAY-425 (environment documentation). The production contract above is the initial implementation target.
