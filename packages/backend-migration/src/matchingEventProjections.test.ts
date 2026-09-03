import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0142_marketplace_matching_event_projections.sql"),
  "utf8",
);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const ids = {
  actor: "10000000-0000-4000-8000-000000000001",
  creator: "20000000-0000-4000-8000-000000000001",
  creatorOrg: "30000000-0000-4000-8000-000000000001",
  hotelOrg: "30000000-0000-4000-8000-000000000002",
  property: "40000000-0000-4000-8000-000000000001",
  offer: "50000000-0000-4000-8000-000000000001",
  collaboration: "60000000-0000-4000-8000-000000000001",
} as const;
const occurredAt = "2026-09-03T00:00:00.000Z";
const recordedAt = "2026-09-03T01:00:00.000Z";

describe("Marketplace matching event projection migration contract", () => {
  it("uses a normalized, privacy-safe projection with exact resource links", () => {
    expect(migration).toContain("CREATE TABLE marketplace.matching_event_projections");
    expect(migration).toContain("REFERENCES platform.domain_events(id, property_id)");
    expect(migration).toContain("REFERENCES marketplace.creator_profiles(id, organization_id)");
    expect(migration).toContain("chk_platform_matching_event_private_payload");
    expect(migration).not.toMatch(
      /\b(?:raw_demographics|provider_payload|handle|contact_data|profile_text|portfolio_text|message|travel_notes|private_preferences|content_url|private_thresholds)\b/i,
    );
  });
});

describe.skipIf(!TEST_DATABASE_URL)(
  "Marketplace matching event projection migration (PostgreSQL)",
  () => {
    let client: pg.Client;

    beforeEach(async () => {
      assertSafeTestDatabase(TEST_DATABASE_URL!);
      client = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await client.connect();
      await client.query(fixtureSql);
    });

    afterEach(async () => {
      try {
        await client.query("DROP SCHEMA IF EXISTS marketplace, platform, identity CASCADE");
      } finally {
        await client.end();
      }
    });

    it("creates safe columns, exact foreign keys, and UTC retention metadata", async () => {
      await client.query(migration);
      const constraints = await client.query<{ name: string }>(
        `SELECT constraint_name AS name FROM information_schema.table_constraints
       WHERE table_schema='marketplace' AND table_name='matching_event_projections'`,
      );
      const columns = await client.query<{ name: string }>(
        `SELECT column_name AS name FROM information_schema.columns
       WHERE table_schema='marketplace' AND table_name='matching_event_projections'`,
      );
      const index = await client.query<{ definition: string }>(
        `SELECT indexdef AS definition FROM pg_indexes
         WHERE schemaname='marketplace' AND indexname='idx_marketplace_matching_event_retention'`,
      );
      expect(constraints.rows.filter(({ name }) => name.startsWith("fk_"))).toHaveLength(5);
      expect(columns.rows.map(({ name }) => name).sort()).toEqual([
        "actor_user_id",
        "collaboration_id",
        "contract_version",
        "correlation_id",
        "creator_organization_id",
        "creator_profile_id",
        "domain_event_id",
        "event_type",
        "hotel_organization_id",
        "occurred_at",
        "offer_id",
        "property_id",
        "recorded_at",
        "retention_expires_at",
        "revision",
        "source_id",
      ]);
      expect(index.rows[0]?.definition).toContain("(retention_expires_at)");
      for (const field of ["payload", "event_metadata"])
        await expect(
          client.query(
            `INSERT INTO platform.domain_events
         (id,source_system,event_key,event_type,event_version,occurred_at,recorded_at,property_id,
          correlation_id,actor_user_id,resource_product,resource_type,resource_id,${field})
         VALUES ($1,'marketplace','private:1','marketplace.match.saved.v1',1,$2,$2,$3,
           'private-test',$4,'marketplace','matching_event','private',$5)`,
            [randomUUID(), occurredAt, ids.property, ids.actor, { message: "private" }],
          ),
        ).rejects.toMatchObject({ constraint: "chk_platform_matching_event_private_payload" });
      const domainEventId = await insertProjection(client, {});
      const retained = await client.query<{ expiresAt: Date }>(
        `SELECT retention_expires_at AS "expiresAt" FROM marketplace.matching_event_projections
       WHERE domain_event_id=$1`,
        [domainEventId],
      );
      expect(retained.rows[0]?.expiresAt.toISOString()).toBe("2028-03-03T01:00:00.000Z");
      await expect(insertProjection(client, { recordedAt: "infinity" })).rejects.toMatchObject({
        constraint: "chk_marketplace_matching_event_base",
      });
    });

    it("rejects duplicate source identities and invalid pair or envelope references", async () => {
      await client.query(migration);
      const sourceId = randomUUID();
      await insertProjection(client, { sourceId });
      await expect(insertProjection(client, { sourceId })).rejects.toMatchObject({
        code: "23505",
        constraint: "uq_marketplace_matching_event_source",
      });
      await expect(
        insertProjection(client, { creatorOrganizationId: ids.hotelOrg }),
      ).rejects.toMatchObject({
        code: "23503",
        constraint: "fk_marketplace_matching_event_creator",
      });
      await expect(
        insertProjection(client, { collaborationId: randomUUID() }),
      ).rejects.toMatchObject({
        code: "23503",
        constraint: "fk_marketplace_matching_event_collaboration",
      });
      for (const mismatch of [
        { envelopeEventType: "marketplace.match.accepted.v1" },
        { envelopeEventKey: "wrong:identity:1" },
        { envelopeResourceId: randomUUID() },
      ])
        await expect(insertProjection(client, mismatch)).rejects.toMatchObject({
          code: "23514",
          constraint: "chk_marketplace_matching_event_envelope",
        });
    });

    it("keeps projection facts append-only", async () => {
      await client.query(migration);
      await insertProjection(client, {});
      for (const statement of [
        "UPDATE marketplace.matching_event_projections SET revision=2",
        "DELETE FROM marketplace.matching_event_projections",
        "TRUNCATE marketplace.matching_event_projections",
      ])
        await expect(client.query(statement)).rejects.toMatchObject({ code: "55000" });
    });

    it("rolls back all DDL when an append-only prerequisite is missing", async () => {
      await client.query("DROP FUNCTION platform.prevent_append_only_mutation()");
      await client.query("BEGIN");
      await expect(client.query(migration)).rejects.toThrow();
      await client.query("ROLLBACK");
      const result = await client.query<{ tableName: string | null }>(
        "SELECT to_regclass('marketplace.matching_event_projections')::text AS \"tableName\"",
      );
      expect(result.rows).toEqual([{ tableName: null }]);
    });
  },
);

