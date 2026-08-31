import type pg from "pg";

import type { ExpectedTarget, ParityFinding, ParityHandlerContext } from "../../parityTypes.js";

const EXPECTED_PLATFORM_COUNTS: Record<string, number> = {
  "platform.domain_events": 3,
  "platform.external_webhook_events": 2,
  "platform.outbox_events": 2,
  "platform.jobs": 3,
  "platform.job_attempts": 4,
  "platform.idempotency_keys": 3,
  "platform.dead_letter_events": 2,
  "platform.product_audit_events": 3,
};

const EXPECTED_PLATFORM_IDS: Record<string, string[]> = {
  "platform.domain_events": [
    "f6954000-0000-0000-0000-000000000001",
    "f6954000-0000-0000-0000-000000000002",
    "f6954000-0000-0000-0000-000000000003",
  ],
  "platform.external_webhook_events": [
    "f6954100-0000-0000-0000-000000000001",
    "f6954100-0000-0000-0000-000000000002",
  ],
  "platform.outbox_events": [
    "f6954200-0000-0000-0000-000000000001",
    "f6954200-0000-0000-0000-000000000002",
  ],
  "platform.jobs": [
    "f6954300-0000-0000-0000-000000000001",
    "f6954300-0000-0000-0000-000000000002",
    "f6954300-0000-0000-0000-000000000003",
  ],
  "platform.job_attempts": [
    "f6954400-0000-0000-0000-000000000001",
    "f6954400-0000-0000-0000-000000000002",
    "f6954400-0000-0000-0000-000000000003",
    "f6954400-0000-0000-0000-000000000004",
  ],
  "platform.idempotency_keys": [
    "f6954500-0000-0000-0000-000000000001",
    "f6954500-0000-0000-0000-000000000002",
    "f6954500-0000-0000-0000-000000000003",
  ],
  "platform.dead_letter_events": [
    "f6954600-0000-0000-0000-000000000001",
    "f6954600-0000-0000-0000-000000000002",
  ],
  "platform.product_audit_events": [
    "f6954700-0000-0000-0000-000000000001",
    "f6954700-0000-0000-0000-000000000002",
    "f6954700-0000-0000-0000-000000000003",
  ],
};

const IDS = {
  bookingDomainEvent: "f6954000-0000-0000-0000-000000000001",
  webhookDomainEvent: "f6954000-0000-0000-0000-000000000002",
  normalizedWebhook: "f6954100-0000-0000-0000-000000000001",
  failedWebhook: "f6954100-0000-0000-0000-000000000002",
  publishedOutbox: "f6954200-0000-0000-0000-000000000001",
  failedOutbox: "f6954200-0000-0000-0000-000000000002",
  succeededJob: "f6954300-0000-0000-0000-000000000001",
  deadLetteredJob: "f6954300-0000-0000-0000-000000000002",
  requeuedJob: "f6954300-0000-0000-0000-000000000003",
  latestFailedAttempt: "f6954400-0000-0000-0000-000000000004",
  propertyIdempotencyKey: "f6954500-0000-0000-0000-000000000001",
  organizationIdempotencyKey: "f6954500-0000-0000-0000-000000000002",
  platformIdempotencyKey: "f6954500-0000-0000-0000-000000000003",
  jobDeadLetter: "f6954600-0000-0000-0000-000000000001",
  webhookDeadLetter: "f6954600-0000-0000-0000-000000000002",
  bookingAudit: "f6954700-0000-0000-0000-000000000001",
  webhookAudit: "f6954700-0000-0000-0000-000000000002",
  jobAudit: "f6954700-0000-0000-0000-000000000003",
  organization: "f6952000-0000-0000-0000-000000000001",
  property: "f6953000-0000-0000-0000-000000000001",
} as const;

const IDEMPOTENCY_BOUNDARY_KEY = "sha256:booking-change-platform-695";

const FORBIDDEN_PUBLIC_PAYLOAD_VALUES = [
  "platform.guest@example.test",
  "+431234695",
  "tok_secret_platform_695",
  "provider_signature_secret_695",
  "raw-webhook-secret-695",
];

function addPlatformFinding(
  findings: ParityFinding[],
  code: string,
  targetObject: string,
  message: string,
  expected: string,
  actual: string,
  suggestedAction: string,
): void {
  findings.push({
    severity: "fail",
    code,
    owner: "Platform jobs/events/audit",
    targetObject,
    message,
    expected,
    actual,
    suggestedAction,
  });
}

