import type { PmsChannexManagementCommandInput } from "../domains/pmsChannexManagementCommands.js";
import type {
  ChannexManagementJob,
  ChannexManagementProviderFailure,
  ChannexManagementProviderSuccess,
} from "./pmsChannexManagementWorker.js";
import type {
  ChannexManagementQueryClient,
  ChannexManagementTargetStatePort,
} from "./pmsChannexManagementWorkerStore.js";

export function createPmsChannexManagementTargetState(): ChannexManagementTargetStatePort {
  return { succeed: applySuccess, fail: applyFailure };
}

async function applySuccess(
  client: ChannexManagementQueryClient,
  job: ChannexManagementJob,
  result: ChannexManagementProviderSuccess,
  now: Date,
) {
  await applyPmsChannexManagementProgress(client, job, result, now);
  if (job.input.operationType === "enable" || job.input.operationType === "disable") return;
  await applyConnectedSuccess(client, job, result, now);
}

export async function applyPmsChannexManagementProgress(
  client: Pick<ChannexManagementQueryClient, "query">,
  job: ChannexManagementJob,
  result: ChannexManagementProviderSuccess,
  now: Date,
) {
  if (result.externalPropertyId) {
    await requireChannexBindingClaim(
      client,
      job.propertyId,
      result.externalPropertyId,
      job.input.operationType === "enable",
      now,
    );
  }
  const connectionStatus =
    result.connectionStatus ??
    (job.input.operationType === "enable" && result.externalPropertyId
      ? "connected"
      : job.input.operationType === "disable"
        ? "disconnected"
        : undefined);
  if (connectionStatus === "connected") {
    await client.query(
      `INSERT INTO pms.channel_connections (
         property_id, provider, connection_status, external_property_id
       ) VALUES ($1::uuid, 'channex', 'connected', $2)
       ON CONFLICT (property_id, provider) DO UPDATE SET connection_status = 'connected',
         external_property_id = COALESCE(EXCLUDED.external_property_id, pms.channel_connections.external_property_id),
         updated_at = $3::timestamptz`,
      [job.propertyId, result.externalPropertyId ?? null, now.toISOString()],
    );
  }
  if (connectionStatus === "disconnected") {
    await client.query(
      `UPDATE pms.channel_connections SET connection_status = 'disconnected',
         external_property_id = NULL, messaging_app_installed = FALSE,
         connection_metadata = connection_metadata - 'connectedChannels',
         updated_at = $2::timestamptz
       WHERE property_id = $1::uuid AND provider = 'channex'`,
      [job.propertyId, now.toISOString()],
    );
    for (const table of ["channel_room_type_mappings", "channel_rate_plan_mappings"]) {
      await client.query(
        `UPDATE pms.${table} SET status = 'disabled', updated_at = $2::timestamptz
         WHERE property_id = $1::uuid AND connection_id = (
           SELECT id FROM pms.channel_connections
           WHERE property_id = $1::uuid AND provider = 'channex'
         )`,
        [job.propertyId, now.toISOString()],
      );
    }
  }
  if (
    job.input.operationType === "provision" ||
    job.input.operationType === "setup_google" ||
    result.roomTypeMappings?.length ||
    result.ratePlanMappings?.length
  ) {
    await applyMappings(client, job, result);
  }
  if (result.messagingAppInstalled) {
    await client.query(
      `UPDATE pms.channel_connections SET messaging_app_installed = TRUE, updated_at = $2::timestamptz
       WHERE property_id = $1::uuid AND provider = 'channex'`,
      [job.propertyId, now.toISOString()],
    );
  }
  if (result.channels !== undefined) {
    await client.query(
      `UPDATE pms.channel_connections SET
         connection_metadata = connection_metadata || jsonb_build_object('connectedChannels', $2::jsonb),
         updated_at = $3::timestamptz
       WHERE property_id = $1::uuid AND provider = 'channex'`,
      [job.propertyId, JSON.stringify(result.channels), now.toISOString()],
    );
  }
}

