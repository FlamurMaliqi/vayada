# Ask Intelligence architecture

> **Retired on 2026-08-13.** The Ask Intelligence product and runtime described
> here have been removed. This document is retained only as historical context;
> it must not be used as the design for the future hotel-employee agent tracked
> in VAY-1091.

_VAY-601 decision record. AI API documentation checked on 2026-06-03._

## Recommendation

Build Ask Intelligence MVP as a **read-only hotel owner agent** in the backend,
not as a generic chat endpoint attached to the database.

Use an agent framework for orchestration, tool loops, conversation state,
tracing, and future workflow growth. Keep the MVP's tools predefined,
read-only, and scoped to approved Vayada data. The agent should translate a
hotel owner's question or goal into an authorized tool plan, gather
deterministic evidence from Vayada systems, optionally explain missing
enrichment, and return a structured answer with explicit evidence, caveats,
confidence, unavailable-data states, and suggested next actions.

The model should synthesize and explain. It should not be the authority for
authorization, metric definitions, tenant scoping, billing entitlement, data
freshness, or whether an action is allowed. Write actions should come later
behind explicit preview, confirmation, permission checks, idempotency, and
audit.

## Responsibilities

Ask Intelligence should own:

- Intent classification: identify whether the question is about performance,
  revenue, booking funnel, pricing, availability, operations, guest behavior,
  creator/affiliate performance, setup quality, or platform support.
- Goal framing: turn broad hotel-owner requests into a bounded read-only task
  plan and ask clarifying questions when the goal or scope is ambiguous.
- Scope resolution: resolve the active user, organization, product, hotel,
  property, date range, locale, currency, and resource boundaries.
- Data plan creation: choose which approved data tools or metric views are
  needed to answer the question.
- Evidence gathering: call typed internal data tools and assemble a compact
  evidence pack with filters, source names, freshness, and row/aggregate
  identifiers.
- Answer synthesis: produce a structured answer from the evidence pack, not from
  unconstrained model memory.
- Confidence and caveats: attach confidence derived from evidence quality,
  coverage, recency, sample size, and tool errors.
- Unavailable-data handling: return a clear unavailable or partial state when
  the required data does not exist, is not authorized, is stale, or is outside
  the MVP data catalog.
- Action suggestions: recommend safe next steps without executing them unless a
  separate, explicit action workflow is implemented and authorized.
- Auditability: record what was asked, which resources were accessed, which
  evidence was used, which model/prompt/schema version produced the answer, and
  which actions were suggested.

Ask Intelligence should not own:

- Product authorization policy.
- Raw cross-tenant database access.
- Final approval for destructive or money-moving actions.
- Provider-specific prompt details as product behavior.
- External data claims without source, timestamp, and caveat.
- UI layout. It should return structured blocks the UI can render.
- Direct write execution in the MVP.

## Architecture shape

Use five layers:

1. **Ask API**: accepts a question or goal and explicit scope, authenticates the
   requester, checks entitlement, and returns an answer envelope.
2. **Agent runtime**: manages the read-only agent loop, conversation state,
   tool-call budget, traces, retries, stop conditions, and structured output
   validation.
3. **Planner and policy layer**: classifies intent, applies tenant/resource
   policy, selects allowed predefined tools, and builds a data plan.
4. **Evidence tools**: typed functions that read curated metrics, product
   repositories, setup data, and later external/enriched sources. Tools enforce
   authorization server-side.
5. **Answer composer**: passes the evidence pack to the model and validates the
   response against a strict schema before returning it.

This keeps the model behind an application contract. The model may request
evidence through approved tools, but it cannot choose arbitrary SQL, bypass
resource boundaries, or invent unsupported fields.

The MVP agent's tools should be predefined and read-only, for example:

- `get_booking_performance`
- `get_booking_source_mix`
- `get_conversion_funnel`
- `get_setup_gaps`
- `get_room_type_performance`
- `get_upcoming_arrivals`
- `get_creator_collaboration_status`
- `get_hotel_settings_summary`

The initial agent should be able to plan and use those tools over multiple
steps, but it should only return answers and suggested actions. Write-capable
tools such as `draft_rate_change`, `create_task`, `draft_guest_reply`, and
`prepare_booking_page_update` belong in a later assisted-action phase. Actual
execution tools such as `apply_rate_change`, `send_guest_message`, or
`publish_booking_page_update` require an explicit approval workflow.