function validateExpectedPlatformConfig(
  expected: ExpectedTarget,
  findings: ParityFinding[],
): boolean {
  let valid = true;

  for (const [tableRef, expectedCount] of Object.entries(EXPECTED_PLATFORM_COUNTS)) {
    const actualCount = expected.counts[tableRef];
    if (actualCount !== expectedCount) {
      valid = false;
      addPlatformFinding(
        findings,
        "PLATFORM_EXPECTED_COUNT_MISSING",
        `expected-target.json.counts.${tableRef}`,
        `Expected-target config must include the platform fixture row count for ${tableRef}`,
        String(expectedCount),
        actualCount === undefined ? "undefined" : String(actualCount),
        "Add or correct the platform table row count in platform-jobs-events-audit/expected-target.json.",
      );
    }
  }

  for (const [tableRef, expectedIds] of Object.entries(EXPECTED_PLATFORM_IDS)) {
    const configuredIds = new Set(expected.idStability[tableRef] ?? []);
    const missingIds = expectedIds.filter((id) => !configuredIds.has(id));
    if (missingIds.length > 0) {
      valid = false;
      addPlatformFinding(
        findings,
        "PLATFORM_EXPECTED_ID_STABILITY_MISSING",
        `expected-target.json.idStability.${tableRef}`,
        `Expected-target config must include stable platform fixture IDs for ${tableRef}`,
        expectedIds.join(", "),
        missingIds.length === expectedIds.length
          ? "undefined"
          : `missing: ${missingIds.join(", ")}`,
        "Add the platform stable IDs to platform-jobs-events-audit/expected-target.json.",
      );
    }
  }

  return valid;
}

async function expectRelationshipExists(
  client: pg.Client,
  findings: ParityFinding[],
  code: string,
  targetObject: string,
  message: string,
  expected: string,
  sql: string,
  params: unknown[],
  suggestedAction: string,
): Promise<void> {
  const result = await client.query<{ exists: boolean }>(sql, params);
  if (result.rows[0]?.exists === true) return;

  addPlatformFinding(
    findings,
    code,
    targetObject,
    message,
    expected,
    "relationship not found",
    suggestedAction,
  );
}

async function checkWebhookNormalization(
  client: pg.Client,
  findings: ParityFinding[],
): Promise<void> {
  await expectRelationshipExists(
    client,
    findings,
    "PLATFORM_WEBHOOK_NORMALIZATION_LINK_MISMATCH",
    "platform.external_webhook_events",
    "Expected normalized webhook receipt to link to the projected PMS domain event in the same property scope",
    "Channex webhook row with delivery_status normalized, verified signature, matching scope, and normalized domain event",
    `SELECT EXISTS(
       SELECT 1
       FROM platform.external_webhook_events webhook
       JOIN platform.domain_events event
         ON event.id = webhook.normalized_domain_event_id
        AND event.scope_key = webhook.scope_key
        AND event.property_id = webhook.property_id
       WHERE webhook.id = $1
         AND event.id = $2
         AND webhook.provider = 'channex'
         AND webhook.provider_event_id = 'channex_evt_platform_695'
         AND webhook.delivery_status = 'normalized'
         AND webhook.signature_verified = TRUE
         AND event.event_status = 'projected'
         AND event.resource_product = 'pms'
         AND event.resource_type = 'channel_webhook'
         AND event.correlation_id = webhook.correlation_id
         AND event.causation_id = webhook.provider_event_id
     ) AS exists`,
    [IDS.normalizedWebhook, IDS.webhookDomainEvent],
    "Check webhook fixture rows for normalized_domain_event_id, property scope, and correlation/causation integrity.",
  );
}

