# vayada

vayada is a hospitality platform that connects travel creators and influencers with hotels for collaborations, and provides hotels with a direct booking engine and property management system. The platform is composed of three core products — a **Creator Marketplace**, a **Booking Engine**, and a **Property Management System (PMS)** — each with dedicated customer-facing frontends, admin dashboards, and backend APIs, all sharing a centralized authentication system.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Repository Structure](#repository-structure)
- [Tech Stack](#tech-stack)
- [Services](#services)
  - [Creator Marketplace](#creator-marketplace)
  - [Booking Engine](#booking-engine)
  - [Property Management System](#property-management-system)
  - [Shared Authentication](#shared-authentication)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Running Local Development](#running-local-development)
  - [Seeding Test Data](#seeding-test-data)
- [Service Ports](#service-ports)
- [Databases](#databases)
- [Infrastructure](#infrastructure)
- [Environment Variables](#environment-variables)
- [Monorepo App Mapping](#monorepo-app-mapping)
- [Workspace Package Manager](#workspace-package-manager)
- [Scripts](#scripts)
- [Test Accounts](#test-accounts)
- [Development Workflow](#development-workflow)

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              vayada Platform                                │
│                                                                              │
│  ┌──────────────────────┐  ┌──────────────────────┐  ┌───────────────────┐  │
│  │  Creator Marketplace │  │    Booking Engine     │  │        PMS        │  │
│  │                      │  │                       │  │                   │  │
│  │ ┌────────┐ ┌───────┐ │  │ ┌────────┐ ┌───────┐ │  │ ┌───────┐        │  │
│  │ │Frontend│ │ Admin │ │  │ │Frontend│ │ Admin │ │  │ │Frontend│        │  │
│  │ │ :3000  │ │ :3001 │ │  │ │ :3002  │ │ :3003 │ │  │ │ :3004  │        │  │
│  │ └───┬────┘ └───┬───┘ │  │ └───┬────┘ └───┬───┘ │  │ └───┬───┘        │  │
│  │     │          │      │  │     │          │      │  │     │            │  │
│  │ ┌───▼──────────▼────┐ │  │ ┌───▼──────────▼────┐ │  │ ┌───▼──────────┐ │  │
│  │ │ Marketplace API   │ │  │ │  Booking API      │ │  │ │   PMS API    │ │  │
│  │ │     :8000         │ │  │ │     :8001         │ │  │ │    :8002     │ │  │
│  │ └───┬───────────────┘ │  │ └───┬───────────────┘ │  │ └───┬─────────┘ │  │
│  └─────┼────────────────┘  └─────┼────────────────┘  └─────┼───────────┘  │
│        │                         │                          │              │
│  ┌─────▼──────┐ ┌──────────┐ ┌───▼──────┐ ┌───────────┐ ┌──▼──────────┐  │
│  │Marketplace │ │ Auth DB  │ │Booking DB│ │  PMS DB   │ │   MinIO     │  │
│  │ DB :5432   │ │  :5435   │ │  :5434   │ │  :5436    │ │ :9000/:9001 │  │
│  │ PostgreSQL │ │PostgreSQL│ │PostgreSQL│ │PostgreSQL │ │ S3 Storage  │  │
│  └────────────┘ └──────────┘ └──────────┘ └───────────┘ └─────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

The platform follows a microservices architecture:

- **Application services**: Legacy FastAPI backends, the TypeScript `apps/api`, and Next.js frontends
- **Four PostgreSQL databases**: One per domain (marketplace, booking, PMS, auth)
- **MinIO**: S3-compatible object storage for images
- **Shared auth database**: Centralized user management across all services
- **Docker Compose support stack**: Local DBs, MinIO, auth migrations, and legacy FastAPI backends. Next.js frontends and `apps/api` run from npm/portless.

---

## Repository Structure

```
vayada/
├── apps/                               # Product applications
│   ├── api/                                  # TypeScript target/AuthKit backend
│   ├── marketplace-api/                      # Legacy FastAPI marketplace backend
│   ├── marketplace-web/                      # Next.js authenticated marketplace app
│   ├── vayada-admin/                         # Next.js Vayada admin dashboard
│   ├── booking-api/                          # Legacy FastAPI booking backend
│   ├── booking-web/                          # Next.js guest booking frontend
│   ├── booking-admin/                        # Next.js booking admin dashboard
│   ├── pms-api/                              # Legacy FastAPI PMS backend
│   ├── pms-web/                              # Next.js hotel dashboard
│   ├── affiliate-dashboard/                  # Next.js affiliate dashboard
│   └── landing/                              # Next.js public marketing site
│
├── packages/                           # Shared packages (created as needed)
│
├── auth-db/                            # Shared authentication database
│   ├── migrations/                           # Auth schema migrations
│   └── scripts/                              # Migration runner
│
│
├── docs/                               # Product and engineering documentation
│   ├── docs/                                 # Docusaurus product docs
│   └── engineering/                          # Internal engineering notes
│
├── scripts/                            # Seed, migration, and local-dev scripts
│   ├── dev-workos-local.sh                   # Current apps/api + AuthKit local stack
│   ├── dev-portless.sh                       # Transitional legacy FastAPI-backed stack
│   ├── seed_all.py                           # Master seed runner
│   ├── seed_users.py                         # Auth DB user seeds
│   ├── seed_marketplace.py                   # Marketplace DB seeds
│   ├── seed_booking.py                       # Booking + PMS DB seeds
│   └── run_migration.sh                      # Remote migration runner
│
├── docker-compose.yml                  # Local DBs, MinIO, auth migrations, and legacy FastAPI backends
└── README.md
```

---

## Tech Stack

| Layer          | Technology                                                                 |
| -------------- | -------------------------------------------------------------------------- |
| **Backends**   | TypeScript/Node (`apps/api`), Python 3.11/FastAPI legacy APIs              |
| **Frontends**  | Next.js 14 (App Router), React 18, TypeScript                              |
| **Styling**    | Tailwind CSS, PostCSS                                                      |
| **Databases**  | PostgreSQL 15 (Alpine)                                                     |
| **ORM / DB**   | AsyncPG (async PostgreSQL driver)                                          |
| **Auth**       | WorkOS/AuthKit in `apps/api`; legacy JWT/password auth in FastAPI services |
| **Payments**   | Stripe                                                                     |
| **Storage**    | MinIO (S3-compatible), boto3                                               |
| **i18n**       | next-intl (booking engine frontend)                                        |
| **Icons**      | Heroicons React                                                            |
| **Infra**      | AWS (ECS Fargate, ALB, RDS, ECR, Route53, S3)                              |
| **IaC**        | Terraform                                                                  |
| **CI/CD**      | GitHub Actions                                                             |
| **Containers** | Docker, Docker Compose                                                     |

---

## Services

### Creator Marketplace

The marketplace connects travel creators and influencers with hotels for paid collaborations.

**Backend** (`apps/marketplace-api/`) — Port 8000

- User registration and authentication (creators, hotels, admins)
- Creator profiles with social platforms, audience analytics, and portfolio
- Hotel listings with collaboration offerings and creator requirements
- Collaboration workflow: requests, negotiations, deliverables, messaging
- Real-time chat between creators and hotels
- Image upload and processing via MinIO/S3
- Invite codes for hotel onboarding (pre-configured setups)
- GDPR compliance: data export, deletion requests, consent tracking
- Email notifications

**Admin Panel** (`apps/vayada-admin/`) — Port 3001

- Sidebar navigation: Users, Hotels, Marketplace, Collaborations, Invite Codes
- User management (view, edit, approve, reject creators and hotels)
- Hotel booking engine configuration (embedded)
- Marketplace preview (listings and creators)
- Collaboration monitoring
- Invite code creation with full setup wizard (property, branding, rooms, policies, billing terms)

---

### Booking Engine

The booking engine allows hotels to accept direct bookings from guests with a fully customizable, white-label booking experience.

**Backend** (`apps/booking-api/`) — Port 8001

- Hotel configuration with branding, amenities, social links, and translations
- Room type management with images, pricing, and availability
- End-to-end booking flow with guest details and payment
- Affiliate link tracking and commission management
- Multi-currency support with live exchange rates
- Custom domain support (Cloudflare integration)
- Property settings API (including billing plans and payout details)
- Add-on management (transport, wellness, dining, experiences)

**Frontend** (`apps/booking-web/`) — Port 3002

- Hotel landing page with hero, amenities, and room previews
- Room listing with filters, availability search, and detail modals
- Dynamic book-direct benefits per room type
- Checkout flow with guest form and payment
- Booking confirmation and lookup
- Affiliate tracking via URL parameters
- Multi-language support (EN, DE, FR, ES, ID)
- Social media links in footer
- Custom domain resolution

**Admin Dashboard** (`apps/booking-admin/`) — Port 3003

- Dashboard with booking metrics
- Design Studio: hero image, colors, font pairing (live preview)
- Booking Flow: room filters, add-ons, guest details, payment config
- Settings: property info, contact, social media, currency/languages, billing
- Billing tab: view commission/fixed-fee plans, switch for next month, payout details (IBAN)
- Setup wizard (5 steps) with invite code support for pre-filled onboarding

---

### Property Management System

The PMS provides hotel operations management — rooms, bookings, calendar, and channel management.

**Backend** (`apps/pms-api/`) — Port 8002

- Hotel and room type management with seasonal pricing
- Booking management with room assignment
- Calendar with availability blocks
- Public rooms API (serves room data to booking frontend)
- Image upload to S3
- Beds24 channel manager integration (two-way sync)
- Affiliate management and payout scheduling

**Frontend** (`apps/pms-web/`) — Port 3004

- Dashboard with occupancy and revenue metrics
- Room type management with amenities, features, and benefits
- Calendar view with drag-and-drop
- Booking list and detail views
- Settings: hotel info, integrations
- Beds24 connection and room mapping

---

### Shared Authentication

The auth database (`auth-db/`) provides centralized user management for all services.

**Schema tables:**

- `users` — Core user table (email, password hash, name, type, status, avatar)
- `password_reset_tokens` — Token-based password recovery
- `email_verification_codes` — One-time verification codes
- `cookie_consent`, `consent_history` — GDPR consent tracking
- `gdpr_requests` — Data export and deletion requests

**User types:** `hotel`, `creator`, `admin`
**User statuses:** `pending`, `verified`, `rejected`, `suspended`

---

## Getting Started

### Prerequisites

- **Docker** and **Docker Compose** (v2+)
- **Node 24+** and npm
- **portless** for the recommended HTTPS local workflow
- **Python 3.11+** with `asyncpg` and `bcrypt` (for seed scripts)
- **Git**

### Running Local Development

1. **Clone the repository:**

   ```bash
   git clone https://github.com/vayada-marketplace/vayada.git
   cd vayada
   ```

2. **Pick the local entry point:**

   ```bash
   npm install
   npm run dev:workos-local
   ```

   `npm run dev:workos-local` is the current path for AuthKit and next-stack
   work. It starts the Docker support services for the legacy FastAPI APIs, then
   starts `apps/api` (`https://api.localhost`, port `8003`) and the Next.js apps
   through portless. It requires `apps/api/.env` with local WorkOS settings.

   `npm run dev:portless` is the transitional portless path. It starts the
   legacy FastAPI support services and locally configured portless apps without
   WorkOS-specific env wiring or seed bootstrap.

   Run `./scripts/portless-setup.sh` once if portless has not been trusted and
   configured on the machine.

3. **Seed test data:**

   ```bash
   npm run seed:test-data
   ```

4. **Access the applications:**

   | Application             | portless URL                           | Plain-port fallback        |
   | ----------------------- | -------------------------------------- | -------------------------- |
   | TypeScript API          | https://api.localhost                  | http://localhost:8003      |
   | Marketplace Frontend    | https://marketplace.localhost          | http://localhost:3000      |
   | Marketing / Landing     | https://landing.localhost              | http://localhost:3006      |
   | Vayada Admin            | https://admin.localhost                | http://localhost:3001      |
   | Booking Engine Frontend | https://booking.localhost              | http://localhost:3002      |
   | Booking Engine Admin    | https://admin.booking.localhost        | http://localhost:3003      |
   | PMS Frontend            | https://pms.localhost                  | http://localhost:3004      |
   | Marketplace API Docs    | https://api.marketplace.localhost/docs | http://localhost:8000/docs |
   | Booking Engine API Docs | https://api.booking.localhost/docs     | http://localhost:8001/docs |
   | PMS API Docs            | https://api.pms.localhost/docs         | http://localhost:8002/docs |
   | MinIO Console           | n/a                                    | http://localhost:9001      |

Raw `docker compose up -d` has one supported meaning: start Postgres, MinIO,
`auth-db-migrate`, and the legacy FastAPI backends on ports `8000`-`8002`. It
does not build or run `apps/api` or any Next.js frontend. Frontends must run
from the host npm workspace so local `@vayada/*` packages resolve correctly.

For PMS UI testing without portless, run the support services with Compose and
start the PMS frontend from the host workspace:

```bash
docker compose up -d marketplace-postgres booking-postgres auth-postgres pms-postgres auth-db-migrate minio minio-setup marketplace-backend booking-backend pms-backend
npm run seed:test-data
cd apps/pms-web
NEXT_PUBLIC_AUTH_API_URL=http://localhost:8001 \
NEXT_PUBLIC_PMS_API_URL=http://localhost:8002 \
NEXT_PUBLIC_BOOKING_ADMIN_URL=http://localhost:3003 \
NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED=false \
npm run dev
```

Then open `http://localhost:3004`.

---

## Service Ports

| Service                 | Port | Description                            |
| ----------------------- | ---- | -------------------------------------- |
| Marketplace Frontend    | 3000 | Authenticated creator marketplace app  |
| Marketing / Landing     | 3006 | Public marketing site (vayada-landing) |
| Vayada Admin            | 3001 | Platform-wide admin dashboard          |
| Booking Frontend        | 3002 | Guest-facing booking site              |
| Booking Admin           | 3003 | Hotel admin dashboard                  |
| PMS Frontend            | 3004 | Hotel property management              |
| TypeScript API          | 8003 | AuthKit and target backend routes      |
| Marketplace Backend API | 8000 | Marketplace REST API                   |
| Booking Backend API     | 8001 | Booking engine REST API                |
| PMS Backend API         | 8002 | PMS REST API                           |
| Marketplace PostgreSQL  | 5432 | Marketplace database                   |
| Booking PostgreSQL      | 5434 | Booking engine database                |
| Auth PostgreSQL         | 5435 | Shared authentication database         |
| PMS PostgreSQL          | 5436 | PMS database                           |
| MinIO API               | 9000 | S3-compatible object storage           |
| MinIO Console           | 9001 | MinIO web management UI                |

---

## Databases

| Database    | Port | Name                | User                  |
| ----------- | ---- | ------------------- | --------------------- |
| Auth        | 5435 | `vayada_auth_db`    | `vayada_auth_user`    |
| Marketplace | 5432 | `vayada_db`         | `vayada_user`         |
| Booking     | 5434 | `vayada_booking_db` | `vayada_booking_user` |
| PMS         | 5436 | `vayada_pms_db`     | `vayada_pms_user`     |

All databases use PostgreSQL 15 Alpine with UUID primary keys and timestamp columns. Migrations are in each service's `migrations/` directory.

---

## Infrastructure

Production infrastructure is managed with Terraform in the [`vayada-platform`](https://github.com/vayada-marketplace/vayada-platform) repository. This repo owns application code only.

- **AWS ECS Fargate**: All services run as containers
- **Application Load Balancer**: Routes traffic by hostname
- **RDS PostgreSQL**: Single multi-database instance
- **ECR**: Container registries for each service (owned by platform; images built and pushed by app CI)
- **Route53**: DNS for `*.booking.vayada.com`, `pms.vayada.com`, `api.vayada.com`, etc.
- **S3**: Production image storage (`vayada-uploads-prod`)
- **Cloudflare**: Custom domain SSL for hotel booking engines
- **GitHub Actions**: App CI builds, tests, and publishes images; platform CI deploys to ECS

Production domains:

- `*.booking.vayada.com` — Hotel booking engines (wildcard)
- `admin.booking.vayada.com` — Booking admin
- `pms.vayada.com` — PMS frontend
- `booking-api.vayada.com` — Booking API
- `pms-api.vayada.com` — PMS API
- `api.vayada.com` — Marketplace API
- `admin.vayada.com` — Vayada admin

---

## Environment Variables

Key environment variables are configured in `docker-compose.yml` and service `.env` files. Production variable names and values are managed in `vayada-platform`.

### Frontends

| Variable                             | Description                     |
| ------------------------------------ | ------------------------------- |
| `NEXT_PUBLIC_API_URL`                | Backend API base URL            |
| `NEXT_PUBLIC_AUTH_API_URL`           | `apps/api` AuthKit/session API  |
| `NEXT_PUBLIC_BOOKING_WEB_API_URL`    | `apps/api` booking-web BFF API  |
| `NEXT_PUBLIC_PMS_OPERATIONS_API_URL` | `apps/api` PMS operations API   |
| `NEXT_PUBLIC_PLATFORM_MEDIA_API_URL` | `apps/api` media upload API     |
| `NEXT_PUBLIC_PMS_URL`                | PMS API URL (booking admin)     |
| `NEXT_PUBLIC_MARKETPLACE_API_URL`    | Marketplace API (invite codes)  |
| `NEXT_PUBLIC_HOTEL_SLUG`             | Default hotel slug              |
| `NEXT_PUBLIC_BOOKING_ADMIN_URL`      | Booking admin URL (PMS handoff) |

---

## Monorepo App Mapping

Product apps are normal directories under `apps/`. The old app repositories were
imported with path-scoped history. The old standalone repositories are archived
in GitHub; the legacy root product directories were removed from this repo.

| Old path                                              | New monorepo path          |
| ----------------------------------------------------- | -------------------------- |
| `marketplace/vayada-creator-marketplace-backend`      | `apps/marketplace-api`     |
| `marketplace/vayada-creator-marketplace-frontend`     | `apps/marketplace-web`     |
| `marketplace/vayada-admin`                            | `apps/vayada-admin`        |
| `booking-engine/vayada-booking-engine-backend`        | `apps/booking-api`         |
| `booking-engine/vayada-booking-engine-frontend`       | `apps/booking-web`         |
| `booking-engine/vayada-booking-engine-frontend-admin` | `apps/booking-admin`       |
| `pms/vayada-pms-backend`                              | `apps/pms-api`             |
| `pms/vayada-pms-frontend`                             | `apps/pms-web`             |
| `affiliate/vayada-affiliate-dashboard`                | `apps/affiliate-dashboard` |
| `marketing/vayada-landing`                            | `apps/landing`             |

---

## Workspace Package Manager

The monorepo uses **npm workspaces** at the repository root.

The initial workspace migration preserves each app's existing `package-lock.json`
and app-local npm workflow, while adding a root `package-lock.json` for
reproducible workspace installs. You can still run `npm install` and
`npm run dev/build/lint` from an individual frontend app.

Root workspace commands are available for orchestration:

```bash
npm ci
npm run dev:booking-web
npm run build:booking-web
npm run lint:booking-web
npm run build
npm run lint
npm run typecheck
```

Workspace layout:

| Path         | Purpose                                      |
| ------------ | -------------------------------------------- |
| `apps/*`     | Product apps                                 |
| `docs`       | Docusaurus docs app                          |
| `packages/*` | Future shared JavaScript/TypeScript packages |

Python apps remain outside npm workspaces and continue to use
`requirements.txt`, pytest, and their app-local Python commands.

See `engineering/workspace-package-manager.md` for the decision record.

---

## Scripts

| Script                | Description                                                                       |
| --------------------- | --------------------------------------------------------------------------------- |
| `seed_test_data.sh`   | Checks local seed dependencies and runs all test-data seeds                       |
| `dev-workos-local.sh` | Current local stack: Compose support services, `apps/api`, and portless frontends |
| `dev-portless.sh`     | Transitional stack: Compose support services and locally configured portless apps |
| `seed_all.py`         | Runs all seeds in sequence (users, marketplace, booking)                          |
| `seed_users.py`       | Creates admin, creator, and hotel users in auth DB                                |
| `seed_marketplace.py` | Creates creator profiles, hotel listings, collaborations                          |
| `seed_booking.py`     | Creates hotels, room types, translations, sample bookings                         |
| `run_migration.sh`    | Runs migrations against AWS RDS for a given service                               |

All seed scripts use `asyncpg` and are idempotent (safe to run multiple times).

---

## Test Accounts

After running `npm run seed:test-data`:

| Email             | Password  | Type    | Notes                        |
| ----------------- | --------- | ------- | ---------------------------- |
| admin@vayada.com  | Vayada123 | admin   | Full admin access            |
| creator1@mock.com | Test1234  | creator | Verified, with platforms     |
| creator2@mock.com | Test1234  | creator | Verified                     |
| creator3@mock.com | Test1234  | creator | Pending                      |
| creator4@mock.com | Test1234  | creator | Verified                     |
| hotel1@mock.com   | Test1234  | hotel   | Hotel Alpenrose (EUR)        |
| hotel2@mock.com   | Test1234  | hotel   | Grand Hotel Riviera (USD)    |
| hotel3@mock.com   | Test1234  | hotel   | The Birchwood Lodge (GBP)    |
| hotel4@mock.com   | Test1234  | hotel   | City Center Hotel (minimal)  |
| hotel5@mock.com   | Test1234  | hotel   | Seaside Retreat (no booking) |

---

## Development Workflow

### Working on a single service

Each app can be developed independently:

```bash
# Backend
cd apps/pms-api
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8002

# Frontend
cd apps/booking-web
npm install && npm run dev
```

### Running only databases

```bash
docker compose up -d marketplace-postgres booking-postgres auth-postgres pms-postgres minio minio-setup
```

### Compose support stack

```bash
docker compose up -d        # Start DBs, MinIO, auth migrations, and legacy FastAPI backends
docker compose down          # Stop support services
docker compose down -v       # Stop support services and remove volumes
```
