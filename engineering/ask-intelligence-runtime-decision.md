# Ask Intelligence runtime and provider boundary decision

> **Retired on 2026-08-13.** The Ask Intelligence product and runtime described
> here have been removed. This decision is retained only as historical context;
> VAY-1091 will make a new runtime and platform recommendation.

_VAY-736 decision record. Builds on VAY-601 Ask Intelligence architecture,
VAY-613 evidence contract, VAY-602 TypeScript backend structure, VAY-607
runtime and DB tooling, and VAY-608 RequestContext. Official OpenAI
documentation checked on 2026-06-10._

## Recommendation

Build the Ask Intelligence MVP as a module inside the target TypeScript backend
`apps/api`, not as a separate deployable service.

Use the OpenAI TypeScript Agents SDK on the Responses API for the first agent
runtime. Keep OpenAI behind a narrow `ModelProvider` and `AskAgentRuntime`
boundary owned by `domain-intelligence`, so product code depends on Vayada
contracts instead of provider-specific request shapes.

The MVP runtime must remain read-only:

- no arbitrary SQL tools;
- no hosted web search, file search, code interpreter, browser, or external
  enrichment tools;
- no write, draft-execution, payment, messaging, rate-change, publish, or
  cancellation tools;
- no model-visible raw cross-tenant data or broad guest, payout, or staff PII.

The agent can plan, call predefined evidence tools, synthesize a structured
`AskAnswer`, and return suggested actions only.

## Decision

### Runtime

Use `@openai/agents` for orchestration because it matches the accepted
architecture requirements:

- an agent loop for model turns and tool invocation;
- TypeScript function tools with schema validation;
- structured final outputs through Zod or JSON Schema;
- reusable `Runner` instances for process-level configuration;
- local run context for request dependencies that are not sent to the model;
- lifecycle events and tracing for model calls, tool calls, guardrails, and
  custom events;
- session interfaces that can be backed by Vayada storage when conversation
  continuity is in scope.

Do not expose the SDK directly to routes or evidence tools. The runtime scaffold
should introduce an application interface similar to:

```text
AskAgentRuntime
  answer(question, scope, requestContext, conversationState)
    -> AskAnswer
```

The implementation may use an Agents SDK `Agent` and process-wide `Runner`, but
route handlers and domain services should only know about the Vayada answer,
evidence, audit, and unavailable-data contracts.

### Provider

Use OpenAI as the first model provider. The default model should be configured,
not hard-coded in product behavior. Start with:

- `ASK_INTELLIGENCE_MODEL=gpt-5.5` for answer synthesis;
- `reasoning.effort=low` for normal MVP metric/setup questions;
- `reasoning.effort=medium` only for multi-tool comparative questions after
  measurement shows acceptable latency and cost;
- `text.verbosity=low` because the UI renders structured blocks, not long prose.

Do not use a floating `latest` alias. Model changes should be explicit PRs with
fixture and evaluation output because answer tone, latency, token use, refusal
behavior, and structured-output reliability are product behavior.

Keep the provider boundary narrow:

```text
ModelProvider
  runStructured(request, outputSchema, toolSchemas, options)
    -> StructuredModelResult
```

The provider result should include:

- provider name and model;
- provider request ID / response ID;
- refusal or safety refusal metadata;
- token usage, cached-token usage when available, and cost estimate fields;
- latency and retry count;
- raw provider trace ID when available;
- parsed structured output or schema-validation failure.

The provider boundary should not try to become a generic multi-provider
framework in the MVP. Add another provider only when there is a concrete
business need and a compatibility test suite for tool calls, structured outputs,
refusals, token accounting, and trace fields.

### Runtime configuration and rollback

Local development and tests default to the fixture provider. OpenAI mode is
explicit:

```text
ASK_INTELLIGENCE_PROVIDER=openai
ASK_INTELLIGENCE_MODEL=gpt-5.5
OPENAI_API_KEY=<secret>
OPENAI_BASE_URL=<optional override>
OPENAI_ORGANIZATION=<optional>
OPENAI_PROJECT=<optional>
```

`ASK_INTELLIGENCE_PROVIDER=openai` fails during config loading unless
`ASK_INTELLIGENCE_MODEL` and `OPENAI_API_KEY` are both present. Staging or next
runtime values are owned by the platform deployment for `next-target-backend`;
`OPENAI_API_KEY` must live in AWS SSM/Secrets Manager and be injected into the
ECS task, not committed to this repo or printed by GitHub Actions.

Rollback is configuration-only: set `ASK_INTELLIGENCE_PROVIDER=fixture`, or
remove `ASK_INTELLIGENCE_PROVIDER`, `ASK_INTELLIGENCE_MODEL`, and `OPENAI_*`
values from the task environment. Evidence source rollback remains separate:
`ASK_INTELLIGENCE_EVIDENCE_SOURCE=fixture` keeps local/test evidence defaults,
while `target` requires `TARGET_DATABASE_URL`.

### Service boundary

Ask Intelligence should live under the target backend shape:

```text
apps/api/src/routes/ai/ask/*
packages/domain-intelligence
```

`apps/api` owns HTTP adaptation, authentication, route policy, and request
correlation. `domain-intelligence` owns the agent runtime boundary, evidence
tool definitions, prompt/schema versions, answer composition, confidence
calculation, and audit mapping.

Do not create a separate Ask Intelligence service for MVP. A separate service
would add deployment, auth propagation, tracing, and data-access boundaries
before there is enough runtime pressure to justify them. Revisit a split only
if model traffic needs separate scaling, compliance isolation, release cadence,
or provider network controls.

## Tool loop parameters

The scaffold ticket should implement these defaults as configuration with safe
upper bounds:

| Parameter                             |              MVP default |    Hard limit | Notes                                                                |
| ------------------------------------- | -----------------------: | ------------: | -------------------------------------------------------------------- |
| Model turns after the initial request |                        3 |             4 | A turn is a model response that may request tools or final output.   |
| Evidence tool calls per run           |                        6 |             8 | Counts only approved Vayada evidence tools.                          |
| Calls to the same tool                |                        2 |             2 | Allows one refined filter pass without loops.                        |
| Provider retries                      |                        1 |             2 | Retry transient provider failures only.                              |
| Tool retries                          |                        0 |             1 | Retry only idempotent infrastructure failures, never auth denials.   |
| Run timeout                           |               20 seconds |    30 seconds | Return `partial` or `unavailable` on budget exhaustion.              |
| Concurrent tool calls                 |                        3 |             4 | Only for independent read-only tools over the same authorized scope. |
| Conversation history sent to model    | 5 prior turns or summary | 8 prior turns | Prefer summaries and evidence references over full transcripts.      |

Stop the loop when any of these is true:

- the model returns a schema-valid `AskAnswer`;
- scope, date range, metric, or resource ambiguity requires clarification;
- the requested answer needs an external enrichment source;
- policy denies the requested resource or metric;
- no approved evidence tool exists for the detected intent;
- tool, turn, retry, or timeout budget is exhausted;
- a tool returns `not_authorized`, `invalid_scope`, or `pii_restricted` for all
  evidence needed to answer;
- structured output validation fails twice for the same run.

Budget exhaustion must not produce confident prose. Return `partial`,
`unavailable`, or `needs_clarification` with explicit `unavailableData`.

## Evidence tools

The runtime may expose only tools registered in the Ask Intelligence evidence
catalog. Tool definitions must include:

- tool ID and version;
- read-only flag;
- supported intents;
- required resource scope;
- required permissions;
- allowed filters;
- freshness SLO;
- PII policy;
- unavailable reasons;
- timeout.

Tool implementation rules:

- authorize inside the tool using `RequestContext`;
- use linked resource IDs from the selected organization;
- return typed `EvidenceToolResult`, not raw database rows;
- return stable evidence references and aggregate IDs;
- never accept SQL, table names, or arbitrary field selection from the model;
- never call external enrichment sources in MVP;
- never mutate product state.

The model may choose among approved tools, but it does not decide whether a tool
is authorized, fresh, in catalog, or safe to call.

## Structured output and validation

`AskAnswer` is the only successful final output. Use strict structured output
validation with the shared answer schema. Do not ask the model to invent schema
rules from prompt text.

Validation happens in two layers:

1. provider/runtime validation against the JSON Schema or Zod schema;
2. Vayada domain validation that every material metric, comparison,
   recommendation, and caveat cites an `EvidenceReference` or
   `UnavailableData` item.

If validation fails:

- retry once with a short repair instruction and the same evidence pack;
- if the repaired output is invalid, return `unavailable` with audit metadata
  and do not expose the malformed answer to the UI.

Refusals are mapped to structured states:

- safety refusal for unavailable internal data -> `unavailable`;
- refusal because the request asks for competitor/events/reviews/etc. ->
  `external_data_needed`;
- refusal because the user asks to execute a write action -> `partial` or
  `unavailable` with a non-executed suggested action, depending on available
  evidence;
- refusal because of authorization or PII boundaries -> `not_authorized` or
  `unavailable` with `pii_restricted`.

## Conversation state

Store conversation state in Vayada-owned `ask_conversations` and `ask_runs`.
Do not rely on provider-hosted conversation memory as the source of truth for
MVP audit or replay.

The runtime may use an Agents SDK session adapter backed by Vayada storage once
the scaffold has the persistence surface. Until then, pass a compact,
redacted conversation summary and prior evidence references into each run.

Conversation state sent to the model should contain:

- the current question;
- selected organization and resource labels that are safe for the owner to see;
- prior clarified scope and date range;
- prior answer summaries and evidence IDs;
- no raw guest records, payout details, staff notes, provider tokens, or hidden
  authorization metadata.

## Trace and audit capture

Every run must produce Vayada audit records even when it is denied, partial, or
unavailable.

Persist these fields in the target intelligence tables:

- `ask_conversations`: actor, selected organization, resource scope, language,
  retention state, and latest run summary.
- `ask_runs`: question, detected intent, normalized scope, model provider,
  model, prompt version, schema version, status, confidence, latency, token
  usage, cost estimate, refusal metadata, provider response ID, provider trace
  ID, and correlation ID.
- `ask_tool_calls`: tool ID/version, inputs after policy normalization,
  authorization decision, result status, evidence IDs, unavailable reasons,
  latency, retry count, and redacted error category.
- `ask_answer_audits`: final answer envelope, material claims, cited evidence,
  caveats, suggested actions, and validation outcome.

Do not persist raw model prompts, raw provider responses, full guest records,
payout account details, provider-private finance data, or staff notes by
default. If a debugging mode ever stores provider payloads, it must be
environment-gated, redacted, retention-limited, and disabled in production
unless separately approved.

## PII and sensitive data policy

Model inputs should use the minimum data required to answer the owner question.

Never send these fields to the model in MVP:

- full guest names;
- guest email addresses, phone numbers, addresses, IDs, or travel documents;
- payment method data, payout account data, bank details, Stripe/Xendit IDs, or
  provider-private finance metadata;
- owner or staff private notes;
- authentication tokens, session IDs, reset tokens, invite tokens, or WorkOS
  provider payloads;
- another tenant's private metrics or records.

Allowed model-visible data by default:

- aggregate metrics and percentages;
- date ranges, filters, source labels, freshness, and sample sizes;
- booking source/channel labels when they do not identify a guest;
- room type names and public hotel setup fields for the selected organization;
- masked or role-based operational labels such as "arrival 3" only when needed
  for upcoming-arrival summaries.