async function checkPublishedOutboxJobAuditGraph(
  client: pg.Client,
  findings: ParityFinding[],
): Promise<void> {
  await expectRelationshipExists(
    client,
    findings,
    "PLATFORM_OUTBOX_JOB_AUDIT_LINK_MISMATCH",
    "platform.outbox_events",
    "Expected booking domain event to flow through published outbox, succeeded job, idempotency key, and product audit event",
    "Projected booking event, published outbox row, succeeded job attempt, completed property idempotency key, and audit row all linked in one property scope",
    `SELECT EXISTS(
       SELECT 1
       FROM platform.domain_events event
       JOIN platform.outbox_events outbox
         ON outbox.domain_event_id = event.id
        AND outbox.scope_key = event.scope_key
       JOIN platform.jobs job
         ON job.source_outbox_event_id = outbox.id
        AND job.source_domain_event_id = event.id
        AND job.scope_key = event.scope_key
       JOIN platform.job_attempts attempt
         ON attempt.job_id = job.id
        AND attempt.attempt_number = 1
       JOIN platform.idempotency_keys idempotency
         ON idempotency.id = $4
        AND idempotency.scope_key = event.scope_key
       JOIN platform.product_audit_events audit
         ON audit.id = $5
        AND audit.domain_event_id = event.id
        AND audit.job_id = job.id
        AND audit.idempotency_key_id = idempotency.id
        AND audit.scope_key = event.scope_key
       WHERE event.id = $1
         AND outbox.id = $2
         AND job.id = $3
         AND event.event_status = 'projected'
         AND outbox.status = 'published'
         AND outbox.published_at IS NOT NULL
         AND outbox.attempts_count = 1
         AND job.status = 'succeeded'
         AND job.finished_at IS NOT NULL
         AND attempt.status = 'succeeded'
         AND attempt.finished_at IS NOT NULL
         AND idempotency.status = 'completed'
         AND idempotency.response_resource_product = 'booking'
         AND idempotency.response_resource_type = 'guest_booking'
         AND idempotency.response_resource_id = event.resource_id
         AND audit.action = 'guest_booking.confirmed'
     ) AS exists`,
    [
      IDS.bookingDomainEvent,
      IDS.publishedOutbox,
      IDS.succeededJob,
      IDS.propertyIdempotencyKey,
      IDS.bookingAudit,
    ],
    "Check event/outbox/job/audit fixture rows for source IDs, scope keys, terminal timestamps, and idempotency response linkage.",
  );
}

async function checkRetryDeadLetterGraph(
  client: pg.Client,
  findings: ParityFinding[],
): Promise<void> {
  await expectRelationshipExists(
    client,
    findings,
    "PLATFORM_RETRY_DEAD_LETTER_LINK_MISMATCH",
    "platform.dead_letter_events",
    "Expected failed channel-sync job to exhaust attempts, dead-letter, and requeue a replacement job",
    "Dead-lettered job attempts_count equals job_attempt rows, latest timed-out attempt is linked to a requeued dead-letter event, and replacement job is pending in the same scope",
    `SELECT EXISTS(
       SELECT 1
       FROM platform.jobs failed_job
       JOIN platform.outbox_events failed_outbox
         ON failed_outbox.id = failed_job.source_outbox_event_id
        AND failed_outbox.id = $2
        AND failed_outbox.scope_key = failed_job.scope_key
       JOIN platform.job_attempts latest_attempt
         ON latest_attempt.id = $3
        AND latest_attempt.job_id = failed_job.id
        AND latest_attempt.attempt_number = 3
       JOIN platform.dead_letter_events dead_letter
         ON dead_letter.id = $4
        AND dead_letter.job_id = failed_job.id
        AND dead_letter.job_attempt_id = latest_attempt.id
        AND dead_letter.scope_key = failed_job.scope_key
       JOIN platform.jobs requeued_job
         ON requeued_job.id = $5
        AND requeued_job.id = dead_letter.requeued_job_id
        AND requeued_job.scope_key = dead_letter.scope_key
       JOIN platform.product_audit_events audit
         ON audit.id = $6
        AND audit.job_id = failed_job.id
        AND audit.secondary_resource_id = requeued_job.id::text
        AND audit.scope_key = failed_job.scope_key
       WHERE failed_job.id = $1
         AND failed_job.status = 'dead_lettered'
         AND failed_job.finished_at IS NOT NULL
         AND failed_job.attempts_count = 3
         AND failed_job.max_attempts = 3
         AND failed_job.attempts_count = (
           SELECT count(*)::integer
           FROM platform.job_attempts counted_attempt
           WHERE counted_attempt.job_id = failed_job.id
         )
         AND failed_outbox.status = 'failed'
         AND failed_outbox.attempts_count = 3
         AND latest_attempt.status = 'timed_out'
         AND latest_attempt.finished_at IS NOT NULL
         AND dead_letter.source_kind = 'job'
         AND dead_letter.recovery_status = 'requeued'
         AND dead_letter.reason_code = 'max_attempts_exhausted'
         AND requeued_job.status = 'pending'
         AND requeued_job.source_outbox_event_id = failed_job.source_outbox_event_id
         AND audit.action = 'job.dead_letter.requeued'
     ) AS exists`,
    [
      IDS.deadLetteredJob,
      IDS.failedOutbox,
      IDS.latestFailedAttempt,
      IDS.jobDeadLetter,
      IDS.requeuedJob,
      IDS.jobAudit,
    ],
    "Check job attempts, dead_letter_events, and requeued job fixture rows for retry and recovery linkage.",
  );
}

