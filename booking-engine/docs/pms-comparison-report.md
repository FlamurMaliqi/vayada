# PMS Comparison Report & Booking Engine Responsibilities

## Overview

Analysis of three Property Management Systems (PMS) to understand their capabilities and what a booking engine needs to implement independently.

---

## 1. Smoobu

**Type:** Vacation Rental PMS / Channel Manager
**Documentation:** https://docs.smoobu.com/

### What Smoobu Provides

| Feature | Description |
|---------|-------------|
| Reservation Management | Create, update, cancel bookings with guest details |
| Availability Checking | Check availability for date ranges with pricing |
| Rate Management | Daily rates, minimum stay rules, bulk updates |
| Property Details | Location, amenities, capacity, equipment, timezone |
| Guest Profiles | Contact info, booking history storage |
| Guest Messaging | Send messages with subjects, HTML/plain-text content |
| Online Check-In | Multi-language check-in workflows, smart lock PINs |
| Price Elements | Itemized charges (base price, cleaning fees, addons, discounts) |
| Webhooks | Event notifications for real-time updates |
| OAuth 2.0 | Secure authentication for partner applications |

### What Booking Engine Must Handle

| Component | Notes |
|-----------|-------|
| Payment Processing | Integrate Stripe, PayPal, etc. |
| Search UI & Filtering | Property search, date selection, guest counts |
| Shopping Cart / Checkout | Multi-step booking flow |
| User Authentication | Guest accounts, login, registration |
| Promo Codes / Discounts | Custom discount logic beyond API capabilities |
| Email Templates & Branding | Customize confirmation emails |
| Calendar UI Rendering | Visual availability display |
| Multi-currency Conversion | Display prices in guest's currency |
| Booking Confirmation Pages | Post-booking UI |
| Rate Limiting Management | 1,000 requests/minute limit |

### Strengths
- Full guest messaging system
- Online check-in with smart lock PIN support
- Detailed price breakdowns with addons/discounts
- Good for vacation rentals and short-term properties

---

## 2. SiteMinder SiteConnect

**Type:** Channel Manager / Distribution Platform (OTA Standard)
**Documentation:** https://developer.siteminder.com/siteminder-apis/channels/introduction/siteconnect

### What SiteMinder Provides

| Feature | Description |
|---------|-------------|
| Real-time Rate Pushes | Instant rate updates from properties |
| Availability Sync | Real-time inventory synchronization |
| Restriction Updates | Min stay, close to arrival/departure rules |
| Reservation Relay | Booking/modification/cancellation forwarding |
| PMS/RMS/CRS Connection | Single connection to property systems |
| Enterprise SLA | 99.95% uptime guarantee |
| Security | ISO 27001 compliance, end-to-end encryption |
| OTA Standards | Open Travel Alliance compliant |

### What Booking Engine Must Handle

| Component | Notes |
|-----------|-------|
| OTA XML Standards | Implement industry-standard messaging |
| ARI Caching | Cache Availability, Rates, Inventory locally |
| Full Reservation Logic | Complete booking creation system |
| Payment Processing | All payment gateway integration |
| Guest Management | Profiles, history, preferences |
| All UI/UX Components | Search, booking, confirmation flows |
| Messaging & Notifications | Email, SMS notifications |
| Error Handling | Robust retry and fallback logic |

### Strengths
- Enterprise-grade infrastructure
- Connects to thousands of properties via single integration
- OTA-standard compliant (industry standard)
- Best for connecting to hotels already using SiteMinder

### Notes
This is primarily a **distribution layer** rather than a full PMS. It pushes/receives data between properties and channels. Requires significantly more development work from the booking engine.

---

## 3. eZee Technosys (YCS Connectivity)

**Type:** Full Hotel PMS
**Documentation:** https://api.ezeetechnosys.com/

### What eZee Provides

| Feature | Description |
|---------|-------------|
| Room Configuration | Room types, rate types, rate plans |
| Availability & Restrictions | Inventory by room type and date range |
| Reservation Processing | Full booking management |
| Guest Check-in/Check-out | Operational guest management |
| Guest Profiles | Identity documents, contact info |
| Additional Charges | Extras and add-on calculations |
| Housekeeping Status | Room status management |
| Payment Config | Payment gateway configuration retrieval |
| Travel Agent Verification | B2B authentication |
| Sandbox Environment | Testing environment available |
| Multiple Formats | XML, JSON, CSV response support |

### What Booking Engine Must Handle

| Component | Notes |
|-----------|-------|
| Payment Gateway Integration | Process actual payments |
| Search & Booking UI | Property search, availability display |
| Shopping Cart Flow | Multi-room, multi-night bookings |
| Email Notifications | Confirmation, reminder emails |
| User Accounts | Guest registration, login, history |
| Multi-language Support | Localization |
| Currency Conversion | Display in guest currency |
| Promo/Voucher System | Discount codes |
| Booking Confirmation Pages | Post-booking experience |

### Strengths
- Most comprehensive hotel-focused PMS
- Includes operational features (housekeeping, POS, kiosk)
- Good sandbox environment for development
- Strong for traditional hotel properties

---

## Summary: Universal Booking Engine Requirements

Across all three PMS systems, a booking engine must independently implement:

| Component | Priority | Notes |
|-----------|----------|-------|
| **Payment Processing** | Critical | None handle actual payments - integrate Stripe, PayPal, Adyen, etc. |
| **User Interface** | Critical | Search, calendar, checkout, confirmation pages |
| **User Accounts** | High | Guest login, booking history, profile management |
| **Email/SMS Notifications** | High | Smoobu has messaging, but custom templates needed |
| **Promo Codes/Vouchers** | Medium | Custom discount logic beyond PMS rate rules |
| **Multi-currency Display** | Medium | Rates usually in property currency |
| **Rate Caching** | Medium | Especially for SiteMinder - reduce API calls |
| **Error Handling** | High | Graceful fallbacks, retry logic, timeout handling |
| **Logging & Monitoring** | High | Track API calls, failures, booking funnel |

---

## Recommendation Matrix

| Use Case | Recommended PMS | Reason |
|----------|-----------------|--------|
| Vacation Rentals | **Smoobu** | Built for short-term rentals, good messaging |
| Traditional Hotels | **eZee** | Comprehensive hotel operations |
| Enterprise/Chain Hotels | **SiteMinder** | Industry standard, existing integrations |
| Quick MVP | **Smoobu** or **eZee** | More out-of-the-box functionality |
| Maximum Control | **SiteMinder** | Distribution layer only, build everything else |

---

## API Rate Limits & Technical Notes

| PMS | Rate Limit | Auth Method | Response Format |
|-----|------------|-------------|-----------------|
| Smoobu | 1,000 req/min | OAuth 2.0 | JSON |
| SiteMinder | Not specified | API Key | XML (OTA) |
| eZee | Not specified | Hotel Code + API Key | JSON, XML, CSV |

---

*Report generated: 2026-02-05*
