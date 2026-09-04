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
const attributionMigration = await readFile(
  join(import.meta.dirname, "../migrations/0143_marketplace_matching_impression_attribution.sql"),
  "utf8",
);
const outcomeMigration = await readFile(
  join(import.meta.dirname, "../migrations/0144_marketplace_matching_evaluation_outcomes.sql"),
  "utf8",
);
const currentOutcomeMigration = await readFile(
  join(import.meta.dirname, "../migrations/0149_marketplace_matching_current_outcomes.sql"),
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
  recommendedCollaboration: "60000000-0000-4000-8000-000000000002",
  evaluation: "70000000-0000-4000-8000-000000000001",
} as const;
const occurredAt = "2026-09-03T00:00:00.000Z";
const recordedAt = "2026-09-03T01:00:00.000Z";
const recommended = {
  attributionKind: "recommended",
  policyVersion: "matching-policy.v1",
  evaluationId: ids.evaluation,
  impressionId: "a".repeat(64),
  recommendationSessionId: "session-1",
  surface: "creator_offer_discovery",
  presentationMode: "ranked",
} as const;

describe("Marketplace matching event projection migration contract", () => {
  it("uses a normalized, privacy-safe projection with exact resource links", () => {
    expect(migration).toContain("CREATE TABLE marketplace.matching_event_projections");
    expect(migration).toContain("REFERENCES platform.domain_events(id, property_id)");
    expect(migration).toContain("REFERENCES marketplace.creator_profiles(id, organization_id)");
    expect(migration).toContain("chk_platform_matching_event_private_payload");
    expect(migration).not.toMatch(
      /\b(?:raw_demographics|provider_payload|handle|contact_data|profile_text|portfolio_text|message|travel_notes|private_preferences|content_url|private_thresholds)\b/i,
    );
    expect(outcomeMigration).not.toMatch(
      /\b(?:jsonb|free_text|message|url|payload|demographics|private_preferences)\b/i,
    );
    expect(outcomeMigration).toContain("uq_marketplace_matching_guardrail_revision");
    expect(currentOutcomeMigration).not.toMatch(/\b(?:jsonb|free_text|message|payload|cursor)\b/i);
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

    it("deduplicates qualified impressions by policy, pair, surface, and UTC day", async () => {
      await client.query(migration);
      await client.query(attributionMigration);
      await client.query(outcomeMigration);
      await expect(
        insertMatchingEvent(client, {
          ...impression("0", "2026-09-02T00:00:00.000Z"),
          evaluationId: undefined,
        }),
      ).rejects.toMatchObject({ constraint: "chk_marketplace_matching_event_context" });
      await insertMatchingEvent(client, impression("a", "2026-09-03T00:00:00.000Z"));
      await expect(
        insertMatchingEvent(client, impression("b", "2026-09-03T23:59:59.999Z")),
      ).rejects.toMatchObject({
        code: "23505",
        constraint: "uq_marketplace_matching_qualified_impression",
      });
      await insertMatchingEvent(client, impression("b", "2026-09-04T00:00:00.000Z"));
    });

    it("enforces attribution shapes and freezes collaboration attribution", async () => {
      await client.query(migration);
      await client.query(attributionMigration);
      await client.query(outcomeMigration);
      await expect(
        insertCollaboration(client, ids.collaboration, "hotel", recommended),
      ).rejects.toMatchObject({ constraint: "chk_marketplace_collaboration_matching_attribution" });
      await expect(
        insertCollaboration(client, ids.collaboration, "creator", {
          ...recommended,
          evaluationId: undefined,
        }),
      ).rejects.toMatchObject({ constraint: "chk_marketplace_collaboration_matching_attribution" });
      await insertCollaboration(client, ids.collaboration, "hotel");
      await insertMatchingEvent(client, {
        eventType: "marketplace.match.invitation_sent.v1",
        collaborationId: ids.collaboration,
        attributionKind: "organic",
      });
      await insertCollaboration(client, ids.recommendedCollaboration, "creator", recommended);
      await expect(
        insertMatchingEvent(client, {
          eventType: "marketplace.match.invitation_sent.v1",
          collaborationId: ids.recommendedCollaboration,
          ...recommended,
        }),
      ).rejects.toMatchObject({ constraint: "chk_marketplace_matching_event_context" });
      await expect(
        insertMatchingEvent(client, {
          eventType: "marketplace.match.saved.v1",
          ...recommended,
          evaluationId: undefined,
        }),
      ).rejects.toMatchObject({ constraint: "chk_marketplace_matching_event_context" });
      await expect(
        insertMatchingEvent(client, {
          eventType: "marketplace.match.accepted.v1",
          collaborationId: ids.recommendedCollaboration,
          ...recommended,
          impressionId: "b".repeat(64),
        }),
      ).rejects.toMatchObject({
        constraint: "chk_marketplace_matching_collaboration_attribution",
      });
      await expect(
        client.query("UPDATE marketplace.collaborations SET matching_impression_id=$1", [
          "b".repeat(64),
        ]),
      ).rejects.toMatchObject({
        code: "55000",
        constraint: "immutable_marketplace_collaboration_matching_attribution",
      });
      await insertMatchingEvent(client, {
        eventType: "marketplace.match.accepted.v1",
        collaborationId: ids.recommendedCollaboration,
        ...recommended,
      });
    });

    it("rejects one of two concurrent duplicate impressions", async () => {
      await client.query(migration);
      await client.query(attributionMigration);
      await client.query(outcomeMigration);
      const writer = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await writer.connect();
      try {
        const results = await Promise.allSettled([
          insertMatchingEvent(client, impression("c", "2026-09-05T10:00:00.000Z")),
          insertMatchingEvent(writer, impression("d", "2026-09-05T11:00:00.000Z")),
        ]);
        expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
        expect(results.find(({ status }) => status === "rejected")).toMatchObject({
          reason: { code: "23505", constraint: "uq_marketplace_matching_qualified_impression" },
        });
      } finally {
        await writer.end();
      }
    });

    it("enforces evaluation allowlists, score invariants, and exclusive fields", async () => {
      await client.query(migration);
      await client.query(attributionMigration);
      await client.query(outcomeMigration);
      await insertMatchingEvent(client, evaluated());
      await expect(
        insertMatchingEvent(client, {
          ...evaluated(),
          eligibilityRuleOutcomes: [...Array(8).fill("pass"), "skipped"],
        }),
      ).rejects.toMatchObject({ constraint: "chk_marketplace_matching_event_evaluation" });
      await expect(
        insertMatchingEvent(client, { ...evaluated(), pairFitBps: 8_001 }),
      ).rejects.toMatchObject({ constraint: "chk_marketplace_matching_event_evaluation" });
      await expect(
        insertMatchingEvent(client, {
          eventType: "marketplace.match.saved.v1",
          attributionKind: "organic",
          respondentSide: "creator",
        }),
      ).rejects.toMatchObject({ constraint: "chk_marketplace_matching_event_outcome" });
    });

    it("enforces the approved structured outcome vocabularies", async () => {
      await client.query(migration);
      await client.query(attributionMigration);
      await client.query(outcomeMigration);
      await insertCollaboration(client, ids.collaboration, "creator");
      for (const input of [
        { eventType: "marketplace.match.dismissed.v1", dismissalReasonCode: "not_interested" },
        {
          eventType: "marketplace.match.response_recorded.v1",
          collaborationId: ids.collaboration,
          respondentSide: "hotel",
          responseValue: "positive",
        },
        {
          eventType: "marketplace.match.rating_recorded.v1",
          collaborationId: ids.collaboration,
          respondentSide: "hotel",
          subjectSide: "creator",
          ratingScore: 5,
        },
        satisfaction(randomUUID()),
        {
          eventType: "marketplace.match.guardrail_recorded.v1",
          collaborationId: ids.collaboration,
          guardrailState: "opened",
          guardrailCode: "dispute",
        },
      ])
        await insertMatchingEvent(client, { ...input, attributionKind: "organic" });
      for (const invalid of [
        { eventType: "marketplace.match.dismissed.v1", dismissalReasonCode: "not_relevant" },
        {
          eventType: "marketplace.match.response_recorded.v1",
          collaborationId: ids.collaboration,
          respondentSide: "hotel",
          responseValue: "maybe",
        },
        {
          eventType: "marketplace.match.satisfaction_recorded.v1",
          collaborationId: ids.collaboration,
          respondentSide: "creator",
          satisfactionOutcome: "unknown",
        },
        {
          eventType: "marketplace.match.guardrail_recorded.v1",
          collaborationId: ids.collaboration,
          guardrailState: "opened",
          guardrailCode: "late_reply",
        },
      ])
        await expect(
          insertMatchingEvent(client, { ...invalid, attributionKind: "organic" }),
        ).rejects.toMatchObject({ constraint: "chk_marketplace_matching_event_outcome" });
    });

    it("rejects concurrent duplicate satisfaction revisions", async () => {
      await client.query(migration);
      await client.query(attributionMigration);
      await client.query(outcomeMigration);
      await insertCollaboration(client, ids.collaboration, "creator");
      const writer = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await writer.connect();
      try {
        const results = await Promise.allSettled([
          insertMatchingEvent(client, satisfaction(randomUUID())),
          insertMatchingEvent(writer, satisfaction(randomUUID())),
        ]);
        expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
        expect(results.find(({ status }) => status === "rejected")).toMatchObject({
          reason: {
            code: "23505",
            constraint: "uq_marketplace_matching_satisfaction_revision",
          },
        });
      } finally {
        await writer.end();
      }
    });

    it("ties current satisfaction and guardrail facts to exact same-transaction events", async () => {
      await applyCurrentOutcomeMigrations(client);
      await insertCollaboration(client, ids.collaboration, "creator");
      for (const [source, event] of [
        [satisfactionSource(randomUUID(), "satisfied"), { satisfactionOutcome: "neutral" }],
        [guardrailSource(randomUUID(), "opened", "dispute"), { guardrailState: "resolved" }],
      ] as const)
        await expect(recordCurrentOutcome(client, source, event)).rejects.toMatchObject({
          constraint: "chk_marketplace_matching_event_current_source_transition",
        });
      await recordCurrentOutcome(client, satisfactionSource(randomUUID(), "satisfied"));
      await recordCurrentOutcome(client, guardrailSource(randomUUID(), "opened", "dispute"));
    });

    it("enforces source revisions and keeps them independent of retained events", async () => {
      await applyCurrentOutcomeMigrations(client);
      await insertCollaboration(client, ids.collaboration, "creator");
      await expect(
        insertCurrentOutcome(client, satisfactionSource(randomUUID(), "satisfied", 2)),
      ).rejects.toMatchObject({
        constraint: "chk_marketplace_current_matching_outcome_revision_transition",
      });
      await client.query("BEGIN");
      await insertCurrentOutcome(client, guardrailSource(randomUUID(), "opened", "report"));
      await expect(client.query("COMMIT")).rejects.toMatchObject({
        constraint: "chk_marketplace_current_matching_outcome_projection_required",
      });
      await client.query("ROLLBACK");

      const sourceId = randomUUID();
      await recordCurrentOutcome(client, satisfactionSource(sourceId, "satisfied"));
      await client.query("DELETE FROM marketplace.current_matching_outcomes WHERE source_id=$1", [
        sourceId,
      ]);
      const replacementId = randomUUID();
      await recordCurrentOutcome(client, satisfactionSource(replacementId, "satisfied"));
      expect(await currentRevision(client, replacementId)).toBe(1);
      await client.query(
        "ALTER TABLE marketplace.matching_event_projections DISABLE TRIGGER trg_marketplace_matching_event_append_only",
      );
      try {
        await client.query(
          "DELETE FROM marketplace.matching_event_projections WHERE source_id=$1 AND revision=1",
          [replacementId],
        );
      } finally {
        await client.query(
          "ALTER TABLE marketplace.matching_event_projections ENABLE TRIGGER trg_marketplace_matching_event_append_only",
        );
      }
      await recordCurrentOutcome(client, satisfactionSource(replacementId, "neutral", 2));
      expect(await currentRevision(client, replacementId)).toBe(2);
    });

    it("rejects one of two edits from the same current revision", async () => {
      await applyCurrentOutcomeMigrations(client);
      await insertCollaboration(client, ids.collaboration, "creator");
      const sourceId = randomUUID();
      await recordCurrentOutcome(client, satisfactionSource(sourceId, "satisfied", 1, "hotel"));
      const writer = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await writer.connect();
      try {
        const results = await Promise.allSettled([
          recordCurrentOutcome(client, satisfactionSource(sourceId, "neutral", 2, "hotel")),
          recordCurrentOutcome(writer, satisfactionSource(sourceId, "dissatisfied", 2, "hotel")),
        ]);
        expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
        expect(results.find(({ status }) => status === "rejected")).toMatchObject({
          reason: {
            constraint: "chk_marketplace_current_matching_outcome_revision_transition",
          },
        });
        expect(await currentRevision(client, sourceId)).toBe(2);
      } finally {
        await writer.end();
      }
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

type MatchingEventInput = {
  eventType: string;
  sourceId?: string;
  revision?: number;
  occurredAt?: string;
  collaborationId?: string;
  attributionKind?: "organic" | "recommended";
  policyVersion?: string;
  evaluationId?: string;
  evaluationMode?: "shadow" | "active";
  impressionId?: string;
  recommendationSessionId?: string;
  surface?: string;
  presentationMode?: "ranked" | "exploration";
  rank?: number;
  slot?: number;
  eligibilityStatus?: string;
  eligibilityRuleOutcomes?: string[];
  hotelFitBps?: number;
  creatorFitBps?: number;
  pairFitBps?: number;
  hotelCoverageBps?: number;
  creatorCoverageBps?: number;
  confidence?: string;
  reasonCodes?: string[];
  evidenceKnownCount?: number;
  evidenceUnknownCount?: number;
  evidenceStaleCount?: number;
  evidenceUnavailableCount?: number;
  evidenceNotApplicableCount?: number;
  respondentSide?: string;
  subjectSide?: string;
  responseValue?: string;
  ratingScore?: number;
  satisfactionOutcome?: string;
  dismissalReasonCode?: string;
  guardrailState?: string;
  guardrailCode?: string;
};

function impression(character: string, acceptedAt: string): MatchingEventInput {
  const impressionId = character.repeat(64);
  return {
    eventType: "marketplace.match.impression.v1",
    sourceId: impressionId,
    occurredAt: acceptedAt,
    policyVersion: recommended.policyVersion,
    evaluationId: ids.evaluation,
    impressionId,
    recommendationSessionId: `session-${character}`,
    surface: "creator_offer_discovery",
    presentationMode: "ranked",
    rank: 1,
    slot: 1,
  };
}

function evaluated(): MatchingEventInput {
  return {
    eventType: "marketplace.match.evaluated.v1",
    sourceId: ids.evaluation,
    policyVersion: recommended.policyVersion,
    evaluationId: ids.evaluation,
    evaluationMode: "shadow",
    eligibilityStatus: "eligible",
    eligibilityRuleOutcomes: Array(9).fill("pass"),
    hotelFitBps: 8_000,
    creatorFitBps: 9_000,
    pairFitBps: 8_000,
    hotelCoverageBps: 10_000,
    creatorCoverageBps: 10_000,
    confidence: "medium",
    reasonCodes: ["destination_match", "platform_match"],
    evidenceKnownCount: 8,
    evidenceUnknownCount: 1,
    evidenceStaleCount: 0,
    evidenceUnavailableCount: 0,
    evidenceNotApplicableCount: 0,
  };
}

function satisfaction(sourceId: string): MatchingEventInput {
  return {
    eventType: "marketplace.match.satisfaction_recorded.v1",
    sourceId,
    collaborationId: ids.collaboration,
    attributionKind: "organic",
    respondentSide: "creator",
    satisfactionOutcome: "satisfied",
  };
}

async function insertCollaboration(
  client: pg.Client,
  id: string,
  initiatorType: "creator" | "hotel",
  attribution: Omit<MatchingEventInput, "eventType"> = { attributionKind: "organic" },
): Promise<void> {
  await client.query(
    `INSERT INTO marketplace.collaborations
     (id,creator_profile_id,creator_organization_id,offer_id,property_id,hotel_organization_id,initiator_type,
      matching_attribution_kind,matching_policy_version,matching_evaluation_id,
      matching_impression_id,matching_recommendation_session_id,matching_surface,
      matching_presentation_mode)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      id,
      ids.creator,
      ids.creatorOrg,
      ids.offer,
      ids.property,
      ids.hotelOrg,
      initiatorType,
      attribution.attributionKind,
      attribution.policyVersion ?? null,
      attribution.evaluationId ?? null,
      attribution.impressionId ?? null,
      attribution.recommendationSessionId ?? null,
      attribution.surface ?? null,
      attribution.presentationMode ?? null,
    ],
  );
}

async function insertMatchingEvent(client: pg.Client, input: MatchingEventInput): Promise<void> {
  const domainEventId = randomUUID();
  const sourceId = input.sourceId ?? randomUUID();
  const revision = input.revision ?? 1;
  const acceptedAt = input.occurredAt ?? occurredAt;
  await client.query(
    `INSERT INTO platform.domain_events VALUES
     ($1,'marketplace',$2,$3,1,$4,$4,$5,'correlation-1',$6,'marketplace',
      'matching_event',$7,'{}','{}')`,
    [
      domainEventId,
      `${input.eventType}:${sourceId}:${revision}`,
      input.eventType,
      acceptedAt,
      ids.property,
      ids.actor,
      sourceId,
    ],
  );
  const detailColumns = [
    "eligibility_status",
    "eligibility_rule_outcomes",
    "hotel_fit_bps",
    "creator_fit_bps",
    "pair_fit_bps",
    "hotel_coverage_bps",
    "creator_coverage_bps",
    "confidence",
    "reason_codes",
    "evidence_known_count",
    "evidence_unknown_count",
    "evidence_stale_count",
    "evidence_unavailable_count",
    "evidence_not_applicable_count",
    "respondent_side",
    "subject_side",
    "response_value",
    "rating_score",
    "satisfaction_outcome",
    "dismissal_reason_code",
    "guardrail_state",
    "guardrail_code",
  ];
  const detailValues = [
    input.eligibilityStatus,
    input.eligibilityRuleOutcomes,
    input.hotelFitBps,
    input.creatorFitBps,
    input.pairFitBps,
    input.hotelCoverageBps,
    input.creatorCoverageBps,
    input.confidence,
    input.reasonCodes,
    input.evidenceKnownCount,
    input.evidenceUnknownCount,
    input.evidenceStaleCount,
    input.evidenceUnavailableCount,
    input.evidenceNotApplicableCount,
    input.respondentSide,
    input.subjectSide,
    input.responseValue,
    input.ratingScore,
    input.satisfactionOutcome,
    input.dismissalReasonCode,
    input.guardrailState,
    input.guardrailCode,
  ].map((value) => value ?? null);
  await client.query(
    `INSERT INTO marketplace.matching_event_projections
     (domain_event_id,event_type,source_id,revision,actor_user_id,creator_profile_id,
      creator_organization_id,hotel_organization_id,property_id,offer_id,collaboration_id,
      contract_version,correlation_id,occurred_at,recorded_at,attribution_kind,policy_version,
      evaluation_id,evaluation_mode,impression_id,recommendation_session_id,surface,
      presentation_mode,impression_rank,impression_slot,${detailColumns.join(",")})
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'marketplace-matching-contract.v2',
       'correlation-1',$12,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
       ${detailValues.map((_, index) => `$${index + 23}`).join(",")})`,
    [
      domainEventId,
      input.eventType,
      sourceId,
      revision,
      ids.actor,
      ids.creator,
      ids.creatorOrg,
      ids.hotelOrg,
      ids.property,
      ids.offer,
      input.collaborationId ?? null,
      acceptedAt,
      input.attributionKind ?? null,
      input.policyVersion ?? null,
      input.evaluationId ?? null,
      input.evaluationMode ?? null,
      input.impressionId ?? null,
      input.recommendationSessionId ?? null,
      input.surface ?? null,
      input.presentationMode ?? null,
      input.rank ?? null,
      input.slot ?? null,
      ...detailValues,
    ],
  );
}

type CurrentOutcomeInput = {
  sourceId: string;
  kind: "satisfaction" | "guardrail";
  revision?: number;
  respondentSide?: "creator" | "hotel";
  satisfactionOutcome?: "satisfied" | "neutral" | "dissatisfied";
  guardrailState?: "opened" | "resolved";
  guardrailCode?: "cancellation" | "no_show" | "dispute" | "block" | "report" | "policy_violation";
};

function satisfactionSource(
  sourceId: string,
  satisfactionOutcome: CurrentOutcomeInput["satisfactionOutcome"],
  revision = 1,
  respondentSide: "creator" | "hotel" = "creator",
): CurrentOutcomeInput {
  return { sourceId, kind: "satisfaction", revision, respondentSide, satisfactionOutcome };
}

function guardrailSource(
  sourceId: string,
  guardrailState: CurrentOutcomeInput["guardrailState"],
  guardrailCode: CurrentOutcomeInput["guardrailCode"],
  revision = 1,
): CurrentOutcomeInput {
  return { sourceId, kind: "guardrail", revision, guardrailState, guardrailCode };
}

function currentOutcomeEvent(input: CurrentOutcomeInput, occurredAt: string): MatchingEventInput {
  return {
    eventType:
      input.kind === "satisfaction"
        ? "marketplace.match.satisfaction_recorded.v1"
        : "marketplace.match.guardrail_recorded.v1",
    ...input,
    occurredAt,
    collaborationId: ids.collaboration,
    attributionKind: "organic",
  };
}

async function applyCurrentOutcomeMigrations(client: pg.Client): Promise<void> {
  await client.query(migration);
  await client.query(attributionMigration);
  await client.query(outcomeMigration);
  await client.query(currentOutcomeMigration);
}

async function insertCurrentOutcome(
  client: pg.Client,
  input: CurrentOutcomeInput,
): Promise<string> {
  const result = await client.query<{ occurredAt: string }>(
    `INSERT INTO marketplace.current_matching_outcomes
     (source_id,source_kind,collaboration_id,creator_profile_id,creator_organization_id,
      hotel_organization_id,property_id,offer_id,subject_user_id,actor_user_id,respondent_side,
      satisfaction_outcome,guardrail_state,guardrail_code,revision)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12,$13,$14)
     RETURNING to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt"`,
    [
      input.sourceId,
      input.kind,
      ids.collaboration,
      ids.creator,
      ids.creatorOrg,
      ids.hotelOrg,
      ids.property,
      ids.offer,
      ids.actor,
      input.respondentSide ?? null,
      input.satisfactionOutcome ?? null,
      input.guardrailState ?? null,
      input.guardrailCode ?? null,
      input.revision ?? 1,
    ],
  );
  return result.rows[0]!.occurredAt;
}

type EventOverrides = Partial<MatchingEventInput>;

async function recordCurrentOutcome(
  client: pg.Client,
  input: CurrentOutcomeInput,
  event: EventOverrides = {},
): Promise<void> {
  await client.query("BEGIN");
  try {
    const revision = input.revision ?? 1;
    const occurredAt =
      revision === 1
        ? await insertCurrentOutcome(client, input)
        : (
            await client.query<{ occurredAt: string }>(
              `UPDATE marketplace.current_matching_outcomes SET revision=$2,
                 satisfaction_outcome=$3,guardrail_state=$4
               WHERE source_id=$1
               RETURNING to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt"`,
              [
                input.sourceId,
                revision,
                input.satisfactionOutcome ?? null,
                input.guardrailState ?? null,
              ],
            )
          ).rows[0]!.occurredAt;
    const currentEvent = currentOutcomeEvent({ ...input, revision }, occurredAt);
    await insertMatchingEvent(client, Object.assign(currentEvent, event));
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function currentRevision(client: pg.Client, sourceId: string): Promise<number> {
  const result = await client.query<{ revision: number }>(
    "SELECT revision FROM marketplace.current_matching_outcomes WHERE source_id=$1",
    [sourceId],
  );
  return result.rows[0]!.revision;
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
  offer_id UUID, property_id UUID, hotel_organization_id UUID, initiator_type TEXT);
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
`;
