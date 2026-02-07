# Vayada Booking Engine - Complete Overview

Everything discussed and decided about the booking engine ecosystem: customer frontend, admin dashboard, and backend.

---

## Table of Contents

1. [System Architecture](#1-system-architecture)
2. [Booking Engine Backend](#2-booking-engine-backend)
3. [Customer Frontend](#3-customer-frontend)
4. [Admin Dashboard (Hotel Panel)](#4-admin-dashboard)
5. [Affiliate Tracking System](#5-affiliate-tracking-system)
6. [Promo Code System](#6-promo-code-system)
7. [Stripe Integration](#7-stripe-integration)
8. [PMS Adapters](#8-pms-adapters)
9. [Custom Domains (Future)](#9-custom-domains)
10. [AWS Deployment](#10-aws-deployment)
11. [Implementation Order](#11-implementation-order)
12. [Open Questions](#12-open-questions)

---

## 1. System Architecture

Three separate projects, one shared PostgreSQL database:

| Project | Port | Purpose |
|---------|------|---------|
| `vayada-booking-engine-frontend/` | 3002 | Customer-facing hotel booking |
| `vayada-booking-engine-dashboard/` | 3001* | Hotel admin panel |
| `vayada-booking-engine-backend/` | 8001 | API serving both frontends |

*Admin dashboard port TBD — 3001 conflicts with the marketplace admin. May need 3003.

**Multi-tenancy:** Single backend serves all hotels. Hotels identified by `slug` in URL path or `custom_domain` via Host header. All data scoped to `hotel_id`.

**No guest accounts** — guests provide info at checkout, no login/registration required.

**Database:** Separate PostgreSQL instance on port 5433 (not shared with marketplace DB).

---

## 2. Booking Engine Backend

**Tech stack:** FastAPI (Python), AsyncPG, pydantic-settings, Redis for rate caching, Docker
**Status:** Not yet built. Plan only.

### Project Structure

```
vayada-booking-engine-backend/
├── app/
│   ├── main.py
│   ├── config.py
│   ├── database.py
│   ├── dependencies.py
│   ├── jwt_utils.py
│   ├── models/
│   │   ├── booking.py, hotel.py, room.py, payment.py
│   │   ├── affiliate.py, promo.py, admin.py
│   │   ├── onboarding.py, common.py
│   ├── routers/
│   │   ├── availability.py, bookings.py, payments.py
│   │   ├── affiliates.py, webhooks.py
│   │   ├── admin.py, admin_onboarding.py
│   │   ├── admin_affiliates.py, admin_promo.py
│   ├── services/
│   │   ├── booking_service.py, availability_service.py
│   │   ├── payment_service.py, affiliate_service.py
│   │   ├── promo_service.py, onboarding_service.py
│   │   ├── email_service.py
│   ├── adapters/
│   │   ├── base.py           # Abstract PMS interface
│   │   ├── registry.py       # Factory
│   │   ├── smoobu.py, ezee.py, siteminder.py
│   └── cache/
│       └── redis_client.py
├── migrations/
│   ├── 001_initial_schema.sql
│   ├── 002_affiliates.sql
│   ├── 003_promo_codes.sql
│   └── 004_bookings.sql
├── tests/
├── Dockerfile, docker-compose.yml
├── requirements.txt, .env.example
```

### Database Schema

**booking_hotels:**
```sql
CREATE TABLE booking_hotels (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    marketplace_hotel_id uuid,
    name text NOT NULL,
    slug text NOT NULL UNIQUE,
    custom_domain text UNIQUE,
    custom_domain_status text DEFAULT 'pending',
    timezone text DEFAULT 'UTC',
    currency text DEFAULT 'EUR',
    pms_provider text,
    pms_config jsonb DEFAULT '{}',
    logo_url text,
    primary_color text DEFAULT '#1a1a1a',
    stripe_account_id text,
    stripe_onboarding_complete boolean DEFAULT false,
    onboarding_status text DEFAULT 'pending',
    onboarding_step integer DEFAULT 0,
    onboarding_completed_at timestamptz,
    onboarding_steps_completed jsonb DEFAULT '{
        "basics": false, "domain": false, "pms": false,
        "rooms": false, "payment": false, "branding": false, "review": false
    }',
    status text DEFAULT 'inactive',
    created_at timestamptz DEFAULT now()
);
```

**booking_room_types:**
```sql
CREATE TABLE booking_room_types (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    hotel_id uuid REFERENCES booking_hotels(id),
    pms_room_type_id text,
    name text NOT NULL,
    description text,
    max_occupancy integer DEFAULT 2,
    base_rate decimal(10,2),
    amenities text[],
    images text[],
    status text DEFAULT 'active'
);
```

**booking_hotel_admins:**
```sql
CREATE TABLE booking_hotel_admins (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    hotel_id uuid REFERENCES booking_hotels(id),
    marketplace_user_id uuid,
    email text NOT NULL,
    password_hash text NOT NULL,
    name text NOT NULL,
    role text DEFAULT 'admin',
    status text DEFAULT 'active',
    created_at timestamptz DEFAULT now()
);
```

**booking_affiliate_links:**
```sql
CREATE TABLE booking_affiliate_links (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    marketplace_creator_id uuid NOT NULL,
    hotel_id uuid REFERENCES booking_hotels(id),
    code text NOT NULL UNIQUE,
    commission_rate decimal(5,2) NOT NULL,
    valid_from timestamptz DEFAULT now(),
    valid_until timestamptz,
    status text DEFAULT 'active'
);
```

**booking_affiliate_clicks:**
```sql
CREATE TABLE booking_affiliate_clicks (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    affiliate_link_id uuid REFERENCES booking_affiliate_links(id),
    session_id uuid NOT NULL,
    ip_address text,
    user_agent text,
    referrer_url text,
    created_at timestamptz DEFAULT now()
);
```

**booking_promo_codes:**
```sql
CREATE TABLE booking_promo_codes (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    hotel_id uuid REFERENCES booking_hotels(id),
    code text NOT NULL,
    description text,
    discount_type text NOT NULL,
    discount_value decimal(10,2) NOT NULL,
    min_nights integer,
    min_amount decimal(10,2),
    max_uses integer,
    current_uses integer DEFAULT 0,
    valid_from timestamptz DEFAULT now(),
    valid_until timestamptz,
    status text DEFAULT 'active',
    created_at timestamptz DEFAULT now(),
    UNIQUE(hotel_id, code)
);
```

**bookings:**
```sql
CREATE TABLE bookings (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    booking_reference text NOT NULL UNIQUE,
    hotel_id uuid REFERENCES booking_hotels(id),
    room_type_id uuid REFERENCES booking_room_types(id),
    guest_first_name text NOT NULL,
    guest_last_name text NOT NULL,
    guest_email text NOT NULL,
    guest_phone text,
    guest_country text,
    check_in_date date NOT NULL,
    check_out_date date NOT NULL,
    nights integer NOT NULL,
    adults integer DEFAULT 1,
    children integer DEFAULT 0,
    currency text NOT NULL,
    subtotal_amount decimal(10,2) NOT NULL,
    discount_amount decimal(10,2) DEFAULT 0,
    total_amount decimal(10,2) NOT NULL,
    promo_code_id uuid REFERENCES booking_promo_codes(id),
    affiliate_link_id uuid REFERENCES booking_affiliate_links(id),
    affiliate_session_id uuid,
    affiliate_commission decimal(10,2),
    pms_reservation_id text,
    pms_sync_status text DEFAULT 'pending',
    payment_status text DEFAULT 'pending',
    stripe_payment_intent_id text,
    status text DEFAULT 'pending',
    special_requests text,
    created_at timestamptz DEFAULT now()
);
```

### API Endpoints

**Public (No Auth):**

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/hotels/{slug}` | Hotel info and branding |
| GET | `/hotels/{slug}/rooms` | List room types |
| GET | `/hotels/{slug}/availability` | Search available rooms (query: check_in, check_out, adults, children) |
| POST | `/bookings` | Create booking |
| GET | `/bookings/{reference}` | Get booking by reference (requires email verification) |
| POST | `/bookings/validate-promo` | Validate promo code |
| GET | `/affiliates/track/{code}` | Track affiliate click, returns session_id |
| POST | `/payments/webhook` | Stripe webhook |

**Hotel Admin (JWT Auth):**

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/admin/login` | Admin login |
| GET | `/admin/bookings` | List bookings (filterable by date, status, affiliate) |
| GET | `/admin/bookings/{id}` | Booking detail |
| POST | `/admin/bookings/{id}/cancel` | Cancel booking |
| GET | `/admin/analytics` | Revenue, conversions, affiliate vs direct |
| GET/POST | `/admin/affiliates` | List/create affiliate links |
| GET | `/admin/affiliates/{id}/stats` | Affiliate performance |
| GET/PUT | `/admin/settings` | Hotel settings |
| CRUD | `/admin/promo-codes` | Promo code management |
| GET | `/admin/promo-codes/{id}/stats` | Usage stats |

**Onboarding (JWT Auth):**

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/onboarding/status` | Current progress |
| PUT | `/admin/onboarding/basics` | Step 1: name, currency, timezone |
| PUT | `/admin/onboarding/domain` | Step 2: custom domain or slug |
| PUT | `/admin/onboarding/pms` | Step 3: PMS provider + credentials |
| POST | `/admin/onboarding/pms/test` | Test PMS connection |
| PUT | `/admin/onboarding/rooms` | Step 4: room types |
| POST | `/admin/onboarding/rooms/import` | Import rooms from PMS |
| PUT | `/admin/onboarding/payment` | Step 5: Stripe Connect |
| PUT | `/admin/onboarding/branding` | Step 6: logo, colors |
| GET | `/admin/onboarding/review` | Step 7: summary |
| POST | `/admin/onboarding/activate` | Go live |

### Booking Flow (End-to-End)

1. Customer arrives (possibly via `?ref=SARAH2024`)
2. `GET /affiliates/track/SARAH2024` records click, returns `session_id` stored in cookie (30 days)
3. Customer searches: `GET /hotels/{slug}/availability?check_in=...&check_out=...`
4. Customer optionally validates promo: `POST /bookings/validate-promo`
5. Customer submits booking: `POST /bookings` with guest info, `affiliate_code`, `promo_code`
6. Backend: fetches PMS rates -> subtotal, validates promo -> discount, validates affiliate -> commission, creates Stripe PaymentIntent
7. Frontend completes payment via `stripe.confirmCardPayment()`
8. Stripe webhook `payment_intent.succeeded`: confirms booking, increments promo `current_uses`, syncs to PMS, sends confirmation email

---

## 3. Customer Frontend

**Tech stack:** Next.js 14 + React 18 + TypeScript 5 + Tailwind CSS 3 + Stripe Elements
**Port:** 3002
**Status:** Plan complete, not yet built. Uses mock data initially.

### Project Structure

```
vayada-booking-engine-frontend/
├── app/
│   ├── layout.tsx
│   ├── globals.css
│   ├── page.tsx                       # Hotel landing (/)
│   ├── rooms/page.tsx                 # Room listing (/rooms)
│   ├── availability/page.tsx          # Search + results (/availability)
│   ├── book/page.tsx                  # Checkout (/book)
│   ├── booking/[reference]/page.tsx   # Confirmation (/booking/VBK-XXX)
│   └── my-booking/page.tsx            # Booking lookup (/my-booking)
├── components/
│   ├── ui/                            # Button, Input, Textarea, Select, Modal, Badge
│   ├── layout/                        # BookingNavigation, BookingFooter
│   ├── booking/                       # DatePicker, GuestSelector, GuestForm, PriceBreakdown,
│   │                                    PromoCodeInput, CreatorCodeInput, BookingSummary,
│   │                                    BookingLookupForm, StripePaymentForm, RoomCard
│   ├── hotel/                         # HotelHero, RoomTypeCard, AmenityBadge
│   └── AffiliateTracker.tsx
├── hooks/
│   ├── useAffiliate.ts                # Cookie read/write for affiliate code (30 days)
│   ├── useAvailability.ts             # Search state + results
│   ├── useBookingForm.ts              # Guest form + promo/creator code + submit
│   └── usePromoCode.ts                # Promo code validation state
├── lib/
│   ├── types/index.ts
│   ├── utils/index.ts                 # cn(), formatCurrency, calculateNights, formatDate
│   ├── constants/routes.ts
│   └── mock/
│       ├── hotel.ts                   # Hotel Alpenrose
│       ├── rooms.ts                   # 4 room types
│       ├── availability.ts            # getMockAvailability()
│       └── bookings.ts               # createMockBooking(), lookupMockBooking()
├── services/api/
│   ├── client.ts                      # Simplified ApiClient (no JWT)
│   ├── hotels.ts
│   ├── availability.ts
│   └── bookings.ts
├── public/
│   └── vayada-logo.png
├── package.json, tsconfig.json, tailwind.config.js
├── postcss.config.js, next.config.js
├── Dockerfile, Dockerfile.dev
└── .env.example
```

### Pages

| Route | Description |
|-------|-------------|
| `/` | Hotel landing: hero image with gradient overlay, about section, amenities grid, room preview cards |
| `/rooms` | All room types as cards (image, name, amenities, base rate, "Check Availability" button) |
| `/availability` | Search form (date pickers, guest selector) + available room cards with nightly rate, total, remaining count |
| `/book` | Two-column layout: left = GuestForm + PromoCodeInput + CreatorCodeInput + StripePaymentForm, right = room summary + PriceBreakdown (sticky sidebar). Reads room/dates from URL params |
| `/booking/[reference]` | Green checkmark, booking reference, details table |
| `/my-booking` | Reference + email inputs, lookup button, result display |

### Components (Marketplace Patterns)

UI components replicate marketplace patterns: `forwardRef` + `cn()` utility + variant/size props.

- **Button:** primary/secondary/outline/ghost variants, sm/md/lg sizes, isLoading spinner
- **Input:** label, error, helperText, leadingIcon
- **Textarea:** same pattern as Input
- **Select:** dropdown with same styling
- **Modal:** compound pattern (Modal, ModalHeader, ModalBody, ModalFooter)
- **Badge:** small status/amenity badges

Layout:
- **BookingNavigation:** Fixed top, glassmorphism (bg-white/95 backdrop-blur-sm), hotel name left, "Rooms" / "My Booking" center, no auth
- **BookingFooter:** Dark bg-gray-900, hotel address, legal links

### Mock Data

**Hotel:** Hotel Alpenrose, Innsbruck, Austria, 4-star, EUR

**Rooms:**

| Room | Rate | Max Guests | Size |
|------|------|-----------|------|
| Standard Alpine Room | 120 EUR/night | 2 | 22 sqm |
| Superior Mountain View | 180 EUR/night | 2 | 28 sqm |
| Junior Suite | 280 EUR/night | 3 | 42 sqm |
| Alpine Penthouse Suite | 450 EUR/night | 4 | 65 sqm |

**Promo Codes:**

| Code | Discount | Condition |
|------|----------|-----------|
| SUMMER10 | 10% off | None |
| WELCOME50 | 50 EUR off | Min 3 nights |
| LONGSTAY15 | 15% off | Min 5 nights |

**Creator Codes:**

| Code | Creator |
|------|---------|
| SARAH2024 | Sarah Johnson |
| TRAVELJANE | Jane's Travels |

---

## 4. Admin Dashboard

**Project:** `vayada-booking-engine-dashboard/`
**Status:** Discussed, not yet planned in detail.

### Page Structure

```
app/
├── login/page.tsx
├── register/page.tsx
└── dashboard/
    ├── layout.tsx              # Auth check, sidebar, header
    ├── page.tsx                # Overview
    ├── bookings/
    │   ├── page.tsx            # Booking list (filterable)
    │   └── [id]/page.tsx       # Booking detail
    ├── calendar/page.tsx       # Calendar view
    ├── affiliates/
    │   ├── page.tsx            # List with performance stats
    │   └── create/page.tsx     # Create new affiliate link
    ├── analytics/page.tsx      # Revenue, conversions, reports
    ├── settings/
    │   ├── page.tsx            # General
    │   ├── branding/page.tsx   # Logo, colors, preview
    │   ├── pms/page.tsx        # PMS connection
    │   └── payments/page.tsx   # Stripe
    └── billing/
        ├── page.tsx            # Current plan, usage
        └── invoices/page.tsx
```

### Key Features

**Bookings:** Filterable table (ID, Guest, Dates, Room, Amount, Source: Direct / @creator). CSV export.

**Affiliates:** Per-affiliate cards showing commission %, clicks, bookings, revenue, conversion rate, commission owed. Create links with creator selection + commission %.

**Analytics:** KPI cards (Revenue, Bookings, Conversion Rate, % change vs previous period). Revenue by source (Direct vs per-affiliate breakdown). Revenue chart over time.

**Onboarding Wizard (7 Steps):**
1. Hotel Basics — name, currency, timezone
2. Domain Setup — custom domain or default slug
3. PMS Connection — select provider, enter credentials, test connection
4. Room Types — import from PMS or manual entry
5. Payment — Stripe Connect onboarding
6. Branding — logo, primary color
7. Review & Go Live — summary, preview, activate

Booking page shows "Coming Soon" until onboarding is completed.

**Marketplace Integration:** When a hotel enables booking engine from marketplace, `POST /admin/register` creates records pre-filled from marketplace data and returns onboarding URL.

### Data Isolation

Single codebase serves all hotels. `hotel_id` extracted from JWT on every request. Hotel A can never see Hotel B's data.

---

## 5. Affiliate Tracking System

### Key Concepts

- **Affiliate/Creator Code** (e.g., `SARAH2024`): Tracks which creator referred the booking. Creator earns commission.
- **Promo Code** (e.g., `SUMMER10`): Gives customer a discount. No commission involved.
- Both can be used on the same booking simultaneously.

### Flow

```
1. Creator shares link: https://book.hotel-alpine.com?ref=SARAH2024
2. Customer clicks → AffiliateTracker reads ?ref=SARAH2024
3. Sets cookie: vayada_ref=SARAH2024 (max-age=2592000 = 30 days)
4. Customer browses rooms, selects dates
5. At checkout (/book):
   - CreatorCodeInput is pre-filled with "SARAH2024" from cookie
   - Customer can override, clear, or leave as-is
   - Manual entry overrides cookie value
6. Code sent with booking request → backend tracks commission
```

### Attribution

- **Model:** Last-click wins. Most recent affiliate link click is used.
- **Two input methods:** (1) URL parameter auto-sets cookie, (2) manual entry at checkout
- **Click tracking:** Full details stored in `booking_affiliate_clicks` (not just a counter)

### Commission Calculation

Commission is calculated on the **post-discount** total:

```
Room: 500 EUR
Promo (10% off): -50 EUR
Subtotal: 450 EUR
Affiliate commission (8%): 36 EUR
```

---

## 6. Promo Code System

- Discount types: `percentage` or `fixed`
- Optional constraints: `min_nights`, `min_amount`, `max_uses`
- `current_uses` incremented on successful payment (via Stripe webhook, not on booking creation)
- Date-bounded: `valid_from` / `valid_until`
- Scoped per hotel: `UNIQUE(hotel_id, code)` — same code can exist for different hotels

### Validation Flow

```
1. Customer enters "SUMMER10" in PromoCodeInput
2. POST /bookings/validate-promo → validates code, checks constraints
3. Returns: { code: "SUMMER10", discountType: "percentage", discountValue: 10 }
4. PriceBreakdown updates live:
   - Subtotal: 720 EUR
   - Discount (10% SUMMER10): -72 EUR
   - Total: 648 EUR
```

---

## 7. Stripe Integration

### Customer Frontend

- Uses `@stripe/react-stripe-js` Elements + CardElement
- If `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is missing → renders mock card form with "Test Mode" badge
- **Mock mode:** simulates 1-2s delay, returns fake payment intent ID
- **Real mode:** backend creates PaymentIntent, frontend confirms with `stripe.confirmCardPayment()`

### Backend

- Creates PaymentIntent with amount reflecting promo discount
- Webhook handler for `payment_intent.succeeded`:
  - Confirms booking status
  - Increments promo `current_uses`
  - Calculates affiliate commission
  - Syncs reservation to PMS
  - Sends confirmation email

### Admin Onboarding

- Hotels connect via Stripe Connect during onboarding Step 5
- `stripe_account_id` and `stripe_onboarding_complete` stored on `booking_hotels`

---

## 8. PMS Adapters

### Adapter Pattern

Abstract base class with concrete implementations per provider:

```python
class BasePMSAdapter:
    def get_availability(check_in, check_out, room_type_ids) -> List[RoomAvailability]
    def get_rates(check_in, check_out, room_type_ids) -> List[RateInfo]
    def create_reservation(reservation) -> ReservationResult
    def cancel_reservation(pms_reservation_id) -> ReservationResult
    def get_room_types() -> List[RoomType]
    def test_connection() -> bool
```

Factory registry: `{'ezee': EzeeAdapter, 'smoobu': SmoobuAdapter, 'siteminder': SiteMinderAdapter}`

### PMS Comparison

| PMS | Type | Auth | Format | Best For |
|-----|------|------|--------|----------|
| eZee | Full Hotel PMS | Hotel Code + API Key | JSON | Traditional hotels, MVP |
| Smoobu | Vacation Rental PMS | OAuth 2.0 | JSON | Vacation rentals |
| SiteMinder | Channel Manager | API Key | XML (OTA) | Enterprise chains |

**Decision:** Implement eZee first (has sandbox, most comprehensive for hotels), then Smoobu, then SiteMinder.

All PMS systems require the booking engine to independently handle: payment processing, UI/UX, email notifications, promo codes, multi-currency display, rate caching.

---

## 9. Custom Domains (Future — Phase 7)

Each hotel can optionally have their own domain:
- Custom: `book.hotel-alpine.com`
- Default fallback: `booking.vayada.com/hotels/hotel-alpine`

### Implementation Plan

- DB stores `custom_domain` and `custom_domain_status` ('pending', 'active', 'failed')
- Request resolution: Host header lookup in database
- **Entri Power** for DNS auto-configuration (hotel admins don't manually touch DNS)
- Flow: admin enters domain -> Entri modal opens -> auto DNS + SSL -> webhook confirms

---

## 10. AWS Deployment

| Service | AWS Resource | Spec |
|---------|-------------|------|
| Compute | ECS Fargate | 0.5 vCPU / 1GB per service, auto-scaling |
| Database | RDS PostgreSQL | Multi-AZ, encrypted |
| Cache | ElastiCache Redis | Rate cache, sessions |
| Storage | S3 | Hotel images, static assets |
| CDN | CloudFront | Frontend delivery |
| DNS | Route 53 | Domain management |
| Load Balancer | ALB | Traffic routing |
| Queues | SQS | Payments, notifications, PMS sync |
| Events | SNS | Event fanout |
| Secrets | Secrets Manager | PMS creds, API keys |
| SSL | ACM | Certificates |
| Monitoring | CloudWatch + X-Ray | Logs, tracing |
| Security | WAF | Web application firewall |
| Networking | VPC | Public/private subnets, NAT Gateway |

**Estimated cost:** ~120-150 USD/month to start.

**IaC:** Not needed for MVP. Start with AWS Copilot or manual setup. Add Terraform/CDK when needed for multiple environments or team collaboration.

---

## 11. Implementation Order

| Phase | What | Status |
|-------|------|--------|
| 1 | Customer Frontend (mock data) | Plan complete, not started |
| 2 | Booking Engine Backend | Plan complete, not started |
| 3 | Admin Dashboard | Discussed, not detailed |
| 4 | AWS Deployment | Architecture decided |

Decision was made to build frontend first with mock data, then backend to match the frontend's contract.

---

## 12. Open Questions

- **Admin dashboard port:** 3001 conflicts with marketplace admin
- **Email templates:** Confirmation and cancellation email designs not specified
- **Smoobu + SiteMinder adapters:** After eZee is working
- **Multi-currency conversion:** Rates in property currency, display in guest currency — approach not decided
- **Multi-language / localization:** Mentioned but not planned
- **Vayada billing model:** 49 EUR/month + 1.5% per booking mentioned in dashboard mockups but not in implementation plan
- **Payment providers beyond Stripe:** PayPal mentioned in architecture but not planned
- **Async booking flow:** SQS-based flow in AWS architecture, but simplified to synchronous for MVP
- **Shared component library:** Decided to defer — build independently now, extract `@vayada/ui` later when patterns stabilize across 3+ projects