async function checkWebhookDeadLetterGraph(
  client: pg.Client,
  findings: ParityFinding[],
): Promise<void> {
  await expectRelationshipExists(
    client,
    findings,
    "PLATFORM_WEBHOOK_DEAD_LETTER_LINK_MISMATCH",
    "platform.dead_letter_events",
    "Expected failed Stripe webhook receipt to be linked to an open webhook dead-letter event and audit row",
    "Dead-lettered webhook row, open dead_letter_events row, and product_audit_events row linked in one property scope",
    `SELECT EXISTS(
       SELECT 1
       FROM platform.external_webhook_events webhook
       JOIN platform.dead_letter_events dead_letter
         ON dead_letter.id = $2
        AND dead_letter.webhook_event_id = webhook.id
        AND dead_letter.scope_key = webhook.scope_key
       JOIN platform.product_audit_events audit
         ON audit.id = $3
        AND audit.external_webhook_event_id = webhook.id
        AND audit.scope_key = webhook.scope_key
       WHERE webhook.id = $1
         AND webhook.provider = 'stripe'
         AND webhook.delivery_status = 'dead_lettered'
         AND webhook.signature_verified = FALSE
         AND dead_letter.source_kind = 'webhook'
         AND dead_letter.recovery_status = 'open'
         AND dead_letter.reason_code = 'signature_verification_failed'
         AND audit.action = 'webhook.dead_lettered'
     ) AS exists`,
    [IDS.failedWebhook, IDS.webhookDeadLetter, IDS.webhookAudit],
    "Check webhook dead-letter fixture rows for source_kind, webhook_event_id, scope, and audit linkage.",
  );
}

async function checkIdempotencyBoundaries(
  client: pg.Client,
  findings: ParityFinding[],
): Promise<void> {
  const result = await client.query<{
    boundary_count: number;
    boundary_scope_count: number;
    duplicate_scope_count: number;
    property_completed: boolean;
    organization_completed: boolean;
    platform_locked: boolean;
  }>(
    `WITH duplicate_scopes AS (
       SELECT 1
       FROM platform.idempotency_keys
       GROUP BY operation_scope, operation, key_hash, scope_key
       HAVING count(*) > 1
     )
     SELECT
       (
         SELECT count(*)::integer
         FROM platform.idempotency_keys
         WHERE operation_scope = 'booking'
           AND operation = 'booking.change.confirm'
           AND key_hash = $1
       ) AS boundary_count,
       (
         SELECT count(DISTINCT scope_key)::integer
         FROM platform.idempotency_keys
         WHERE operation_scope = 'booking'
           AND operation = 'booking.change.confirm'
           AND key_hash = $1
       ) AS boundary_scope_count,
       (SELECT count(*)::integer FROM duplicate_scopes) AS duplicate_scope_count,
       EXISTS(
         SELECT 1
         FROM platform.idempotency_keys
         WHERE id = $2
           AND tenant_scope = 'property'
           AND property_id = $5
           AND status = 'completed'
           AND response_status_code = 201
           AND response_resource_product = 'booking'
           AND response_resource_type = 'guest_booking'
           AND response_resource_id = 'guest_booking_platform_695'
           AND completed_at IS NOT NULL
       ) AS property_completed,
       EXISTS(
         SELECT 1
         FROM platform.idempotency_keys
         WHERE id = $3
           AND tenant_scope = 'organization'
           AND organization_id = $6
           AND status = 'completed'
           AND response_status_code = 200
           AND response_body_hash = 'sha256:org-response-platform-695'
           AND completed_at IS NOT NULL
       ) AS organization_completed,
       EXISTS(
         SELECT 1
         FROM platform.idempotency_keys
         WHERE id = $4
           AND tenant_scope = 'platform'
           AND status = 'in_progress'
           AND locked_until IS NOT NULL
       ) AS platform_locked`,
    [
      IDEMPOTENCY_BOUNDARY_KEY,
      IDS.propertyIdempotencyKey,
      IDS.organizationIdempotencyKey,
      IDS.platformIdempotencyKey,
      IDS.property,
      IDS.organization,
    ],
  );

  const row = result.rows[0];
  const matches =
    row &&
    row.boundary_count === 2 &&
    row.boundary_scope_count === 2 &&
    row.duplicate_scope_count === 0 &&
    row.property_completed === true &&
    row.organization_completed === true &&
    row.platform_locked === true;

  if (!matches) {
    addPlatformFinding(
      findings,
      "PLATFORM_IDEMPOTENCY_BOUNDARY_MISMATCH",
      "platform.idempotency_keys",
      "Expected idempotency keys to preserve operation boundaries across property, organization, and platform scopes",
      "Same booking operation/key hash allowed across two distinct scope keys, no duplicate operation/key hash within one scope, completed response metadata present, and platform in-progress lock present",
      row ? JSON.stringify(row) : "row missing",
      "Check idempotency fixture rows for operation_scope, operation, key_hash, tenant_scope, completion metadata, and lock metadata.",
    );
  }
}