async function requireChannexBindingClaim(
  client: Pick<ChannexManagementQueryClient, "query">,
  propertyId: string,
  externalPropertyId: string,
  mayCreate: boolean,
  now: Date,
) {
  const result = mayCreate
    ? await client.query<{ id: string }>(
        `INSERT INTO pms.channel_binding_claims (
           property_id, provider, external_property_id, claim_state, claim_source, updated_at
         ) VALUES ($1::uuid, 'channex', $2, 'active', 'enable', $3::timestamptz)
         ON CONFLICT (property_id, provider) DO UPDATE SET updated_at = EXCLUDED.updated_at
           WHERE pms.channel_binding_claims.external_property_id = EXCLUDED.external_property_id
             AND pms.channel_binding_claims.claim_state = 'active'
         RETURNING id::text`,
        [propertyId, externalPropertyId, now.toISOString()],
      )
    : await client.query<{ id: string }>(
        `SELECT id::text FROM pms.channel_binding_claims
         WHERE property_id = $1::uuid AND provider = 'channex'
           AND external_property_id = $2 AND claim_state = 'active'`,
        [propertyId, externalPropertyId],
      );
  if (!result.rows[0]) throw new Error("Channex binding claim is not active");
}

async function applyConnectedSuccess(
  client: ChannexManagementQueryClient,
  job: ChannexManagementJob,
  result: ChannexManagementProviderSuccess,
  now: Date,
) {
  if (job.input.operationType === "update_markups") {
    for (const markup of job.input.markups ?? []) {
      await client.query(
        `UPDATE pms.channel_rate_plan_mappings SET markup_percent = $3, updated_at = $4::timestamptz
         WHERE property_id = $1::uuid AND channel = $2
           AND connection_id = (
             SELECT id FROM pms.channel_connections
             WHERE property_id = $1::uuid AND provider = 'channex'
           )`,
        [job.propertyId, markup.channel, markup.markupPercent, now.toISOString()],
      );
    }
  }
  const domain = syncDomain(job.input.operationType);
  await client.query(
    `UPDATE pms.channel_connections SET
       external_property_id = COALESCE($2, external_property_id),
       messaging_app_installed = CASE WHEN $3 THEN TRUE ELSE messaging_app_installed END,
       last_booking_sync_at = CASE WHEN $4 = 'booking' THEN $5::timestamptz ELSE last_booking_sync_at END,
       last_ari_sync_at = CASE WHEN $4 = 'ari' THEN $5::timestamptz ELSE last_ari_sync_at END,
       connection_metadata = connection_metadata
         || CASE WHEN $6::boolean THEN jsonb_build_object('connectedChannels', $7::jsonb)
              ELSE '{}'::jsonb END
         || CASE WHEN $8::boolean THEN jsonb_build_object(
              'googleFreeBookingLinks',
              COALESCE(connection_metadata -> 'googleFreeBookingLinks', '{}'::jsonb)
                || jsonb_build_object('lastPreparedAt', $5::text, 'lastError', NULL)
                || jsonb_build_object('sourceFingerprint', $11::text)
                || CASE WHEN $9::boolean THEN jsonb_build_object(
                    'businessProfileConfirmedAt', $5::text,
                    'businessProfileConfirmedBy', $10::text
                  ) ELSE '{}'::jsonb END
            ) ELSE '{}'::jsonb END,
       updated_at = $5::timestamptz
     WHERE property_id = $1::uuid AND provider = 'channex'`,
    [
      job.propertyId,
      result.externalPropertyId ?? null,
      job.input.operationType === "install_messaging",
      domain,
      now.toISOString(),
      result.channels !== undefined,
      JSON.stringify(result.channels ?? []),
      result.googleSourceFingerprint !== undefined,
      job.input.businessProfileConfirmed === true,
      job.input.actorUserId ?? null,
      result.googleSourceFingerprint ?? null,
    ],
  );
  if (domain) await upsertSyncSuccess(client, job.propertyId, domain, now);
}

async function applyMappings(
  client: Pick<ChannexManagementQueryClient, "query">,
  job: ChannexManagementJob,
  result: ChannexManagementProviderSuccess,
) {
  for (const mapping of result.roomTypeMappings ?? []) {
    await client.query(
      `INSERT INTO pms.channel_room_type_mappings (
         property_id, connection_id, room_type_id, external_room_type_id, status
       ) SELECT $1::uuid, connection.id, $2::uuid, $3, $4
         FROM pms.channel_connections connection
         WHERE connection.property_id = $1::uuid AND connection.provider = 'channex'
       ON CONFLICT (connection_id, room_type_id) DO UPDATE SET
         external_room_type_id = EXCLUDED.external_room_type_id,
         status = EXCLUDED.status, updated_at = now()`,
      [job.propertyId, mapping.roomTypeId, mapping.externalRoomTypeId, mapping.status],
    );
  }
  for (const mapping of result.ratePlanMappings ?? []) {
    await client.query(
      `INSERT INTO pms.channel_rate_plan_mappings (
         property_id, connection_id, room_type_id, rate_plan_id, channel,
         external_room_type_id, external_rate_plan_id, sell_mode, markup_percent, status
       ) SELECT $1::uuid, connection.id, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9
         FROM pms.channel_connections connection
         WHERE connection.property_id = $1::uuid AND connection.provider = 'channex'
       ON CONFLICT (connection_id, rate_plan_id, channel) DO UPDATE SET
         external_room_type_id = EXCLUDED.external_room_type_id,
         external_rate_plan_id = EXCLUDED.external_rate_plan_id,
         sell_mode = EXCLUDED.sell_mode, markup_percent = EXCLUDED.markup_percent,
         status = EXCLUDED.status, updated_at = now()`,
      [
        job.propertyId,
        mapping.roomTypeId,
        mapping.ratePlanId,
        mapping.channel,
        mapping.externalRoomTypeId,
        mapping.externalRatePlanId,
        mapping.sellMode,
        mapping.markupPercent,
        mapping.status,
      ],
    );
  }
}