type ProjectionInput = {
  sourceId?: string;
  collaborationId?: string;
  creatorOrganizationId?: string;
  envelopeEventType?: string;
  envelopeEventKey?: string;
  envelopeResourceId?: string;
  recordedAt?: string;
};

async function insertProjection(client: pg.Client, input: ProjectionInput): Promise<string> {
  const domainEventId = randomUUID();
  const eventType = "marketplace.match.saved.v1";
  const sourceId = input.sourceId ?? randomUUID();
  const acceptedAt = input.recordedAt ?? recordedAt;
  await client.query(
    `INSERT INTO platform.domain_events VALUES
     ($1,'marketplace',$2,$3,1,$4,$5,$6,'correlation-1',$7,'marketplace',
      'matching_event',$8,'{}','{}')`,
    [
      domainEventId,
      input.envelopeEventKey ?? `${eventType}:${sourceId}:1`,
      input.envelopeEventType ?? eventType,
      occurredAt,
      acceptedAt,
      ids.property,
      ids.actor,
      input.envelopeResourceId ?? sourceId,
    ],
  );
  await client.query(
    `INSERT INTO marketplace.matching_event_projections (
       domain_event_id,event_type,source_id,revision,actor_user_id,creator_profile_id,
       creator_organization_id,hotel_organization_id,property_id,offer_id,collaboration_id,
       contract_version,correlation_id,occurred_at,recorded_at)
     VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,'marketplace-matching-contract.v2',
       'correlation-1',$11,$12)`,
    [
      domainEventId,
      eventType,
      sourceId,
      ids.actor,
      ids.creator,
      input.creatorOrganizationId ?? ids.creatorOrg,
      ids.hotelOrg,
      ids.property,
      ids.offer,
      input.collaborationId ?? null,
      occurredAt,
      acceptedAt,
    ],
  );
  return domainEventId;
}

const fixtureSql = `
DROP SCHEMA IF EXISTS marketplace, platform, identity CASCADE;
CREATE SCHEMA identity; CREATE SCHEMA platform; CREATE SCHEMA marketplace;
CREATE TABLE identity.users (id UUID PRIMARY KEY);
CREATE TABLE marketplace.creator_profiles (id UUID, organization_id UUID, UNIQUE(id, organization_id));
CREATE TABLE marketplace.marketplace_offers (
  id UUID, property_id UUID, organization_id UUID, UNIQUE(id, property_id, organization_id));
CREATE TABLE marketplace.collaborations (
  id UUID PRIMARY KEY, creator_profile_id UUID, creator_organization_id UUID,
  offer_id UUID, property_id UUID, hotel_organization_id UUID);
CREATE TABLE platform.domain_events (
  id UUID PRIMARY KEY, source_system TEXT, event_key TEXT, event_type TEXT, event_version INTEGER,
  occurred_at TIMESTAMPTZ, recorded_at TIMESTAMPTZ, property_id UUID,
  correlation_id TEXT, actor_user_id UUID, resource_product TEXT, resource_type TEXT, resource_id TEXT,
  payload JSONB DEFAULT '{}', event_metadata JSONB DEFAULT '{}', UNIQUE(id, property_id));
CREATE FUNCTION platform.prevent_append_only_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'append-only' USING ERRCODE='55000'; END $$;
INSERT INTO identity.users VALUES ('${ids.actor}');
INSERT INTO marketplace.creator_profiles VALUES ('${ids.creator}','${ids.creatorOrg}');
INSERT INTO marketplace.marketplace_offers VALUES ('${ids.offer}','${ids.property}','${ids.hotelOrg}');
INSERT INTO marketplace.collaborations VALUES
  ('${ids.collaboration}','${ids.creator}','${ids.creatorOrg}','${ids.offer}','${ids.property}','${ids.hotelOrg}');
`;
