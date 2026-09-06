import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { after, before, test } from "node:test";
import pg from "pg";
import { configureSender } from "./inbox-email-sender.mjs";

// Provision the target migrations in this disposable local database before running.
const connectionString = process.env.INBOX_SENDER_TEST_DATABASE_URL;
assert.equal(connectionString, "postgresql://postgres@127.0.0.1:55438/vayada_inbox_sender_test");
const client = new pg.Client({ connectionString });
before(async () => {
  await client.connect();
  assert.deepEqual(
    (await client.query("SELECT current_database() AS name, inet_server_addr()::text AS address"))
      .rows[0],
    { name: "vayada_inbox_sender_test", address: "127.0.0.1/32" },
  );
});
after(() => client.end());

async function fixture() {
  const [propertyId, membershipId, organization, actor] = Array.from({ length: 4 }, randomUUID);
  await client.query("INSERT INTO identity.users(id,email) VALUES ($1,'operator@example.test')", [
    actor,
  ]);
  await client.query(
    "INSERT INTO identity.organizations(id,kind,name,slug) VALUES ($1::uuid,'hotel_group','Test',$1::uuid::text)",
    [organization],
  );
  await client.query(
    "INSERT INTO hotel_catalog.properties(id,public_id,display_name,lifecycle_status) VALUES ($1::uuid,$1::uuid::text,'Test','active')",
    [propertyId],
  );
  await client.query(
    "INSERT INTO identity.organization_memberships(id,organization_id,user_id,role_key,property_access_mode,access_origin) VALUES ($1,$2,$3,'owner','all','agency')",
    [membershipId, organization, actor],
  );
  await client.query(
    "INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship) VALUES ($1,'pms','pms_property',$2,'owner')",
    [organization, propertyId],
  );
  return {
    database: "vayada_inbox_sender_test",
    propertyId,
    membershipId,
    operationId: randomUUID(),
    fromAddress: "bookings@example.test",
    verifiedDomain: "example.test",
    approvalRef: "VAY-1381:synthetic-test",
    state: "approved",
  };
}
async function route(input) {
  return (
    (
      await client.query(
        "SELECT to_jsonb(r) AS route FROM pms.inbox_email_routes r WHERE property_id=$1",
        [input.propertyId],
      )
    ).rows[0]?.route ?? null
  );
}
const preview = (input) => configureSender(client, input);
const apply = async (input) => configureSender(client, input, (await preview(input)).previewHash);

test("preview, atomic approval/audit, replay, disable and stale enable replay", async () => {
  const input = await fixture();
  const p = await preview(input);
  assert.equal(p.status, "preview");
  assert.equal(await route(input), null);
  assert.equal((await configureSender(client, input, p.previewHash)).status, "applied");
  const enabled = await route(input);
  assert.equal(enabled.sender_status, "approved");
  assert.equal(enabled.approved_by_membership_id, input.membershipId);
  assert.equal((await configureSender(client, input, p.previewHash)).status, "already_applied");
  assert.deepEqual(await route(input), enabled);
  await assert.rejects(
    configureSender(client, { ...input, fromAddress: "other@example.test" }, p.previewHash),
    /operation_conflict/,
  );
  const disabled = { ...input, operationId: randomUUID(), state: "disabled" };
  await apply(disabled);
  assert.equal((await route(input)).sender_status, "disabled");
  assert.equal((await configureSender(client, input, p.previewHash)).status, "already_applied");
  assert.equal((await route(input)).sender_status, "disabled");
  const audits = (
    await client.query(
      "SELECT private_payload FROM platform.product_audit_events WHERE property_id=$1 ORDER BY occurred_at",
      [input.propertyId],
    )
  ).rows;
  assert.equal(audits.length, 2);
  assert.equal(audits[0].private_payload.before, null);
  assert.deepEqual(audits[1].private_payload.before, enabled);
});

test("rejects wrong database, property, membership, domain and header injection", async () => {
  const input = await fixture();
  for (const [patch, error] of [
    [{ database: "wrong" }, /wrong_database/],
    [{ propertyId: randomUUID() }, /active_property_owner_required/],
    [{ membershipId: (await fixture()).membershipId }, /active_property_owner_required/],
    [{ verifiedDomain: "other.test" }, /sender_domain_mismatch/],
    [{ fromAddress: "bookings@example.test\r\nBcc:other@example.test" }, /invalid_sender/],
  ])
    await assert.rejects(preview({ ...input, ...patch }), error);
  assert.equal(await route(input), null);
});