async function checkAiVisibilityBoundary(
  client: pg.Client,
  findings: ParityFinding[],
): Promise<void> {
  const result = await client.query<{ target_object: string; id: string }>(
    `SELECT target_object, id
     FROM (
       SELECT 'platform.domain_events' AS target_object, id::text AS id, ai_visible
       FROM platform.domain_events
       UNION ALL
       SELECT 'platform.external_webhook_events' AS target_object, id::text AS id, ai_visible
       FROM platform.external_webhook_events
       UNION ALL
       SELECT 'platform.outbox_events' AS target_object, id::text AS id, ai_visible
       FROM platform.outbox_events
       UNION ALL
       SELECT 'platform.jobs' AS target_object, id::text AS id, ai_visible
       FROM platform.jobs
       UNION ALL
       SELECT 'platform.job_attempts' AS target_object, id::text AS id, ai_visible
       FROM platform.job_attempts
       UNION ALL
       SELECT 'platform.idempotency_keys' AS target_object, id::text AS id, ai_visible
       FROM platform.idempotency_keys
       UNION ALL
       SELECT 'platform.dead_letter_events' AS target_object, id::text AS id, ai_visible
       FROM platform.dead_letter_events
       UNION ALL
       SELECT 'platform.product_audit_events' AS target_object, id::text AS id, ai_visible
       FROM platform.product_audit_events
     ) platform_rows
     WHERE ai_visible = TRUE
     ORDER BY target_object, id`,
  );

  if (result.rows.length > 0) {
    addPlatformFinding(
      findings,
      "PLATFORM_AI_VISIBILITY_BOUNDARY_VIOLATION",
      "platform.*",
      "Expected platform operational payload rows to remain private by default",
      "No platform jobs/events/audit fixture rows with ai_visible = true",
      JSON.stringify(result.rows),
      "Set ai_visible to false for operational platform rows and keep public/AI-safe projections in their owning read models.",
    );
  }
}

