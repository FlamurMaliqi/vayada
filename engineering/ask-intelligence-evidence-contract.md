# Ask Intelligence evidence contract

> **Retired on 2026-08-13.** The Ask Intelligence product and runtime described
> here have been removed. This contract is retained only as historical context;
> the future hotel-employee agent tracked in VAY-1091 requires a new contract.

_VAY-613 contract record. Builds on VAY-600 WorkOS identity architecture,
VAY-601 Ask Intelligence architecture, VAY-602 TypeScript backend structure, and
VAY-608 RequestContext._

## Purpose

Ask Intelligence answers authenticated hotel-owner questions from scoped,
typed evidence. It must not answer from arbitrary SQL, cross-tenant data, or
generic chat memory.

This contract defines the MVP evidence tool catalog, answer envelope,
unavailable-data states, tenant scope rules, and audit records. It does not
choose an agent runtime/provider, implement orchestration, or add write-capable
tools.

## Boundary

Owner: `domain-intelligence`.

Inputs:

- `RequestContext` from `apps/api/src/platform/requestContext.ts`;
- metric definitions and snapshots from the Ask Intelligence target schema;
- hotel/property setup and booking/PMS/marketplace read models;
- finance read models only when the membership has explicit finance
  permissions;
- product audit and model-provider trace metadata.

Output:

- an `AskAnswer` envelope with cited `EvidenceReference` records;
- audit records for conversations, runs, tool calls, and answer claims;
- unavailable-data records when evidence is missing, stale, unauthorized, or
  outside the MVP catalog.

## Read-Only MVP Tool Catalog

Every MVP evidence tool is read-only. Tools may read curated views or domain
services, but they must not mutate product state, call payment providers, send
messages, change rates, publish content, or execute SQL supplied by the model.

| Tool ID                            | Reads                                  | Required scope                       | Permission gate                       |
| ---------------------------------- | -------------------------------------- | ------------------------------------ | ------------------------------------- |
| `get_booking_performance`          | direct booking summary metrics         | one linked booking hotel             | `booking.analytics.read`              |
| `get_booking_source_mix`           | booking/referral/source aggregates     | one linked booking hotel             | `booking.analytics.read`              |
| `get_conversion_funnel`            | page view and booking funnel metrics   | one linked booking hotel             | `booking.analytics.read`              |
| `get_setup_gaps`                   | property/setup completeness snapshots  | one linked hotel/property            | `booking.settings.read` or `pms.read` |
| `get_room_type_performance`        | PMS room type revenue/occupancy views  | one linked PMS hotel                 | `pms.analytics.read`                  |
| `get_upcoming_arrivals`            | minimized PMS arrival summary          | one linked PMS hotel                 | `pms.booking.read`                    |
| `get_creator_collaboration_status` | marketplace collaboration read models  | linked marketplace hotel/profile     | `marketplace.collaboration.read`      |
| `get_hotel_settings_summary`       | public/internal hotel setting summary  | one linked hotel/property            | `booking.settings.read` or `pms.read` |
| `get_finance_visibility_summary`   | finance summary read model, no payouts | linked hotel plus finance visibility | `finance.summary.read`                |

Explicitly not in the MVP:

- arbitrary SQL/query tools;
- write tools such as `apply_rate_change`, `send_guest_message`, or
  `publish_booking_page_update`;
- draft/action tools unless they are returned only as non-executed suggested
  actions;
- external enrichment tools for competitors, reviews, events, weather, or OTA
  parity.

## Evidence Tool Contract

Each tool definition must be registered in the evidence catalog before use:

```text
EvidenceToolDefinition
  toolId
  version
  readOnly = true
  product
  supportedIntents[]
  requiredScope.resourceType
  requiredPermissions[]
  allowedFilters
  freshnessSloSeconds
  piiPolicy
  unavailableReasons[]
```

Each tool call returns a typed result:

```text
EvidenceToolResult
  toolCallId
  toolId
  status
  inputScope
  filters
  evidence[]
  unavailableData[]
  audit
```

`status` values:

- `available`: evidence is authorized and complete enough for its purpose;
- `partial`: authorized evidence exists, but a material slice is missing or
  stale;
- `unavailable`: the tool cannot produce evidence from available data;
- `not_authorized`: `RequestContext` does not grant the requested resource or
  metric;
- `invalid_scope`: the selected organization/resource scope is missing or
  ambiguous;
- `error`: unexpected infrastructure failure. User-facing answers must not
  expose stack traces.

## Tenant Scope Rules

Evidence access is constrained by `RequestContext`, not by prompt text.

Rules:

1. Resolve a single selected organization before planning evidence calls.
2. Each tool must check both required permissions and linked resource IDs.
3. A hotel user can access only resources linked to the selected organization.
4. Cross-product evidence is allowed only when both product resources are linked
   to the same selected organization.