test("revoked membership and changed preview fail closed", async () => {
  const input = await fixture();
  const p = await preview(input);
  await client.query(
    "UPDATE identity.organization_memberships SET status='suspended' WHERE id=$1",
    [input.membershipId],
  );
  await assert.rejects(
    configureSender(client, input, p.previewHash),
    /active_property_owner_required/,
  );
  await client.query("UPDATE identity.organization_memberships SET status='active' WHERE id=$1", [
    input.membershipId,
  ]);
  await apply({ ...input, operationId: randomUUID() });
  await assert.rejects(configureSender(client, input, p.previewHash), /preview_changed/);
});

test("approval is blocked by pending work; disable remains available", async () => {
  const input = await fixture();
  await apply(input);
  const thread = randomUUID();
  await client.query(
    "INSERT INTO pms.message_threads(id,property_id,source,source_thread_id,delivery_channel) VALUES ($1::uuid,$2,'manual',$1::uuid::text,'email')",
    [thread, input.propertyId],
  );
  await client.query(
    "INSERT INTO pms.messages(property_id,thread_id,source_message_id,direction,sent_at,delivery_state,delivery_channel) VALUES ($1,$2,'pending-test','outbound',now(),'queued','email')",
    [input.propertyId, thread],
  );
  await assert.rejects(
    preview({ ...input, operationId: randomUUID() }),
    /pending_delivery_requires_reconciliation/,
  );
  await apply({ ...input, operationId: randomUUID(), state: "disabled" });
  assert.equal((await route(input)).sender_status, "disabled");
});

test("audit failure rolls back the sender mutation", async () => {
  const input = await fixture();
  const p = await preview(input);
  const failing = {
    connectionParameters: client.connectionParameters,
    query: (sql, values) => {
      if (sql.includes("INSERT INTO platform.product_audit_events"))
        throw new Error("injected_audit_failure");
      return client.query(sql, values);
    },
  };
  await assert.rejects(configureSender(failing, input, p.previewHash), /injected_audit_failure/);
  assert.equal(await route(input), null);
});

test("preview and replay are bound to the configured endpoint and cluster", async () => {
  const input = await fixture();
  const p = await preview(input);
  assert.match(p.identity.cluster_id, /^\d+$/);
  assert.equal(p.identity.endpoint.host, "127.0.0.1");
  assert.equal(JSON.stringify(p).includes("password"), false);
  const otherEndpoint = {
    connectionParameters: { ...client.connectionParameters, host: "other-environment.test" },
    query: (...args) => client.query(...args),
  };
  await assert.rejects(configureSender(otherEndpoint, input, p.previewHash), /preview_changed/);
  assert.equal(await route(input), null);
  await configureSender(client, input, p.previewHash);
  await assert.rejects(configureSender(otherEndpoint, input, p.previewHash), /operation_conflict/);
});

test("approval waits for an accepted reply then rejects its newly committed queue entry", async () => {
  const input = await fixture();
  await apply(input);
  const change = { ...input, operationId: randomUUID(), fromAddress: "other@example.test" };
  const p = await preview(change);
  const configured = await route(input);
  const concurrent = new pg.Client({ connectionString });
  await concurrent.connect();
  let outcome;
  try {
    const pid = (await concurrent.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await client.query("BEGIN");
    await client.query("SELECT id FROM hotel_catalog.properties WHERE id=$1 FOR SHARE", [
      input.propertyId,
    ]);
    outcome = configureSender(concurrent, change, p.previewHash).then(
      (result) => ({ result }),
      (error) => ({ error }),
    );
    let blocked = false;
    const deadline = Date.now() + 3000;
    while (!blocked && Date.now() < deadline) {
      blocked = (
        await client.query("SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked", [pid])
      ).rows[0].blocked;
      if (!blocked) await setTimeout(10);
    }
    assert.equal(blocked, true, "approval must wait on the reply's property lock");
    const thread = randomUUID();
    await client.query(
      "INSERT INTO pms.message_threads(id,property_id,source,source_thread_id,delivery_channel) VALUES ($1::uuid,$2,'manual',$1::uuid::text,'email')",
      [thread, input.propertyId],
    );
    await client.query(
      "INSERT INTO pms.messages(property_id,thread_id,source_message_id,direction,sent_at,delivery_state,delivery_channel) VALUES ($1,$2,'race-test','outbound',now(),'queued','email')",
      [input.propertyId, thread],
    );
    await client.query("COMMIT");
    assert.match((await outcome).error?.message ?? "", /pending_delivery_requires_reconciliation/);
    assert.deepEqual(await route(input), configured);
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM platform.product_audit_events WHERE property_id=$1",
          [input.propertyId],
        )
      ).rows[0].count,
      1,
    );
  } finally {
    await client.query("ROLLBACK");
    await outcome;
    await concurrent.end();
  }
});
