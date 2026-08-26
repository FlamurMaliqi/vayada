import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { grantIdentityAccessWithClient } from "./identityLifecycle.js";
import { createPgWorkosWebhookStore } from "./workosWebhooks.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const providerEventId = `evt_vay_1239_${randomUUID()}`;

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL WorkOS webhook store", () => {
  const admin = new pg.Client({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });
  const store = createPgWorkosWebhookStore({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    max: 2,
  });

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await admin.connect();
  });

  afterAll(async () => {
    await store.close();
    await admin.end();
  });

  it("persists a failed reconciliation once and deduplicates its retry", async () => {
    const event = {
      id: providerEventId,
      event: "organization_membership.created",
      createdAt: "2026-08-11T16:00:00.000Z",
      data: {
        id: "om_vay_1239_missing",
        user_id: "user_vay_1239_missing",
        organization_id: "org_vay_1239_missing",
        role: { slug: "hotel_member" },
        status: "active",
      },
    };
    const app = buildApp({
      workosWebhooks: {
        secret: "whsec_test",
        verifier: {
          async verify() {
            return event;
          },
        },
        store,
        processInline: true,
      },
    });

    try {
      const first = await postWebhook(app);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ status: "dead_lettered" });
      const receiptId = first.json<{ receiptId: string }>().receiptId;

      const persistenceRetry = {
        receiptId,
        reasonCode: "identity_reconciliation_failed",
        failureSummary: "WorkOS membership references an unknown user or organization",
        failurePayload: {
          eventId: providerEventId,
          eventType: "organization_membership.created",
        },
      };
      await Promise.all([
        store.deadLetterReceipt(persistenceRetry),
        store.deadLetterReceipt(persistenceRetry),
      ]);

      const second = await postWebhook(app);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual({ status: "duplicate", receiptId });

      const deadLetters = await admin.query<{
        failurePayload: unknown;
        reasonCode: string;
        resourceId: string;
        webhookEventId: string;
      }>(
        `SELECT dead.webhook_event_id::text AS "webhookEventId",
                dead.resource_id AS "resourceId",
                dead.reason_code AS "reasonCode",
                dead.failure_payload AS "failurePayload"
         FROM platform.dead_letter_events AS dead
         JOIN platform.external_webhook_events AS receipt
           ON receipt.id = dead.webhook_event_id
         WHERE receipt.provider = 'workos'
           AND receipt.provider_event_id = $1`,
        [providerEventId],
      );
      expect(deadLetters.rows).toEqual([
        {
          webhookEventId: receiptId,
          resourceId: receiptId,
          reasonCode: "identity_reconciliation_failed",
          failurePayload: {
            eventId: providerEventId,
            eventType: "organization_membership.created",
          },
        },
      ]);

      const reconciliations = await admin.query<{
        error: string;
        payload: unknown;
        providerEventId: string;
      }>(
        `SELECT provider_event_id AS "providerEventId", payload, error
         FROM identity.auth_reconciliation_events
         WHERE provider = 'workos'
           AND event_type = 'workos.webhook.dead_lettered'
           AND provider_event_id = $1`,
        [receiptId],
      );
      expect(reconciliations.rows).toEqual([
        {
          providerEventId: receiptId,
          payload: {
            eventId: providerEventId,
            eventType: "organization_membership.created",
          },
          error:
            "identity_reconciliation_failed: WorkOS membership references an unknown user or organization",
        },
      ]);
    } finally {
      await app.close();
    }
  });

  it("persists property scopes and preserves delegated provenance", async () => {
    const organizationId = randomUUID();
    const ownerUserId = randomUUID();
    const staffUserId = randomUUID();
    const ownerWorkosUserId = `user_vay_1085_owner_${randomUUID()}`;
    const staffWorkosUserId = `user_vay_1085_staff_${randomUUID()}`;
    const workosOrgId = `org_vay_1085_${randomUUID()}`;
    const ownerWorkosMembershipId = `om_owner_${randomUUID()}`;
    const staffWorkosMembershipId = `om_staff_${randomUUID()}`;

    try {
      await admin.query(
        `INSERT INTO identity.users (id, email, name, status)
         VALUES ($1, $2, 'Owner', 'active'), ($3, $4, 'Staff', 'active')`,
        [
          ownerUserId,
          `owner-${ownerUserId}@example.test`,
          staffUserId,
          `staff-${staffUserId}@example.test`,
        ],
      );
      await admin.query(
        `INSERT INTO identity.external_identities (user_id, provider, provider_user_id)
         VALUES ($1, 'workos', $2), ($3, 'workos', $4)`,
        [ownerUserId, ownerWorkosUserId, staffUserId, staffWorkosUserId],
      );
      await admin.query(
        `INSERT INTO identity.organizations (id, kind, name, slug, status, workos_org_id)
         VALUES ($1, 'hotel_group', 'VAY-1085 scope test', $2, 'active', $3)`,
        [organizationId, `vay-1085-${organizationId}`, workosOrgId],
      );

      await store.upsertWorkosMembership({
        workosMembershipId: ownerWorkosMembershipId,
        workosUserId: ownerWorkosUserId,
        workosOrgId,
        roleKey: "admin",
        workosRoleSlugs: ["admin"],
        status: "active",
      });
      await store.upsertWorkosMembership({
        workosMembershipId: staffWorkosMembershipId,
        workosUserId: staffWorkosUserId,
        workosOrgId,
        roleKey: "hotel_member",
        workosRoleSlugs: ["hotel_member"],
        status: "active",
      });

      const memberships = await admin.query<{
        propertyAccessMode: string;
        roleKey: string;
      }>(
        `SELECT role_key AS "roleKey", property_access_mode AS "propertyAccessMode"
         FROM identity.organization_memberships
         WHERE organization_id = $1
         ORDER BY role_key`,
        [organizationId],
      );
      expect(memberships.rows).toEqual([
        { roleKey: "hotel_member", propertyAccessMode: "assigned" },
        { roleKey: "hotel_owner", propertyAccessMode: "all" },
      ]);

      await store.upsertWorkosMembership({
        workosMembershipId: ownerWorkosMembershipId,
        workosUserId: ownerWorkosUserId,
        workosOrgId,
        roleKey: "hotel_member",
        workosRoleSlugs: ["hotel_member"],
        status: "active",
      });
      await store.upsertWorkosMembership({
        workosMembershipId: staffWorkosMembershipId,
        workosUserId: staffWorkosUserId,
        workosOrgId,
        roleKey: "admin",
        workosRoleSlugs: ["admin"],
        status: "active",
      });

      expect(
        (
          await admin.query(
            `SELECT user_id AS "userId", role_key AS "roleKey", property_access_mode AS "propertyAccessMode"
             FROM identity.organization_memberships
             WHERE organization_id = $1
             ORDER BY user_id`,
            [organizationId],
          )
        ).rows,
      ).toEqual(
        [
          { userId: ownerUserId, roleKey: "hotel_member", propertyAccessMode: "assigned" },
          { userId: staffUserId, roleKey: "hotel_owner", propertyAccessMode: "all" },
        ].sort((left, right) => left.userId.localeCompare(right.userId)),
      );
      const membershipIds = await admin.query<{ id: string; userId: string }>(
        `SELECT id, user_id AS "userId"
         FROM identity.organization_memberships
         WHERE organization_id = $1`,
        [organizationId],
      );
      const subjectMembershipId = membershipIds.rows.find(
        (membership) => membership.userId === ownerUserId,
      )!.id;
      const delegatorMembershipId = membershipIds.rows.find(
        (membership) => membership.userId === staffUserId,
      )!.id;
      try {
        await admin.query("BEGIN");
        await admin.query(
          `UPDATE identity.organization_memberships
           SET role_key = 'external_owner', property_access_mode = 'assigned'
           WHERE id = $1`,
          [delegatorMembershipId],
        );
        await admin.query(
          `UPDATE identity.organization_memberships
           SET role_key = 'front_desk', access_origin = 'external_owner'
           WHERE id = $1`,
          [subjectMembershipId],
        );
        await admin.query(
          `INSERT INTO identity.membership_delegations
             (organization_id, subject_membership_id, delegator_membership_id, created_by_membership_id)
           VALUES ($1, $2, $3, $3)`,
          [organizationId, subjectMembershipId, delegatorMembershipId],
        );
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }

      await grantIdentityAccessWithClient(admin as unknown as pg.PoolClient, {
        userId: ownerUserId,
        organization: {
          organizationId,
          kind: "hotel_group",
          name: "VAY-1085 scope test",
          slug: `vay-1085-${organizationId}`,
          workosOrgId,
        },
        membership: { roleKey: "hotel_owner", propertyAccessMode: "all" },
      });
      await store.upsertWorkosMembership({
        workosMembershipId: ownerWorkosMembershipId,
        workosUserId: ownerWorkosUserId,
        workosOrgId,
        roleKey: "hotel_member",
        workosRoleSlugs: ["hotel_member"],
        status: "active",
      });
      expect(
        (
          await admin.query<{
            accessOrigin: string;
            propertyAccessMode: string;
            roleKey: string;
          }>(
            `SELECT access_origin AS "accessOrigin",
                    property_access_mode AS "propertyAccessMode",
                    role_key AS "roleKey"
             FROM identity.organization_memberships
             WHERE id = $1`,
            [subjectMembershipId],
          )
        ).rows,
      ).toEqual([
        { accessOrigin: "external_owner", propertyAccessMode: "assigned", roleKey: "front_desk" },
      ]);
    } finally {
      let cleanupError: unknown;
      try {
        await admin.query("BEGIN");
        await admin.query(
          `UPDATE identity.organization_memberships
           SET access_origin = 'agency'
           WHERE id IN (
             SELECT subject_membership_id
             FROM identity.membership_delegations
             WHERE organization_id = $1
           )`,
          [organizationId],
        );
        await admin.query(
          "DELETE FROM identity.membership_delegations WHERE organization_id = $1",
          [organizationId],
        );
        await admin.query(
          "DELETE FROM identity.organization_memberships WHERE organization_id = $1",
          [organizationId],
        );
        await admin.query("DELETE FROM identity.organizations WHERE id = $1", [organizationId]);
        await admin.query(
          "DELETE FROM identity.external_identities WHERE user_id = ANY($1::uuid[])",
          [[ownerUserId, staffUserId]],
        );
        await admin.query("DELETE FROM identity.users WHERE id = ANY($1::uuid[])", [
          [ownerUserId, staffUserId],
        ]);
        await admin.query("COMMIT");
      } catch (error) {
        cleanupError = error;
        await admin.query("ROLLBACK").catch((rollbackError: unknown) => {
          cleanupError = new AggregateError([error, rollbackError], "cleanup and rollback failed");
        });
      }
      expect.soft(cleanupError, "delegation test cleanup").toBeUndefined();
    }
  });

  async function postWebhook(app: ReturnType<typeof buildApp>) {
    return app.inject({
      method: "POST",
      url: "/auth/workos/webhook",
      headers: {
        "content-type": "application/json",
        "workos-signature": "valid-signature",
      },
      payload: JSON.stringify({ id: providerEventId }),
    });
  }
});

function assertSafeTestDatabase(connectionString: string): void {
  const url = new URL(connectionString);
  if (
    !["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname) ||
    !url.pathname.toLowerCase().includes("test")
  ) {
    throw new Error("Refusing to run WorkOS webhook integration tests on a non-test DB");
  }
}