5. Finance summaries require explicit finance permission even when booking/PMS
   summary metrics are allowed.
6. Platform-wide or multi-hotel questions require platform permissions and an
   explicit platform scope. Hotel users receive `not_authorized`.
7. Denied, partial, unavailable, and invalid-scope attempts are audited.

Legacy inputs such as `X-Hotel-Id`, `users.type`, and `is_superadmin` are not
Ask Intelligence authorization primitives. They may appear only in migration
audit context outside this contract.

## Answer Envelope

Ask Intelligence returns an envelope, not raw prose:

```text
AskAnswer
  answerId
  contractVersion
  generatedAt
  conversationId
  runId
  question
  scope
  status
  summary
  blocks[]
  evidenceReferences[]
  unavailableData[]
  caveats[]
  confidence
  suggestedActions[]
  followUpQuestions[]
  audit
```

`status` values:

- `answered`: enough authorized evidence exists for a direct answer;
- `partial`: some material evidence is missing, stale, or incomplete;
- `needs_clarification`: scope, date range, resource, or metric is ambiguous;
- `unavailable`: the answer cannot be produced from authorized internal data;
- `external_data_needed`: the question requires a deferred enrichment source;
- `not_authorized`: the requester lacks resource or metric permission.

Every material metric, comparison, recommendation, and caveat must reference at
least one `EvidenceReference` or an `UnavailableData` item.

## Evidence Reference Shape

Evidence references are stable, typed pointers suitable for audit and UI
citations:

```text
EvidenceReference
  evidenceId
  toolCallId
  toolId
  sourceOwner
  sourceView
  resource
  metricKey
  dateRange
  filters
  freshness
  quality
  sampleSize
  aggregateId
```

Evidence references must not expose raw SQL, private source table names, full
guest records, payout accounts, provider-private finance data, owner/admin
notes, or another tenant's private data.

## Unavailable Data

Missing evidence is represented explicitly. The model must not fill gaps with
invented values.

Unavailable reasons:

- `missing_scope`: no selected organization/resource was resolved;
- `not_linked_resource`: requested resource is not linked to the selected
  organization;
- `missing_permission`: membership lacks the required permission;
- `missing_entitlement`: selected organization lacks the required product
  entitlement;
- `inactive_entitlement`: selected organization has the required product
  entitlement, but it is not active;
- `source_not_in_catalog`: no approved MVP tool can answer this question;
- `source_unavailable`: approved source is down or not loaded;
- `stale_source`: source freshness exceeds the tool SLO;
- `empty_result`: authorized query returns no rows for the requested filters;
- `external_data_needed`: requested answer depends on deferred enrichment;
- `pii_restricted`: answer would require data excluded from model inputs.

Unavailable data records include public-safe or owner-safe explanation,
requested scope, blocking reason, source owner, and whether retry or
clarification can help.

## Audit Records

The MVP stores enough metadata to reconstruct why an answer was produced:

| Record              | Purpose                                                                   |
| ------------------- | ------------------------------------------------------------------------- |
| `ask_conversations` | Conversation metadata, actor, selected organization, retention state.     |
| `ask_runs`          | One answer attempt, intent, scope, model/prompt/schema versions, timing.  |
| `ask_tool_calls`    | Tool inputs, authorization result, status, evidence IDs, latency, errors. |
| `ask_answer_audits` | Answer envelope, cited evidence, material claims, suggested actions.      |

Audit records include `requestId`, `actor.internalUserId`,
`selectedOrganization.organizationId`, resource IDs, permission decisions,
tool status, unavailable reasons, model/provider metadata, token/cost metadata,
and correlation IDs.

Audit records should store evidence references and aggregate metadata by
default, not raw guest PII or payout details.

Runtime audit persistence is best-effort after the answer envelope is composed:
if the target audit repository is unavailable, the route logs the failure with
the request ID and still returns the answer. The persistent repository stores a
redacted question plus a stable question hash; generated answer metadata omits
raw question text.

## Fixtures

Representative fixture answers live in:

```text
engineering/fixtures/ask-intelligence-evidence/answers.json
```

They cover:

- allowed hotel performance evidence with typed citations;
- unavailable external/uncataloged data without hallucinated values;
- blocked cross-tenant access with no leaked evidence.

## Implementation Handoff

Follow-up implementation tickets can build without reading FastAPI internals by
using these artifacts:

- Ask Intelligence architecture:
  `engineering/ask-intelligence-architecture.md`;
- TypeScript backend structure:
  `engineering/typescript-backend-structure.md`;
- WorkOS and tenant model:
  `engineering/workos-identity-architecture.md`;
- RequestContext contract:
  `engineering/request-context-contract.md`;
- target schema ownership map:
  `engineering/target-schema-ownership-map.md`;
- fixture answers:
  `engineering/fixtures/ask-intelligence-evidence/answers.json`.