async function checkPayloadRedactionBoundary(
  client: pg.Client,
  findings: ParityFinding[],
): Promise<void> {
  const leakResult = await client.query<{
    target_object: string;
    id: string;
    leaked_value: string;
  }>(
    `WITH forbidden(value) AS (
       SELECT unnest($1::text[])
     ),
     public_payloads AS (
       SELECT 'platform.domain_events.payload' AS target_object,
              id::text AS id,
              payload::text || event_metadata::text AS payload_text
       FROM platform.domain_events
       UNION ALL
       SELECT 'platform.outbox_events.payload' AS target_object,
              id::text AS id,
              payload::text || outbox_metadata::text AS payload_text
       FROM platform.outbox_events
       UNION ALL
       SELECT 'platform.jobs.payload' AS target_object,
              id::text AS id,
              payload::text || job_metadata::text AS payload_text
       FROM platform.jobs
       UNION ALL
       SELECT 'platform.product_audit_events.redacted_payload' AS target_object,
              id::text AS id,
              redacted_payload::text || audit_metadata::text AS payload_text
       FROM platform.product_audit_events
     )
     SELECT target_object, id, forbidden.value AS leaked_value
     FROM public_payloads
     JOIN forbidden ON strpos(public_payloads.payload_text, forbidden.value) > 0
     ORDER BY target_object, id, leaked_value`,
    [FORBIDDEN_PUBLIC_PAYLOAD_VALUES],
  );

  if (leakResult.rows.length > 0) {
    addPlatformFinding(
      findings,
      "PLATFORM_PRIVATE_PAYLOAD_EXPOSURE",
      "platform.product_audit_events.redacted_payload",
      "Expected redacted/platform dispatch payloads to omit raw guest and provider-secret values",
      "Private values appear only in raw webhook receipts or product_audit_events.private_payload, never in redacted/dispatch payloads",
      JSON.stringify(leakResult.rows),
      "Move private guest/provider values into private_payload or raw_payload and keep redacted payloads hash/reference only.",
    );
  }

  const boundaryResult = await client.query<{
    redacted_has_guest_email: boolean;
    guest_email_hash: string | null;
    private_guest_email: string | null;
    private_guest_phone: string | null;
  }>(
    `SELECT
       redacted_payload ? 'guestEmail' AS redacted_has_guest_email,
       redacted_payload ->> 'guestEmailHash' AS guest_email_hash,
       private_payload #>> '{guest,email}' AS private_guest_email,
       private_payload #>> '{guest,phone}' AS private_guest_phone
     FROM platform.product_audit_events
     WHERE id = $1`,
    [IDS.bookingAudit],
  );

  const row = boundaryResult.rows[0];
  const matches =
    row &&
    row.redacted_has_guest_email === false &&
    row.guest_email_hash === "sha256:guest-email-695" &&
    row.private_guest_email === "platform.guest@example.test" &&
    row.private_guest_phone === "+431234695";

  if (!matches) {
    addPlatformFinding(
      findings,
      "PLATFORM_AUDIT_REDACTION_BOUNDARY_MISMATCH",
      "platform.product_audit_events",
      "Expected booking audit event to keep guest PII out of redacted_payload while retaining it in private_payload",
      "redacted_payload has guestEmailHash and no guestEmail key; private_payload has guest email and phone",
      row ? JSON.stringify(row) : "row missing",
      "Check product_audit_events redacted/private payload split for the booking audit fixture row.",
    );
  }
}

async function checkStripeReceiptRetentionBoundary(
  client: pg.Client,
  findings: ParityFinding[],
): Promise<void> {
  await expectRelationshipExists(
    client,
    findings,
    "PLATFORM_STRIPE_RECEIPT_RETENTION_BOUNDARY_MISMATCH",
    "platform.external_webhook_events",
    "Expected imported pre-v1 Stripe receipt payload copies to be irreversibly scrubbed",
    "Empty receipt headers/payload and linked audit private payload, with retained receipt identity and purge timestamps",
    `SELECT EXISTS(
       SELECT 1
       FROM platform.external_webhook_events webhook
       JOIN platform.product_audit_events audit
         ON audit.id = $2
        AND audit.external_webhook_event_id = webhook.id
       WHERE webhook.id = $1
         AND webhook.raw_headers = '{}'::jsonb
         AND webhook.raw_payload = '{}'::jsonb
         AND webhook.payload_retention_until IS NOT NULL
         AND webhook.payload_purged_at IS NOT NULL
         AND audit.private_payload = '{}'::jsonb
     ) AS exists`,
    [IDS.failedWebhook, IDS.webhookAudit],
    "Scrub imported Stripe receipt payload copies while preserving receipt IDs, hashes, lifecycle, and audit links.",
  );
}

export async function checkPlatformJobsEventsAuditParity({
  client,
  expected,
  findings,
}: ParityHandlerContext): Promise<void> {
  if (!validateExpectedPlatformConfig(expected, findings)) return;

  await checkWebhookNormalization(client, findings);
  await checkPublishedOutboxJobAuditGraph(client, findings);
  await checkRetryDeadLetterGraph(client, findings);
  await checkWebhookDeadLetterGraph(client, findings);
  await checkIdempotencyBoundaries(client, findings);
  await checkAiVisibilityBoundary(client, findings);
  await checkPayloadRedactionBoundary(client, findings);
  await checkStripeReceiptRetentionBoundary(client, findings);
}
