import { createHash } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// prettier-ignore
import { FINANCE_FOLIO_EXPORT_TTL_MS, createPgFinanceFolioExportJobRepository, parseFinanceFolioExportJobPayload } from "./financeFolioExportRepository.js";

const URL = process.env["TEST_DATABASE_URL"];
const SEARCH_DIGEST_KEY = "VAY-1134-test-search-digest-key!";
// prettier-ignore
const ACTOR = "11340000-0000-4000-8000-000000000001", PROPERTY_A = "11340000-0000-4000-8000-000000000002", PROPERTY_B = "11340000-0000-4000-8000-000000000003", MISSING = "11340000-0000-4000-8000-000000000004", REVISION = "11340000-0000-4000-8000-000000000005", ORG = "11340000-0000-4000-8000-000000000006", CAUSE = "11340000-0000-4000-8000-000000000007", ORG_B = "11340000-0000-4000-8000-000000000008";
if (URL && !/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(URL).pathname))
  throw new Error("Unsafe test database");

describe.skipIf(!URL)("PostgreSQL Finance folio export jobs", () => {
  const admin = new pg.Client({ connectionString: URL ?? "postgresql://disabled" });
  // prettier-ignore
  const repository = createPgFinanceFolioExportJobRepository({ connectionString: URL ?? "postgresql://disabled", searchDigestKey: SEARCH_DIGEST_KEY });
  beforeAll(async () => admin.connect());
  beforeEach(async () => {
    await cleanup();
    await admin.query(`INSERT INTO identity.users(id,email,name,status) VALUES('${ACTOR}','folio-export@example.test','Folio export','active'); INSERT INTO identity.organizations(id,kind,name,slug,status) VALUES('${ORG}','hotel_group','Export org','folio-export-org','active'),('${ORG_B}','hotel_group','Other org','folio-export-other','active'); INSERT INTO identity.organization_memberships(organization_id,user_id,status,role_key) VALUES('${ORG}','${ACTOR}','active','owner'),('${ORG_B}','${ACTOR}','active','owner');
      INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES('${PROPERTY_A}','folio-export-a','Export A'),('${PROPERTY_B}','folio-export-b','Export B'); INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship,status) VALUES('${ORG}','pms','pms_property','${PROPERTY_A}','owner','active'),('${ORG}','pms','pms_property','${PROPERTY_B}','owner','active'); INSERT INTO pms.property_pricing_settings(property_id,currency) VALUES('${PROPERTY_A}','EUR'),('${PROPERTY_B}','EUR')`);
  });
  // prettier-ignore
  afterAll(async () => { await repository.close(); await cleanup(); await admin.end(); });

  it("serializes replay, rejects changed reuse, and keeps PII in the private job", async () => {
    const shared = command("shared");
    const results = await Promise.all([repository.enqueue(shared), repository.enqueue(shared)]);
    expect(results.map(({ status }) => status).sort()).toEqual(["created", "replayed"]);
    // prettier-ignore
    expect(results[0]).toMatchObject({ exportId: results[1]!.status === "conflict" ? "" : results[1]!.exportId });
    // prettier-ignore
    await expect(repository.enqueue({ ...shared, audit: { ...shared.audit, requestId: "retry", correlationId: "retry", requestedAt: "2026-08-21T11:00:00.000Z" } })).resolves.toMatchObject({ status: "replayed" });
    const changed = command("shared");
    // prettier-ignore
    changed.filters = changed.snapshot.filters = { state: "ready", search: "changed", sort: "createdAt_desc" };
    await expect(repository.enqueue(changed)).resolves.toEqual({ status: "conflict" });
    // prettier-ignore
    await expect(repository.enqueue({ ...shared, commandId: MISSING })).resolves.toEqual({ status: "conflict" });
    // prettier-ignore
    await expect(repository.enqueue(command("shared", PROPERTY_B))).resolves.toMatchObject({ status: "created" });

    const evidence = await admin.query(
      `SELECT j.payload,j.job_metadata,j.ai_visible AS "jobAiVisible",a.redacted_payload,a.private_payload,
        a.audit_metadata,a.correlation_id,a.causation_id,a.actor_user_id::text,i.key_hash,
        extract(epoch FROM ((j.job_metadata->>'expiresAt')::timestamptz-(j.job_metadata->>'acceptedAt')::timestamptz))*1000 AS ttl,
        to_jsonb(a)::text AS audit FROM platform.jobs j JOIN platform.product_audit_events a ON a.job_id=j.id
        JOIN platform.idempotency_keys i ON i.id=j.id WHERE j.property_id=$1::uuid`,
      [PROPERTY_A],
    );
    expect(evidence.rowCount).toBe(1);
    // prettier-ignore
    expect(evidence.rows[0].payload).toMatchObject({ organizationId: ORG, snapshot: { propertyId: PROPERTY_A, currency: "EUR", filters: { search: "guest@example.test" }, manifest: [] } });
    // prettier-ignore
    expect(evidence.rows[0].job_metadata).toMatchObject({ actorUserId: ACTOR, organizationId: ORG, requestId: "request-shared", correlationId: "correlation-shared", causationId: CAUSE, requestedAt: "2026-08-21T10:00:00.000Z", payloadFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), manifestDigest: fingerprint([]) });
    // prettier-ignore
    expect(evidence.rows[0].redacted_payload).toMatchObject({ filters: { searchPresent: true, searchHash: "e3e242b81d2d2ad0c1b2f580bd934e472aa0295ee01f8499579c14ef0fdfd2a0" }, manifestDigest: fingerprint([]) });
    // prettier-ignore
    expect(evidence.rows[0]).toMatchObject({ jobAiVisible: false, correlation_id: "correlation-shared", causation_id: CAUSE, actor_user_id: ACTOR });
    expect(evidence.rows[0].private_payload).toEqual({});
    expect(Number(evidence.rows[0].ttl)).toBe(FINANCE_FOLIO_EXPORT_TTL_MS);
    expect(evidence.rows[0].audit).not.toContain("guest@example.test");
    // prettier-ignore
    expect(JSON.stringify(evidence.rows[0])).not.toMatch(/VAY-1134-shared|recipient|must-not-leak/i);
    // prettier-ignore
    await admin.query("UPDATE platform.idempotency_keys SET expires_at='2000-01-01T00:00:00.000Z' WHERE property_id=$1", [PROPERTY_A]);
    await expect(repository.enqueue(shared)).resolves.toEqual({ status: "conflict" });
  });

  it("retains the first manifest when a pre-existing transaction commits before retry", async () => {
    const peer = new pg.Client({ connectionString: URL! });
    await peer.connect();
    let first;
    try {
      await peer.query("BEGIN");
      // prettier-ignore
      await peer.query(`INSERT INTO finance.folios(id,property_id) VALUES('${MISSING}','${PROPERTY_A}'); INSERT INTO finance.folio_revisions(id,folio_id,property_id,revision,state,recipient_snapshot_ciphertext,recipient_encryption_scheme,recipient_key_version,recipient_fingerprint,recipient_fingerprint_key_version,service_from,service_to,currency,total_amount,source_digest,source_freshness) VALUES('${REVISION}','${MISSING}','${PROPERTY_A}',1,'ready',decode(repeat('ab',32),'hex'),'envelope_aead_v1','key-1',repeat('a',64),'fingerprint-1','2026-08-01','2026-08-01','EUR',1,repeat('b',64),'{}'); INSERT INTO finance.folio_lines(folio_revision_id,folio_id,property_id,folio_revision,currency,position,kind,description,quantity,unit_amount,service_on,source_type,source_id,source_revision) VALUES('${REVISION}','${MISSING}','${PROPERTY_A}',1,'EUR',1,'fee','Late',1,1,'2026-08-01','finance','late:1',1)`);
      first = await repository.enqueue(command("late", PROPERTY_A, []));
      await peer.query("COMMIT");
    } finally {
      await peer.query("ROLLBACK").catch(() => undefined);
      await peer.end();
    }
    // prettier-ignore
    const selected = [{ folioId: MISSING, revisionId: REVISION, revision: 1, sourceDigest: "b".repeat(64) }];
    // prettier-ignore
    await expect(repository.enqueue(command("late", PROPERTY_A, selected))).resolves.toMatchObject({ status: "replayed", exportId: first.status === "conflict" ? "" : first.exportId });
    // prettier-ignore
    const stored = await admin.query("SELECT payload FROM platform.jobs WHERE id=$1", [first.status === "conflict" ? PROPERTY_B : first.exportId]);
    expect(stored.rows[0].payload.snapshot.manifest).toEqual([]);
  });

  it("rolls back the idempotency key, job, and audit together", async () => {
    // prettier-ignore
    for (const [key, organizationId] of [["wrong-org", ORG_B], ["missing-org", MISSING]] as const)
      await expect(repository.enqueue({ ...command(key), organizationId })).rejects.toBeInstanceOf(TypeError);
    const invalid = command("rollback");
    invalid.audit.actorUserId = MISSING;
    await expect(repository.enqueue(invalid)).rejects.toBeInstanceOf(TypeError);
    const future = command("future-snapshot");
    future.snapshot.snapshotAt = new Date(Date.now() + 3_600_000).toISOString();
    await expect(repository.enqueue(future)).rejects.toBeInstanceOf(TypeError);
    // prettier-ignore
    const residue = await admin.query(`SELECT ((SELECT count(*) FROM platform.jobs WHERE property_id=$1)+(SELECT count(*) FROM platform.idempotency_keys WHERE property_id=$1)+(SELECT count(*) FROM platform.product_audit_events WHERE property_id=$1))::int count`, [PROPERTY_A]);
    expect(residue.rows[0].count).toBe(0);
  });

  // prettier-ignore
  function command(key: string, propertyId = PROPERTY_A, manifest: Array<{ folioId: string; revisionId: string; revision: number; sourceDigest: string }> = []) { const filters = { state: "ready" as const, search: "guest@example.test", sort: "createdAt_desc" as const }; return { commandId: REVISION, idempotencyKey: `VAY-1134-${key}`, organizationId: ORG, propertyId, currency: "EUR", filters, snapshot: { formatVersion: "pms-financials-folios.v1" as const, propertyId, currency: "EUR", filters, snapshotAt: new Date(Date.now() - 60_000).toISOString(), manifest }, audit: { actorUserId: ACTOR, requestId: `request-${key}`, correlationId: `correlation-${key}`, causationId: CAUSE, requestedAt: "2026-08-21T10:00:00.000Z" } }; }
  // prettier-ignore
  async function cleanup() { await admin.query(`BEGIN; SET LOCAL session_replication_role=replica; DELETE FROM platform.product_audit_events WHERE property_id IN ('${PROPERTY_A}','${PROPERTY_B}'); DELETE FROM platform.jobs WHERE property_id IN ('${PROPERTY_A}','${PROPERTY_B}'); DELETE FROM platform.idempotency_keys WHERE property_id IN ('${PROPERTY_A}','${PROPERTY_B}'); DELETE FROM finance.folio_payment_references WHERE property_id IN ('${PROPERTY_A}','${PROPERTY_B}'); DELETE FROM finance.folio_lines WHERE property_id IN ('${PROPERTY_A}','${PROPERTY_B}'); DELETE FROM finance.folio_revisions WHERE property_id IN ('${PROPERTY_A}','${PROPERTY_B}'); DELETE FROM finance.folios WHERE property_id IN ('${PROPERTY_A}','${PROPERTY_B}'); DELETE FROM pms.property_pricing_settings WHERE property_id IN ('${PROPERTY_A}','${PROPERTY_B}'); DELETE FROM hotel_catalog.properties WHERE id IN ('${PROPERTY_A}','${PROPERTY_B}'); DELETE FROM identity.organization_resource_links WHERE organization_id IN ('${ORG}','${ORG_B}'); DELETE FROM identity.organization_memberships WHERE organization_id IN ('${ORG}','${ORG_B}'); DELETE FROM identity.organizations WHERE id IN ('${ORG}','${ORG_B}'); DELETE FROM identity.users WHERE id='${ACTOR}'; COMMIT`); }
});