Guest or staff operational details may be returned to the UI only outside the
model input, through typed UI data blocks with minimized fields and explicit
permissions. If the answer would require restricted PII to reason correctly,
return `pii_restricted` instead of sending the data to the model.

## Guardrails

Add deterministic guardrails before the provider call:

- classify the request into MVP intent, external-data-needed, write-action, or
  unsupported;
- resolve exactly one selected organization and resource scope;
- map intent to the allowed evidence tool subset;
- reject or clarify ambiguous date ranges, resources, and metric names;
- block requests for arbitrary SQL, cross-tenant benchmarks, hidden competitor
  analysis, or action execution.

Add deterministic guardrails after tool calls:

- compute confidence from evidence quality, freshness, source coverage, and
  sample size;
- require every material claim to cite evidence or unavailable data;
- downgrade answers with stale, partial, empty, or small-sample evidence;
- ensure suggested actions are non-destructive and not represented as executed.

## Tradeoffs

| Option                           | Decision | Reason                                                                                                                                                                    |
| -------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI Agents SDK                | Choose   | Best fit for TypeScript agent loops, function tools, structured outputs, sessions, and tracing while staying close to the Responses API.                                  |
| Direct Responses API only        | Defer    | Viable fallback, but it would make Vayada build more loop, session, tool, and trace plumbing in the first scaffold.                                                       |
| LangGraph / custom graph runtime | Defer    | Useful for complex graph workflows, but premature for the MVP's single read-only hotel-owner agent.                                                                       |
| Vercel AI SDK                    | Defer    | Strong UI streaming fit, but the accepted backend architecture needs server-side evidence tools, audit, and route policy more than frontend-first streaming abstractions. |
| Separate Ask service             | Defer    | Adds operational and auth propagation complexity before the first product runtime exists.                                                                                 |
| Generic provider registry        | Defer    | Adds abstraction work without evidence that a second provider will meet the same structured-output, tool-call, refusal, and audit requirements.                           |

## Scaffold implications

VAY-743 and VAY-749 should not start from a raw chat endpoint. They should
scaffold these pieces:

1. `POST /api/ai/ask` route in `apps/api` with `enforceRoutePolicy`.
2. `domain-intelligence` answer, evidence, unavailable-data, confidence, and
   suggested-action types.
3. `AskAgentRuntime` interface plus an OpenAI Agents SDK implementation.
4. `ModelProvider` interface with OpenAI as the first provider.
5. Config for model, reasoning effort, verbosity, timeouts, retries, tool-call
   budgets, and tracing.
6. Strict schemas for tool inputs, tool results, and `AskAnswer`.
7. Audit writers for conversations, runs, tool calls, and answer audits.
8. Test doubles for the runtime and provider so route and policy tests do not
   require live model calls.

The first scaffold may return a deterministic `unavailable` or sample
`AskAnswer` while the provider implementation is behind a feature flag, but it
must preserve the final envelope and audit shape.

## References

- Ask Intelligence architecture: `engineering/ask-intelligence-architecture.md`
- Ask Intelligence evidence contract:
  `engineering/ask-intelligence-evidence-contract.md`
- TypeScript backend structure:
  `engineering/typescript-backend-structure.md`
- RequestContext contract: `engineering/request-context-contract.md`
- OpenAI Agents SDK overview: <https://openai.github.io/openai-agents-js/>
- OpenAI Agents SDK running agents:
  <https://openai.github.io/openai-agents-js/guides/running-agents/>
- OpenAI Agents SDK tracing:
  <https://openai.github.io/openai-agents-js/guides/tracing/>
- OpenAI structured outputs:
  <https://developers.openai.com/api/docs/guides/structured-outputs>
- OpenAI function calling:
  <https://developers.openai.com/api/docs/guides/function-calling>
- OpenAI latest model guidance:
  <https://developers.openai.com/api/docs/guides/latest-model>
