# Vayada

Vayada is a hospitality platform that connects travel creators and influencers with hotels for collaborations, and provides hotels with a direct booking engine for their guests. The platform is composed of two core products — a **Creator Marketplace** and a **Booking Engine** — each with dedicated customer-facing frontends, admin dashboards, and backend APIs, all sharing a centralized authentication system.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Repository Structure](#repository-structure)
- [Tech Stack](#tech-stack)
- [Services](#services)
  - [Creator Marketplace](#creator-marketplace)
  - [Booking Engine](#booking-engine)
  - [Shared Authentication](#shared-authentication)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Running the Full Stack](#running-the-full-stack)
  - [Seeding Test Data](#seeding-test-data)
- [Service Ports](#service-ports)
- [Databases](#databases)
  - [Auth Database](#auth-database)
  - [Marketplace Database](#marketplace-database)
  - [Booking Engine Database](#booking-engine-database)
- [Environment Variables](#environment-variables)
- [Git Submodules](#git-submodules)
- [Scripts](#scripts)
- [Documentation](#documentation)
- [Test Accounts](#test-accounts)
- [Development Workflow](#development-workflow)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            Vayada Platform                              │
│                                                                         │
│  ┌─────────────────────────────┐    ┌─────────────────────────────────┐ │
│  │     Creator Marketplace     │    │        Booking Engine           │ │
│  │                             │    │                                 │ │
│  │  ┌─────────┐ ┌───────────┐ │    │  ┌─────────┐ ┌───────────────┐ │ │
│  │  │Frontend │ │Admin Panel│ │    │  │Frontend │ │  Admin Panel  │ │ │
│  │  │ :3000   │ │  :3001    │ │    │  │ :3002   │ │    :3003      │ │ │
│  │  └────┬────┘ └─────┬─────┘ │    │  └────┬────┘ └──────┬────────┘ │ │
│  │       │             │       │    │       │              │          │ │
│  │  ┌────▼─────────────▼─────┐ │    │  ┌────▼──────────────▼───────┐ │ │
│  │  │   Marketplace Backend  │ │    │  │   Booking Backend         │ │ │
│  │  │       :8000            │ │    │  │       :8001               │ │ │
│  │  └────┬───────────────────┘ │    │  └────┬──────────────────────┘ │ │
│  └───────┼─────────────────────┘    └───────┼────────────────────────┘ │
│          │                                  │                          │
│  ┌───────▼──────┐  ┌──────────────┐  ┌──────▼───────┐                 │
│  │ Marketplace  │  │  Auth DB     │  │  Booking DB  │                 │
│  │   DB :5432   │  │   :5435      │  │    :5434     │                 │
│  │  PostgreSQL  │  │  PostgreSQL  │  │  PostgreSQL  │                 │
│  └──────────────┘  └──────────────┘  └──────────────┘                 │
│                                                                         │
│  ┌──────────────┐                                                      │
│  │    MinIO      │  S3-compatible object storage                       │
│  │  :9000/:9001  │  for image uploads                                  │
│  └──────────────┘                                                      │
└─────────────────────────────────────────────────────────────────────────┘
```

The platform follows a microservices architecture:

- **Six application services**: Two backends (FastAPI) and four frontends (Next.js)
- **Three PostgreSQL databases**: One per domain (marketplace, booking, auth)
- **MinIO**: S3-compatible object storage for creator and hotel images
- **Shared auth database**: Centralized user management across all services
- **Docker Compose orchestration**: All services managed through a single compose file

---

## Repository Structure

```
vayada/
├── booking-engine/                     # Booking engine product
│   ├── vayada-booking-engine-backend/        # FastAPI backend (submodule)
│   ├── vayada-booking-engine-frontend/       # Next.js guest frontend (submodule)
│   ├── vayada-booking-engine-frontend-admin/ # Next.js admin dashboard (submodule)
│   ├── docs/                                 # Booking engine documentation
│   │   ├── booking-engine-overview.md
│   │   └── pms-comparison-report.md
│   └── docker/                               # Docker configuration
│
├── marketplace/                        # Creator marketplace product
│   ├── vayada-creator-marketplace-backend/        # FastAPI backend (submodule)
│   ├── vayada-creator-marketplace-frontend/       # Next.js public frontend (submodule)
│   ├── vayada-creator-marketplace-frontend-admin/ # Next.js admin dashboard (submodule)
│   ├── docs/                                      # Marketplace documentation
│   └── docker/                                    # Docker configuration
│
├── auth-db/                            # Shared authentication database
│   ├── migrations/
│   │   └── 001_auth_schema.sql               # Auth schema (users, GDPR, consent)
│   └── migrate_remote.sh                     # Remote migration script
│
├── scripts/                            # Seed and utility scripts
│   ├── seed_all.py                           # Master seed runner
│   ├── seed_users.py                         # Auth DB user seeds
│   ├── seed_marketplace.py                   # Marketplace DB seeds
│   └── seed_booking.py                       # Booking DB seeds
│
├── tickets/                            # Technical tickets and plans
│   └── 001_repository_pattern_refactor.md
│
├── docker-compose.yml                  # Full-stack orchestration
├── .gitmodules                         # Submodule definitions
└── README.md
```

---

## Tech Stack

| Layer           | Technology                                      |
|-----------------|------------------------------------------------|
| **Backends**    | Python 3.11, FastAPI 0.104, Uvicorn (ASGI)    |
| **Frontends**   | Next.js 14 (App Router), React 18, TypeScript  |
| **Styling**     | Tailwind CSS 3.3, PostCSS                      |
| **Databases**   | PostgreSQL 15 (Alpine)                         |
| **ORM / DB**    | AsyncPG 0.30 (async PostgreSQL driver)         |
| **Auth**        | PyJWT, bcrypt, python-jose (JWT-based)         |
| **Payments**    | Stripe (React Stripe.js + Stripe.js)           |
| **Storage**     | MinIO (S3-compatible), boto3                   |
| **Images**      | Pillow (server-side processing)                |
| **i18n**        | next-intl (booking engine)                     |
| **Icons**       | Heroicons React 2                              |
| **Containers**  | Docker, Docker Compose                         |
| **Validation**  | Pydantic 2.10                                  |

---

## Services

### Creator Marketplace

The marketplace connects travel creators and influencers with hotels for paid collaborations.

**Backend** (`marketplace/vayada-creator-marketplace-backend/`) — Port 8000

- User registration and authentication (creators, hotels, admins)
- Creator profiles with platforms, categories, and portfolio
- Hotel listings with location, amenities, and contact details
- Collaboration workflow: requests, negotiations, deliverables, messaging
- Real-time chat between creators and hotels
- Image upload and processing via MinIO/S3
- Admin user management and approval workflows
- GDPR compliance: data export requests, deletion requests, consent tracking
- Email notifications for verification, password reset, and collaboration events

**API Routes:**
- `/auth/*` — Registration, login, email verification, password reset
- `/creators/*` — Creator profiles, stats, collaborations
- `/hotels/*` — Hotel listings, search, profiles
- `/marketplace/*` — Discovery, listings, search
- `/collaborations/*` — Collaboration requests, negotiations, messages
- `/chat/*` — Real-time conversations and messages
- `/upload/*` — Image upload to MinIO
- `/admin/*` — User management, approvals
- `/consent/*`, `/gdpr/*` — GDPR compliance endpoints

**Frontend** (`marketplace/vayada-creator-marketplace-frontend/`) — Port 3000

- Landing page with hero sections for creators and hotels
- Marketplace discovery and search
- Creator and hotel profile pages
- Responsive design with Tailwind CSS

**Admin Panel** (`marketplace/vayada-creator-marketplace-frontend-admin/`) — Port 3001

- Admin authentication
- User management (view, edit, approve, deny creators and hotels)
- User filtering and search
- Status management for pending registrations

---

### Booking Engine

The booking engine allows hotels to accept direct bookings from guests, manage reservations, track affiliates, and customize their booking experience.

**Backend** (`booking-engine/vayada-booking-engine-backend/`) — Port 8001

- Hotel configuration with branding, amenities, social links, and translations
- Room type management with images, pricing, and availability
- End-to-end booking flow with guest details and Stripe payment
- Affiliate link tracking and commission management
- Promo code validation and discount application
- Multi-currency support with exchange rates
- Hotel onboarding wizard (7-step setup)
- Admin analytics: revenue, conversions, booking breakdowns
- PMS (Property Management System) adapter pattern (eZee, Smoobu, SiteMinder)

**API Routes:**
- `/hotels/{slug}` — Public hotel profile by slug
- `/hotels/{slug}/rooms` — Room types and availability
- `/hotels/{slug}/availability` — Date-based availability search
- `/bookings` — Create and manage bookings
- `/bookings/{reference}` — Booking lookup by reference
- `/bookings/validate-promo` — Promo code validation
- `/affiliates/track/{code}` — Affiliate click tracking
- `/payments/webhook` — Stripe webhook handler
- `/admin/*` — Login, bookings, analytics, affiliates, settings, onboarding

**Frontend** (`booking-engine/vayada-booking-engine-frontend/`) — Port 3002

- Hotel landing page with hero image, about section, amenities, and room previews
- Room listing page with detailed room cards
- Availability search with date picker and guest selector
- Checkout flow with guest form, promo code input, and Stripe payment
- Booking confirmation with reference number
- Booking lookup by reference and email
- Affiliate tracking via URL parameters
- Internationalization support via next-intl

**Admin Dashboard** (`booking-engine/vayada-booking-engine-frontend-admin/`) — Port 3003

- Admin login and registration
- Dashboard overview with key metrics
- Bookings management: list, detail view, cancellation
- Calendar view for reservations
- Affiliate management: create links, track performance, view commissions
- Analytics: revenue charts, conversion rates, booking breakdowns
- Settings: general hotel info, branding/design, PMS integration, payment config
- Billing section
- Onboarding wizard (7 steps): basics, domain, PMS, rooms, payment, branding, review

---

### Shared Authentication

The auth database (`auth-db/`) provides centralized user management for all services.

**Schema tables:**
- `users` — Core user table (email, password hash, name, type, status, avatar, consent)
- `password_reset_tokens` — Token-based password recovery
- `email_verification_codes` — One-time verification codes
- `email_verification_tokens` — Long-lived verification tokens
- `cookie_consent` — Per-visitor cookie preferences
- `consent_history` — Audit trail of all consent changes
- `gdpr_requests` — Data export and deletion requests

**User types:** `hotel`, `creator`, `admin`
**User statuses:** `pending`, `verified`, `rejected`, `suspended`

Both backends connect to the shared auth database for login, registration, and user verification, ensuring a single source of truth for user identity across the platform.

---

## Getting Started

### Prerequisites

- **Docker** and **Docker Compose** (v2+)
- **Python 3.11+** (for running seed scripts)
- **Node.js 18+** and **npm** (for local frontend development)
- **Git** (with submodule support)

### Running the Full Stack

1. **Clone the repository with submodules:**

   ```bash
   git clone --recurse-submodules https://github.com/FlamurMaliqi/vayada.git
   cd vayada
   ```

   If already cloned without submodules:
   ```bash
   git submodule update --init --recursive
   ```

2. **Start all services:**

   ```bash
   docker compose up -d
   ```

   This starts all 10 services: 3 databases, MinIO + setup, 2 backends, and 4 frontends.

3. **Verify services are running:**

   ```bash
   docker compose ps
   ```

4. **Access the applications:**

   | Application               | URL                        |
   |---------------------------|----------------------------|
   | Marketplace Frontend      | http://localhost:3000       |
   | Marketplace Admin Panel   | http://localhost:3001       |
   | Booking Engine Frontend   | http://localhost:3002       |
   | Booking Engine Admin      | http://localhost:3003       |
   | Marketplace API Docs      | http://localhost:8000/docs  |
   | Booking Engine API Docs   | http://localhost:8001/docs  |
   | MinIO Console             | http://localhost:9001       |

### Seeding Test Data

After the databases are running, populate them with test data:

```bash
# Install Python dependency
pip install asyncpg

# Seed everything (users, marketplace data, booking data)
python scripts/seed_all.py

# Or seed individually:
python scripts/seed_users.py       # Auth DB: admin, creators, hotels
python scripts/seed_marketplace.py # Marketplace DB: profiles, listings
python scripts/seed_booking.py     # Booking DB: hotels, rooms, settings
```

---

## Service Ports

| Service                       | Port  | Description                          |
|-------------------------------|-------|--------------------------------------|
| Marketplace Frontend          | 3000  | Public marketplace site              |
| Marketplace Admin             | 3001  | Marketplace admin dashboard          |
| Booking Frontend              | 3002  | Guest-facing booking site            |
| Booking Admin                 | 3003  | Hotel admin dashboard                |
| Marketplace Backend API       | 8000  | Marketplace REST API                 |
| Booking Backend API           | 8001  | Booking engine REST API              |
| Marketplace PostgreSQL        | 5432  | Marketplace database                 |
| Booking PostgreSQL            | 5434  | Booking engine database              |
| Auth PostgreSQL               | 5435  | Shared authentication database       |
| MinIO API                     | 9000  | S3-compatible object storage         |
| MinIO Console                 | 9001  | MinIO web management UI              |

---

## Databases

### Auth Database

- **Host:** localhost:5435
- **Database:** `vayada_auth_db`
- **User:** `vayada_auth_user`
- **Password:** `vayada_auth_password`

Tables: `users`, `password_reset_tokens`, `email_verification_codes`, `email_verification_tokens`, `cookie_consent`, `consent_history`, `gdpr_requests`

All tables use UUID primary keys and include created/updated timestamps. The `users` table enforces constraints on `type` (hotel/creator/admin) and `status` (pending/verified/rejected/suspended).

### Marketplace Database

- **Host:** localhost:5432
- **Database:** `vayada_db`
- **User:** `vayada_user`
- **Password:** `vayada_password`

Contains 28 migrations covering creators, hotels, collaborations, deliverables, chat/messaging, marketplace listings, and GDPR-related tables.

### Booking Engine Database

- **Host:** localhost:5434
- **Database:** `vayada_booking_db`
- **User:** `vayada_booking_user`
- **Password:** `vayada_booking_password`

Tables include: `booking_hotels` (hotel configuration, branding, translations, settings, notifications, supported currencies), room types, bookings, affiliate links, affiliate clicks, promo codes, and admin users. Schema defined across 6 migrations.

---

## Environment Variables

### Marketplace Backend

| Variable            | Default                           | Description                    |
|---------------------|-----------------------------------|--------------------------------|
| `DATABASE_URL`      | PostgreSQL connection string      | Marketplace database           |
| `AUTH_DATABASE_URL`  | PostgreSQL connection string      | Auth database                  |
| `JWT_SECRET`        | —                                 | JWT signing secret             |
| `MINIO_ENDPOINT`    | `localhost:9000`                  | MinIO S3 endpoint              |
| `MINIO_ACCESS_KEY`  | `minioadmin`                      | MinIO access key               |
| `MINIO_SECRET_KEY`  | `minioadmin`                      | MinIO secret key               |
| `MINIO_BUCKET`      | `vayada-uploads`                  | Upload bucket name             |

### Booking Backend

| Variable                 | Default                       | Description                    |
|--------------------------|-------------------------------|--------------------------------|
| `DATABASE_URL`           | PostgreSQL connection string  | Booking database               |
| `AUTH_DATABASE_URL`       | PostgreSQL connection string  | Auth database                  |
| `MARKETPLACE_DATABASE_URL`| PostgreSQL connection string | Marketplace database (cross-ref)|
| `JWT_SECRET`             | —                             | JWT signing secret             |
| `STRIPE_SECRET_KEY`      | —                             | Stripe API secret key          |
| `STRIPE_WEBHOOK_SECRET`  | —                             | Stripe webhook signing secret  |

### Frontends

| Variable              | Default                    | Service               |
|-----------------------|----------------------------|-----------------------|
| `NEXT_PUBLIC_API_URL` | `http://localhost:8000`    | Marketplace frontend  |
| `NEXT_PUBLIC_API_URL` | `http://localhost:8001`    | Booking frontend      |
| `NEXT_PUBLIC_HOTEL_SLUG` | `hotel-alpenrose`       | Booking frontend      |

---

## Git Submodules

This repository uses Git submodules to manage the six application codebases:

| Submodule                                            | Path                                                    |
|------------------------------------------------------|---------------------------------------------------------|
| `vayada-booking-engine-backend`                      | `booking-engine/vayada-booking-engine-backend`          |
| `vayada-booking-engine-frontend`                     | `booking-engine/vayada-booking-engine-frontend`         |
| `vayada-booking-engine-frontend-admin`               | `booking-engine/vayada-booking-engine-frontend-admin`   |
| `vayada-creator-marketplace-backend`                 | `marketplace/vayada-creator-marketplace-backend`        |
| `vayada-creator-marketplace-frontend`                | `marketplace/vayada-creator-marketplace-frontend`       |
| `vayada-creator-marketplace-frontend-admin`          | `marketplace/vayada-creator-marketplace-frontend-admin` |

**Common submodule commands:**

```bash
# Initialize and pull all submodules
git submodule update --init --recursive

# Pull latest changes for all submodules
git submodule update --remote --merge

# Check submodule status
git submodule status
```

---

## Scripts

The `scripts/` directory contains Python seed scripts for populating databases with test data.

| Script                 | Target Database | Description                                            |
|------------------------|-----------------|--------------------------------------------------------|
| `seed_all.py`          | All             | Master script — runs all seeds in sequence             |
| `seed_users.py`        | Auth (5435)     | Creates admin, creator, and hotel test users           |
| `seed_marketplace.py`  | Marketplace (5432) | Creates creator profiles, hotel listings, collaborations |
| `seed_booking.py`      | Booking (5434)  | Creates 5 test hotels with rooms, settings, and branding |

All scripts use `asyncpg` for async database access and are idempotent (safe to run multiple times).

---

## Documentation

Additional documentation is available in the following locations:

| Document                                          | Description                                            |
|---------------------------------------------------|--------------------------------------------------------|
| `booking-engine/docs/booking-engine-overview.md`  | Complete booking engine architecture and API spec      |
| `booking-engine/docs/pms-comparison-report.md`    | PMS provider comparison (eZee, Smoobu, SiteMinder)     |
| `marketplace/vayada-creator-marketplace-backend/README.md` | Marketplace backend setup and API docs        |
| `marketplace/vayada-creator-marketplace-frontend/README.md` | Marketplace frontend setup                   |
| `marketplace/vayada-creator-marketplace-frontend-admin/README.md` | Marketplace admin panel setup          |
| `tickets/001_repository_pattern_refactor.md`      | Technical ticket: repository pattern refactoring       |

Backend APIs include interactive documentation:

- **Marketplace API (Swagger):** http://localhost:8000/docs
- **Marketplace API (ReDoc):** http://localhost:8000/redoc
- **Booking API (Swagger):** http://localhost:8001/docs
- **Booking API (ReDoc):** http://localhost:8001/redoc

---

## Test Accounts

After running the seed scripts, the following accounts are available:

### Admin

| Email              | Password    | Type  | Status   |
|--------------------|-------------|-------|----------|
| admin@vayada.com   | Vayada123   | admin | verified |

### Creators

| Email              | Password | Status   |
|--------------------|----------|----------|
| creator1@mock.com  | Test1234 | verified |
| creator2@mock.com  | Test1234 | verified |
| creator3@mock.com  | Test1234 | verified |
| creator4@mock.com  | Test1234 | pending  |

### Hotels

| Email            | Password | Status   | Booking Engine Hotel        |
|------------------|----------|----------|-----------------------------|
| hotel1@mock.com  | Test1234 | verified | Hotel Alpenrose (EUR)       |
| hotel2@mock.com  | Test1234 | verified | Grand Hotel Riviera (USD)   |
| hotel3@mock.com  | Test1234 | verified | The Birchwood Lodge          |
| hotel4@mock.com  | Test1234 | verified | City Center Hotel            |
| hotel5@mock.com  | Test1234 | pending  | Seaside Retreat              |

---

## Development Workflow

### Working on a single service

Each submodule can be developed independently. Navigate into the submodule directory and follow its own README for local development setup.

**Backend example:**
```bash
cd marketplace/vayada-creator-marketplace-backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

**Frontend example:**
```bash
cd booking-engine/vayada-booking-engine-frontend
npm install
npm run dev
```

### Running only databases

To work on services locally while only running databases in Docker:

```bash
docker compose up -d marketplace-postgres booking-postgres auth-postgres minio minio-setup
```

### Stopping all services

```bash
docker compose down
```

To also remove database volumes:

```bash
docker compose down -v
```