it("binds job payloads to durable scope, fingerprint, timestamps, and expiry", () => {
  const filters = { sort: "createdAt_desc" as const, state: "ready" as const };
  // prettier-ignore
  const snapshot = { formatVersion: "pms-financials-folios.v1" as const, propertyId: PROPERTY_A, currency: "EUR", filters, snapshotAt: "2026-08-21T09:59:59.999Z", manifest: [{ folioId: PROPERTY_B, revisionId: MISSING, revision: 1, sourceDigest: "c".repeat(64) }] };
  // prettier-ignore
  const payload = { commandId: REVISION, organizationId: ORG, snapshot, expiresAt: "2026-08-22T10:00:00.000Z" };
  // prettier-ignore
  const expected = { organizationId: ORG, propertyId: PROPERTY_A, currency: "EUR", payloadFingerprint: fingerprint(payload), acceptedAt: "2026-08-21T10:00:00.000Z", snapshotAt: snapshot.snapshotAt, expiresAt: payload.expiresAt, now: new Date("2026-08-21T11:00:00.000Z") };
  expect(parseFinanceFolioExportJobPayload(payload, expected)).toEqual(payload);
  // prettier-ignore
  expect(() => parseFinanceFolioExportJobPayload({ ...payload, commandId: MISSING }, expected)).toThrow();
  // prettier-ignore
  expect(() => parseFinanceFolioExportJobPayload({ ...payload, snapshot: { ...snapshot, manifest: [{ ...snapshot.manifest[0]!, sourceDigest: "d".repeat(64) }] } }, expected)).toThrow();
  // prettier-ignore
  expect(() => parseFinanceFolioExportJobPayload(payload, { ...expected, propertyId: PROPERTY_B })).toThrow();
  // prettier-ignore
  expect(() => parseFinanceFolioExportJobPayload(payload, { ...expected, organizationId: PROPERTY_B })).toThrow();
  // prettier-ignore
  expect(() => parseFinanceFolioExportJobPayload(payload, { ...expected, currency: "USD" })).toThrow();
  // prettier-ignore
  expect(() => parseFinanceFolioExportJobPayload(payload, { ...expected, payloadFingerprint: "d".repeat(64) })).toThrow();
  // prettier-ignore
  expect(() => parseFinanceFolioExportJobPayload(payload, { ...expected, snapshotAt: "2026-08-21T09:59:59.998Z" })).toThrow();
  // prettier-ignore
  expect(() => parseFinanceFolioExportJobPayload(payload, { ...expected, acceptedAt: "2026-08-21T10:00:00.001Z" })).toThrow();
  // prettier-ignore
  expect(() => parseFinanceFolioExportJobPayload(payload, { ...expected, now: new Date(payload.expiresAt) })).toThrow();
  const future = { ...payload, snapshot: { ...snapshot, snapshotAt: "2026-08-21T10:00:00.001Z" } };
  // prettier-ignore
  expect(() => parseFinanceFolioExportJobPayload(future, { ...expected, snapshotAt: future.snapshot.snapshotAt, payloadFingerprint: fingerprint(future) })).toThrow();
  const extended = { ...payload, expiresAt: "2026-08-22T10:00:00.001Z" };
  // prettier-ignore
  expect(() => parseFinanceFolioExportJobPayload(extended, { ...expected, expiresAt: extended.expiresAt, payloadFingerprint: fingerprint(extended) })).toThrow();
});

// prettier-ignore
const fingerprint = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