## Data access model

### Internal Vayada data

MVP Ask Intelligence should start with internal data because Vayada can
authorize it, define it, audit it, and explain it.

Internal sources include:

- Auth and identity context: internal user, organization, membership, product
  role, selected hotel/resource, and entitlements.
- Booking Engine data: booking hotel setup, property profile, branding,
  amenities, room filters, points of interest, addons, benefits, payment
  settings, promo codes, referral settings, page-view events, funnel events, and
  booking source mix.
- PMS data: hotels, rooms, room types, rates, availability, bookings, booking
  events, payments, payouts, channel mappings, room blocks, notes, check-in and
  check-out state, and operational settings.
- Marketplace data: hotel profiles/listings, collaboration offerings, creator
  profiles, creator platform metrics, collaborations, deliverables, ratings,
  affiliate offerings, and marketplace notifications.
- Platform data: verification status, setup completeness, product status,
  billing plan, enabled modules, and support/admin audit state.

Prefer curated metric views over ad hoc queries. For example, define canonical
metrics for direct share, conversion rate, occupancy, average daily rate,
revenue, booking source mix, cancellation rate, page-view funnel, affiliate
revenue, and creator collaboration performance. The answer layer should not
redefine these metrics in prompts.

### Hotelier-provided setup data

Hotelier-provided setup data should be treated as first-party but not always
complete or externally verified.

Examples:

- Property name, location, address, country, timezone, star rating, description,
  amenities, images, social links, policies, check-in/check-out windows, and
  contact information.
- Room names, descriptions, rate settings, occupancy limits, benefits, add-ons,
  last-minute discounts, cancellation rules, deposit rules, and payment methods.
- Points of interest, custom filters, map settings, branding, language/currency
  settings, and PMS/channel-manager configuration.
- Hotel goals and constraints once product onboarding captures them, such as
  target direct-share goal, preferred guest segments, event strategy, pricing
  aggressiveness, staffing constraints, and promotion rules.

The AI layer should expose whether setup data is missing, stale, defaulted, or
hotelier-entered. It should not present hotelier-entered claims as externally
verified facts unless an enrichment source confirms them.

### External and enriched data

External enrichment should be a later phase, not the MVP dependency.

Potential sources:

- Competitor pricing and availability.
- Local events and demand calendars.
- Public reviews and review themes.
- OTA visibility, channel data, and parity signals.
- Public web/social signals for creators, hotels, and local demand.
- Weather, holidays, flight demand, and macro travel signals.

External data must enter through explicit enrichment connectors with source
name, fetch time, terms/usage constraints, quality score, and expiry. Enriched
facts should be separated from internal facts in the evidence pack. If external
data is unavailable, the answer should degrade to internal-only analysis instead
of pretending to know the market.

## MVP boundary

The MVP should be a read-only hotel owner agent that answers internal-data
questions and helps the owner decide what to do next. It should use an agent
framework, but its available tools should be predefined read-only actions.

Good MVP question types:

- "Why did my direct booking share drop this month?"
- "Which booking source generated the most revenue last week?"
- "Where is my booking funnel leaking?"
- "What setup fields are blocking my booking page from looking complete?"
- "Which room types have the highest booking value?"
- "What changed before revenue dropped?"
- "Which upcoming arrivals need attention?"
- "Which creator collaborations are overdue or underperforming?"
- "What should I do next to improve direct bookings using only current Vayada
  data?"
- "Look at my hotel performance and tell me the top three things to fix."
- "Help me understand what happened this week before I make pricing changes."

Non-MVP or enrichment-required question types:

- "Compare my prices to nearby competitors."
- "Which local events should I price around?"
- "What do Booking.com reviews say about my breakfast?"
- "Which creators outside Vayada should I invite?"
- "Predict demand for next summer using market data."

The MVP may acknowledge those questions but should return `external_data_needed`
with a suggested enrichment requirement.

Non-MVP action-execution requests:

- "Change my weekend rates."
- "Send this message to every arriving guest."
- "Publish these new booking page settings."
- "Cancel risky bookings automatically."

For those, the MVP should return a suggested action or draft plan only. It
should not execute the action.

## Authorization and tenant boundaries

Ask Intelligence must use the same identity and organization model planned for
the WorkOS/backend rewrite:

```text
authenticated provider identity
-> internal user
-> selected organization
-> active membership
-> product permission
-> linked hotel/property/creator/affiliate resource
-> allowed evidence tools
```

Rules:

- The user must select or inherit a single active organization/resource scope
  before data tools run.
- Data tools must enforce authorization internally. Prompt instructions are not
  an authorization boundary.
- A question about "all hotels" is allowed only for platform roles with explicit
  permissions; hotel users receive only their linked hotel/property resources.
- Cross-product joins require both products to be linked to the selected
  organization.
- Guest PII should be excluded by default. When needed for operations, return
  minimal fields and avoid sending full guest records to the model.
- Financial and payout data require stricter permissions than operational
  booking summaries.
- External enrichment for one hotel must never use another tenant's private data
  as an implicit benchmark.
- The audit log should capture denied and unavailable attempts, not just
  successful answers.

## Answer contract

Return an `AskAnswer` envelope, not raw prose.

Conceptual shape:

```text
AskAnswer
  id
  question
  scope
  status
  summary
  blocks[]
  evidence[]
  caveats[]
  unavailable_data[]
  confidence
  suggested_actions[]
  follow_up_questions[]
  audit
```

### Status

Supported answer statuses:

- `answered`: enough evidence exists for a direct answer.
- `partial`: some evidence exists, but a material source is missing or stale.
- `needs_clarification`: the scope, metric, resource, or date range is
  ambiguous.
- `unavailable`: the answer cannot be produced from authorized data.
- `external_data_needed`: the question requires an enrichment connector that is
  not available in the current phase.
- `not_authorized`: the requester lacks permission for the requested resource or
  metric.

### Blocks

Blocks are renderer-friendly units:

- `metric`: a named metric with value, unit, comparison, date range, and source.
- `trend`: change over time with direction and comparison baseline.
- `breakdown`: grouped values such as booking source mix or room-type revenue.
- `table`: structured rows with stable columns.
- `explanation`: plain-language reasoning grounded in evidence.
- `recommendation`: proposed decision with rationale and expected impact.
- `setup_gap`: missing or stale setup data.
- `risk`: caveat, operational risk, or compliance concern.
- `action_suggestion`: a proposed next step that may later become an executable
  workflow.

The UI can render these as cards, charts, tables, or task suggestions without
parsing prose.

### Evidence

Every material claim should be backed by evidence entries.

Evidence entries should include:

- `source`: internal table/view/tool or external connector.
- `product`: booking, PMS, marketplace, platform, enrichment.
- `resource_id`: hotel/property/creator/affiliate/resource ID when applicable.
- `metric_key` or `record_type`.
- `filters`: date range, status filters, currency, source, room type, locale.
- `freshness`: when the data was generated or fetched.
- `quality`: complete, partial, stale, estimated, externally provided, or
  hotelier-entered.
- `sample_size`: count of records behind the aggregate when relevant.
- `ids` or `aggregate_id`: stable references for audit/debugging.

Do not expose raw SQL in user-facing evidence. Store query details in audit logs
for debugging.

### Confidence

Confidence should be computed from evidence characteristics, then explained
briefly. It should not be only the model's self-assessment.

Suggested confidence levels:

- `high`: complete authorized internal data, clear metric definition, fresh
  source, sufficient sample size, no conflicting sources.
- `medium`: enough data to answer, but small sample size, partial period, stale
  setup data, or a minor missing source.
- `low`: sparse data, inferred explanation, stale/estimated source, conflicting
  evidence, or external data not yet available.
- `unknown`: the answer cannot be scored because the required evidence is
  missing or unauthorized.

The answer must explain why confidence is not high.

### Suggested actions

Suggested actions should be typed and non-destructive in the MVP:

- `view_report`
- `open_settings`
- `create_task`
- `adjust_rate_review`
- `contact_guest`
- `review_collaboration`
- `enable_feature`
- `request_enrichment`

Later assisted-action tools can draft or stage changes, but execution should
require a separate explicit action flow with authorization, preview,
confirmation, idempotency, and audit. Ask Intelligence should not silently
change rates, cancel bookings, message guests, alter payout settings, or publish
marketplace changes.

## Principles

### Data-access principles

- Use a metric catalog for canonical definitions.
- Use typed tools and repositories; do not let the model write arbitrary SQL.
- Gather evidence before synthesis.
- Apply authorization before data retrieval and again inside each tool.
- Keep internal and external facts separate.
- Track freshness and data quality for every evidence item.
- Prefer aggregates over raw PII.
- Use snapshots for repeatability where answers may be reviewed later.

