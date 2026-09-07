# VAY-910 release verification

Local verification on 2026-09-06, rebased onto main `864fa5f5f`. Scope and accepted
per-room cancellation decision: [mixed-room contract](mixed-room-booking-contract.md).
The activation change is last in the dependency stack; merge/deployment and human
acceptance remain separate gates.

## Evidence

| Check                                                      | Result                                                                                    |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Root workspace build and typecheck                         | Passed, including Booking Web, Booking Admin, PMS, API and shared consumers               |
| API production TypeScript build after integration fixes    | Passed                                                                                    |
| Fresh PostgreSQL 17 migration runner                       | All 0001–0164 applied in order                                                            |
| API suite without database URL                             | 3,408 passed; 644 database-dependent tests skipped                                        |
| Dedicated mixed inventory and pending-edit database suites | 42 passed on fully migrated isolated PostgreSQL                                           |
| Finance read-model database suites                         | 6 passed                                                                                  |
| Booking / PMS / Distribution domain suites                 | 156 / 230 / 96 passed                                                                     |
| Booking Web unit suite                                     | 74 passed                                                                                 |
| Booking Web browser pilot                                  | 92 passed, mocked APIs                                                                    |
| Booking Admin / PMS host browser scenarios                 | 5 passed across full run and focused reruns, mocked auth/APIs, production frontend builds |
| Booking Web / Booking Admin / PMS lint                     | No errors; existing warnings remain                                                       |
| Independent review                                         | Each slice reviewed; valid findings fixed and re-reviewed                                 |

The database suite exercises exact quotes, all-night eligibility, linked stock,
concurrent last-room buyers, atomic reserve/release/adoption, nightly revenue,
pending mixed↔single replacement, confirmed guest/host date changes, complete
assignment adoption, and replay. Changed prices, PMS arrival restrictions and
coupon values fail pending save without changing inventory or the revision.
Repeated coupon edits retain one active redemption. Allocator tests cover
two- and three-type combinations, same-type options, guest bounds, incompatible
payment extensions and incomplete-search reasons.

## Real local guest browser flow

A dedicated target API and PostgreSQL fixture used two Double rooms and one Twin
for six adults, 1–3 February 2027. This exercised the real target repositories and
inventory transactions rather than mocked booking responses:

1. Search displayed the full selection, three allocations, two rate policies and
   €600 total. Selection navigation derived three rooms from the original minimum
   of one room.
2. One booking-scoped €10.25 add-on produced €610.25 through guest details,
   reload, canonical quote replay, payment review and confirmation.
3. Local synthetic booking `VAY-C9F9CF` had one reference and a complete two-line
   receipt bundle. No payment provider or email worker ran.
4. Guest lookup displayed every room and exposed the authorized pending editor.
   The editor restored held inventory even when public search was sold out.
5. Removing the add-on saved revision 1 at €600 with the same reference and all
   three rooms. Replacement receipts covered both room types.
6. At 390×844 the confirmation and policy lines were readable without horizontal
   overflow. Withdrawal canceled the booking; all original and replacement
   receipts were released.

Browser-driven fixes preserve currency cents, compare selection structure across
PostgreSQL JSON key reordering, show quote errors without a promo code, and retain
complete room details in guest lookup. Host browser fixtures separately verify
three unassigned stays, the combined total, both named cancellation policies,
date-change pricing and idempotent retry.

## Stack and release constraints

Implementation starts at [#1657](https://github.com/vayada-marketplace/vayada/pull/1657)
and follows each PR's base branch. Final integration slices are
[#1700](https://github.com/vayada-marketplace/vayada/pull/1700),
[#1702](https://github.com/vayada-marketplace/vayada/pull/1702),
[#1703](https://github.com/vayada-marketplace/vayada/pull/1703), and
[#1704](https://github.com/vayada-marketplace/vayada/pull/1704), followed by activation.
Deploy compatible consumers before activating the API. Repository factories keep
their opt-in default for explicit callers; the completed application runtime
enables search, checkout and pending edits together.

The unused portable PMS adapter rejects selection payloads before mutation. The
target runtime uses its full transactional bundle consumer, covered by database
tests. No legacy Python or infrastructure changes are included.

CodeRabbit returned successful status contexts for rate-limited or skipped draft
reviews; those statuses are not evidence of a completed review. No inline findings
were available at the final inspection. Independent review is recorded separately.
Stacked branches do not run the main-targeted full PR workflow until retargeted;
full local validation above is not a claim of full-stack CI coverage.

Deployed smoke has not run: the stack is unmerged. VAY-959 separately identified a
canonical pay-at-property readiness mismatch (Finance persists `pay_at_property`,
while checkout also requires `cash` or `manual_card`). The local synthetic fixture
included `cash`; it does not validate or fix that deployed prerequisite. No shared
deployed property, account, reservation or payment was changed for this work.
After merge, verify the running API/frontend revisions, coordinate shared smoke
fixtures and test the deployed flow. Keep VAY-910 In Progress until explicit
acceptance.
