import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const requireThat = (condition, code) => {
  if (!condition) throw new Error(code);
};

// Privileged operations tool, not an HTTP authorization boundary. No provider calls.
export async function configureSender(client, input, expectedHash) {
  const {
    database,
    propertyId,
    membershipId,
    operationId,
    fromAddress,
    verifiedDomain,
    approvalRef,
    state,
  } = input;
  for (const id of [propertyId, membershipId, operationId])
    requireThat(
      typeof id === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id),
      "invalid_id",
    );
  requireThat(
    typeof database === "string" && /^[a-zA-Z0-9_-]{1,63}$/.test(database),
    "invalid_database",
  );
  requireThat(["approved", "disabled"].includes(state), "invalid_state");
  requireThat(
    typeof approvalRef === "string" && /^VAY-\d+:[a-zA-Z0-9:_-]{1,120}$/.test(approvalRef),
    "invalid_approval_reference",
  );
  requireThat(
    typeof fromAddress === "string" &&
      fromAddress.length <= 320 &&
      /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(fromAddress),
    "invalid_sender",
  );
  requireThat(fromAddress.split("@")[1] === verifiedDomain, "sender_domain_mismatch");
  requireThat(
    expectedHash === undefined || /^[a-f0-9]{64}$/.test(expectedHash),
    "invalid_preview_hash",
  );
  const request = {
    database,
    propertyId,
    membershipId,
    operationId,
    fromAddress,
    verifiedDomain,
    approvalRef,
    state,
  };
  const auditKey = `pms.inbox.email_sender.setup:${operationId}`;
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    await client.query("SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '10s'");
    const { host, port, user } = client.connectionParameters;
    const identity = {
      endpoint: { host, port, user },
      ...(
        await client.query(
          `SELECT current_database() AS database, inet_server_addr()::text AS address,
          inet_server_port() AS port, system_identifier::text AS cluster_id FROM pg_control_system()`,
        )
      ).rows[0],
    };
    requireThat(identity.database === database, "wrong_database");
    const fingerprint = hash({ identity, request });
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `inbox-email-sender:${propertyId}`,
    ]);
    const owners = await client.query(
      `SELECT m.user_id, m.organization_id
       FROM hotel_catalog.properties p
       JOIN identity.organization_resource_links r ON r.resource_id = p.id::text
         AND r.product = 'pms' AND r.resource_type = 'pms_property'
         AND r.relationship = 'owner' AND r.status = 'active'
       JOIN identity.organizations o ON o.id = r.organization_id
         AND o.kind = 'hotel_group' AND o.status = 'active'
       JOIN identity.organization_memberships m ON m.organization_id = o.id
         AND m.id = $2::uuid AND m.status = 'active' AND m.role_key = 'owner'
         AND m.property_access_mode = 'all'
       JOIN identity.users u ON u.id = m.user_id AND u.status = 'active'
       WHERE p.id = $1::uuid AND p.lifecycle_status = 'active'
       FOR UPDATE OF p FOR SHARE OF r, o, m, u`,
      [propertyId, membershipId],
    );
    requireThat(owners.rows.length === 1, "active_property_owner_required");
    const before =
      (
        await client.query(
          "SELECT to_jsonb(r) AS route FROM pms.inbox_email_routes r WHERE property_id = $1::uuid FOR UPDATE",
          [propertyId],
        )
      ).rows[0]?.route ?? null;
    const replay = (
      await client.query(
        "SELECT audit_metadata FROM platform.product_audit_events WHERE product = 'pms' AND audit_key = $1",
        [auditKey],
      )
    ).rows[0];
    if (replay) {
      requireThat(replay.audit_metadata.fingerprint === fingerprint, "operation_conflict");
      await client.query("ROLLBACK");
      return { status: "already_applied", current: before, identity, operationId };
    }
    const pending = (
      await client.query(
        `SELECT count(*)::int AS count FROM pms.messages
       WHERE property_id = $1::uuid AND direction = 'outbound'
         AND delivery_state IN ('queued', 'retrying')`,
        [propertyId],
      )
    ).rows[0].count;
    // Enabling cannot revive previously queued delivery without a separate reconciliation.
    requireThat(state !== "approved" || pending === 0, "pending_delivery_requires_reconciliation");
    requireThat(state !== "disabled" || before !== null, "no_sender_to_disable");
    requireThat(
      state !== "disabled" || before.from_address === fromAddress,
      "disable_sender_mismatch",
    );
    const previewHash = hash({ identity, request, before, owner: owners.rows[0], pending });
    if (expectedHash === undefined) {
      await client.query("ROLLBACK");
      return { status: "preview", identity, request, before, pending, previewHash };
    }
    requireThat(expectedHash === previewHash, "preview_changed");
    const after = (
      await client.query(
        `INSERT INTO pms.inbox_email_routes AS r
         (property_id, from_address, sender_status, policy_status, approved_at, approved_by_membership_id)
       VALUES ($1::uuid, $2, $3, $4, now(), $5::uuid)
       ON CONFLICT (property_id) DO UPDATE SET from_address = EXCLUDED.from_address,
         sender_status = EXCLUDED.sender_status, policy_status = EXCLUDED.policy_status,
         approved_at = CASE WHEN $3 = 'approved' THEN now() ELSE r.approved_at END,
         approved_by_membership_id = CASE WHEN $3 = 'approved' THEN $5::uuid ELSE r.approved_by_membership_id END,
         updated_at = now()
       RETURNING to_jsonb(r) AS route`,
        [
          propertyId,
          fromAddress,
          state,
          state === "approved" ? "allowed" : "disallowed",
          membershipId,
        ],
      )
    ).rows[0].route;
    await client.query(
      `INSERT INTO platform.product_audit_events
         (audit_key, product, action, occurred_at, tenant_scope, property_id,
          actor_type, actor_user_id, target_resource_product, target_resource_type,
          target_resource_id, correlation_id, redacted_payload, private_payload, audit_metadata)
       VALUES ($1, 'pms', 'pms.inbox.email_sender.configured', now(), 'property', $2::uuid,
         'user', $3::uuid, 'pms', 'inbox_email_route', $2::uuid::text, $4, $5::jsonb, $6::jsonb, $7::jsonb)`,
      [
        auditKey,
        propertyId,
        owners.rows[0].user_id,
        approvalRef,
        JSON.stringify({ state, membershipId, previewHash }),
        JSON.stringify({ before, after }),
        JSON.stringify({
          fingerprint,
          operationId,
          approvalRef,
          verifiedDomain,
          tool: "inbox-email-sender.v1",
        }),
      ],
    );
    await client.query("COMMIT");
    return { status: "applied", identity, operationId, previewHash, before, after };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let client;
  try {
    const [mode, path, expectedHash, ...extra] = process.argv.slice(2);
    requireThat(
      extra.length === 0 &&
        path &&
        ((mode === "preview" && !expectedHash) || (mode === "apply" && expectedHash)),
      "usage_preview_or_apply_manifest_and_hash",
    );
    requireThat(Boolean(process.env.TARGET_DATABASE_URL), "target_database_url_required");
    const request = JSON.parse(await readFile(path, "utf8"));
    client = new pg.Client({
      connectionString: process.env.TARGET_DATABASE_URL,
      connectionTimeoutMillis: 10_000,
    });
    await client.connect();
    console.log(JSON.stringify(await configureSender(client, request, expectedHash), null, 2));
  } catch (error) {
    // Never print connection strings, SQL, provider credentials or raw database errors.
    console.error(
      JSON.stringify({
        status: "error",
        code: error.code ?? (/^[a-z_]+$/.test(error.message) ? error.message : "setup_failed"),
      }),
    );
    process.exitCode = 1;
  } finally {
    await client?.end();
  }
}