### Evidence principles

- Every number needs a source, filters, and time range.
- Every recommendation needs at least one supporting evidence item or a clear
  unavailable-data caveat.
- Missing evidence is a first-class answer state, not a prompt failure.
- Hotelier-entered setup data should be labeled as hotelier-entered.
- External enrichment should include provider, fetch time, and expiry.

### Confidence principles

- Confidence is derived from evidence quality, not tone.
- Low confidence should reduce the strength of recommendations.
- Conflicting sources should produce caveats or a partial answer.
- The model may propose explanations, but the confidence score should be
  reproducible from metadata.

### Audit principles

- Store request ID, actor, organization, resource scope, question, detected
  intent, tool plan, tools called, evidence IDs, answer status, suggested
  actions, model provider/model, prompt/schema version, token/cost metadata, and
  timing.
- Redact or summarize guest PII and sensitive financial details in model inputs
  and logs unless explicitly required.
- Keep enough evidence references to reconstruct why an answer was produced.
- Log denied, unavailable, and partial answers.
- Separate provider logs from Vayada product audit events.

## Old patterns to avoid

- Generic chat output that the frontend has to parse.
- Letting prompts define business metrics.
- Letting the model choose arbitrary database access.
- Treating `user_id` ownership checks as enough for AI answers across products.
- Mixing tenants or using other hotels' private data as hidden benchmarks.
- Hiding missing data behind confident prose.
- Returning recommendations without evidence or freshness.
- Executing actions in the same flow as answering a question.
- Starting with write-capable autonomous tools before the read-only agent is
  proven.
- Sending full guest records or sensitive payout data to a model by default.
- Building one-off AI code per app instead of a shared Ask Intelligence domain.
- Treating the existing listing extraction helper as the architecture for Ask
  Intelligence.

## Prerequisites before implementation tickets

Do not create Ask Intelligence implementation tickets until these are true:

- The identity/organization/resource-link model is accepted enough to define
  tenant boundaries.
- The MVP question set is selected and explicitly limited to internal Vayada
  data.
- The first version is explicitly scoped as a read-only hotel owner agent with
  predefined tools.
- A metric catalog exists for the first answer domains.
- The first resource scope is selected. Recommended first scope: booking/PMS
  hotel performance for one selected hotel organization.
- The answer envelope schema is reviewed and stable enough for frontend and
  backend contracts.
- The evidence/audit tables or event model are designed.
- The agent runtime/provider abstraction is defined, including tool-loop limits,
  structured output validation, retries, refusal handling, trace capture, and
  cost/latency logging.
- The predefined read-only tool catalog is reviewed and authorized.
- PII handling rules are defined for guest, payout, and staff data.
- External enrichment sources are explicitly deferred or separately approved.

## Backend restructure questions

- Should Ask Intelligence live as a module inside the new TypeScript backend or
  as a separate service with its own audit and model-provider adapter?
- Which agent framework/runtime should own orchestration, memory, tracing,
  retries, and tool-loop limits?
- Which canonical metrics should be implemented first: direct share, booking
  source mix, conversion funnel, ADR/revenue, occupancy, or setup completeness?
- Should metric snapshots be stored at answer time for reproducibility, or
  should evidence references be re-queryable from immutable event tables?
- What is the first UI surface: dashboard question box, insight cards, setup
  assistant, or admin/support console?
- How should the product distinguish recommendations from executable actions?
- What approval contract is required before draft tools become execution tools?
- Which data should never be sent to an LLM, even with redaction?
- Which external enrichment connector, if any, is valuable enough to plan
  immediately after the internal-data MVP?

## References

- VAY-601: Define AI layer architecture.
- VAY-600: Define WorkOS identity architecture.
- VAY-599: Canceled umbrella planning issue that split this work into narrower
  decisions.
- Existing listing extraction helper:
  `apps/pms-api/app/services/claude_service.py`.
- OpenAI structured outputs:
  https://platform.openai.com/docs/guides/structured-outputs
- OpenAI function/tool calling:
  https://platform.openai.com/docs/guides/function-calling?api-mode=responses
- OpenAI retrieval and file search:
  https://platform.openai.com/docs/guides/retrieval