async function applyFailure(
  client: ChannexManagementQueryClient,
  job: ChannexManagementJob,
  failure: ChannexManagementProviderFailure,
  input: { now: Date; retryAt: Date | null },
) {
  const domain = syncDomain(job.input.operationType);
  if (!domain) return;
  if (job.input.operationType === "setup_google" || job.input.operationType === "provision") {
    await client.query(
      `UPDATE pms.channel_connections SET
         connection_metadata = connection_metadata || jsonb_build_object(
           'googleFreeBookingLinks',
           COALESCE(connection_metadata -> 'googleFreeBookingLinks', '{}'::jsonb)
             || jsonb_build_object(
               'lastError', jsonb_build_object('code', $2::text, 'message', $3::text),
               'lastAttemptAt', $4::text
             )
         ), updated_at = $4::timestamptz
       WHERE property_id = $1::uuid AND provider = 'channex'
         AND ($5::boolean OR COALESCE(
           connection_metadata #>> '{googleFreeBookingLinks,businessProfileConfirmedAt}', ''
         ) <> '')`,
      [
        job.propertyId,
        failure.code,
        failure.message.slice(0, 500),
        input.now.toISOString(),
        job.input.operationType === "setup_google",
      ],
    );
  }
  await client.query(
    `INSERT INTO pms.channel_sync_status (
       property_id, connection_id, sync_domain, status, last_attempt_at,
       last_error_code, last_error_message, retry_after
     ) SELECT $1::uuid, connection.id, $2, $3, $4::timestamptz, $5, $6, $7::timestamptz
       FROM pms.channel_connections connection
       WHERE connection.property_id = $1::uuid AND connection.provider = 'channex'
     ON CONFLICT (connection_id, sync_domain) DO UPDATE SET status = EXCLUDED.status,
       last_attempt_at = EXCLUDED.last_attempt_at, last_error_code = EXCLUDED.last_error_code,
       last_error_message = EXCLUDED.last_error_message, retry_after = EXCLUDED.retry_after,
       updated_at = EXCLUDED.last_attempt_at`,
    [
      job.propertyId,
      domain,
      input.retryAt ? "degraded" : "failed",
      input.now.toISOString(),
      failure.code,
      failure.message.slice(0, 500),
      input.retryAt?.toISOString() ?? null,
    ],
  );
}

async function upsertSyncSuccess(
  client: ChannexManagementQueryClient,
  propertyId: string,
  domain: string,
  now: Date,
) {
  await client.query(
    `INSERT INTO pms.channel_sync_status (
       property_id, connection_id, sync_domain, status, last_attempt_at, last_success_at
     ) SELECT $1::uuid, connection.id, $2, 'ok', $3::timestamptz, $3::timestamptz
       FROM pms.channel_connections connection
       WHERE connection.property_id = $1::uuid AND connection.provider = 'channex'
     ON CONFLICT (connection_id, sync_domain) DO UPDATE SET status = 'ok',
       last_attempt_at = EXCLUDED.last_attempt_at, last_success_at = EXCLUDED.last_success_at,
       last_error_code = NULL, last_error_message = NULL, retry_after = NULL,
       updated_at = EXCLUDED.last_attempt_at`,
    [propertyId, domain, now.toISOString()],
  );
}

function syncDomain(type: PmsChannexManagementCommandInput["operationType"]) {
  if (type === "sync_ari" || type === "update_markups") return "ari";
  if (type === "sync_bookings") return "booking";
  if (type === "provision" || type === "setup_google") return "mapping";
  if (type === "install_messaging") return "message";
  return null;
}
