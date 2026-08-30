import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { staffInvitationIdentityNotFoundReasonCode } from "../routes/workosWebhooks.js";
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
        workosRoleSlugs: string[];
      }>(
        `SELECT role_key AS "roleKey", property_access_mode AS "propertyAccessMode",
                workos_role_slugs AS "workosRoleSlugs"
         FROM identity.organization_memberships
         WHERE organization_id = $1
         ORDER BY role_key`,
        [organizationId],
      );
      expect(memberships.rows).toEqual([
        {
          roleKey: "hotel_custom",
          propertyAccessMode: "assigned",
          workosRoleSlugs: ["hotel_member"],
        },
        { roleKey: "hotel_owner", propertyAccessMode: "all", workosRoleSlugs: ["admin"] },
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
            `SELECT user_id AS "userId", role_key AS "roleKey",
                    property_access_mode AS "propertyAccessMode",
                    workos_role_slugs AS "workosRoleSlugs"
             FROM identity.organization_memberships
             WHERE organization_id = $1
             ORDER BY user_id`,
            [organizationId],
          )
        ).rows,
      ).toEqual(
        [
          {
            userId: ownerUserId,
            roleKey: "hotel_owner",
            propertyAccessMode: "all",
            workosRoleSlugs: ["hotel_member"],
          },
          {
            userId: staffUserId,
            roleKey: "hotel_custom",
            propertyAccessMode: "assigned",
            workosRoleSlugs: ["admin"],
          },
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
           SET role_key = 'front_desk', property_access_mode = 'assigned',
               access_origin = 'external_owner'
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

  it("loads and resolves deferred invitation acceptance for the exact WorkOS user", async () => {
    const eventId = `evt_vay_1085_deferred_${randomUUID()}`;
    const providerUserId = `user_vay_1085_deferred_${randomUUID()}`;
    const acceptance = {
      providerEventId: eventId,
      providerInvitationId: `invitation_${randomUUID()}`,
      providerUserId,
      providerOrganizationId: `org_${randomUUID()}`,
      invitationEmail: `staff-${randomUUID()}@example.test`,
    };
    const receipt = await store.insertReceipt({
      providerEventId: eventId,
      eventType: "invitation.accepted",
      payloadHash: `sha256:${randomUUID()}`,
      signatureVerified: true,
      rawHeaders: {},
      rawPayload: { id: eventId, event: "invitation.accepted" },
      webhookKeyHash: `sha256:${randomUUID()}`,
    });
    await store.deadLetterReceipt({
      receiptId: receipt.receiptId,
      reasonCode: staffInvitationIdentityNotFoundReasonCode,
      failureSummary: "Staff invitation acceptance deferred: identity_not_found",
      failurePayload: {
        staffInvitationAcceptance: acceptance,
      },
    });
    for (const [kind, signatureVerified, override] of [
      ["unverified", false, {}],
      ["event-mismatch", true, { providerEventId: `other_${eventId}` }],
      ["malformed", true, { providerInvitationId: 42 }],
    ] as const) {
      const invalidEventId = `${eventId}_${kind}`;
      const invalidReceipt = await store.insertReceipt({
        providerEventId: invalidEventId,
        eventType: "invitation.accepted",
        payloadHash: `sha256:${randomUUID()}`,
        signatureVerified,
        rawHeaders: {},
        rawPayload: { id: invalidEventId, event: "invitation.accepted" },
        webhookKeyHash: `sha256:${randomUUID()}`,
      });
      await store.deadLetterReceipt({
        receiptId: invalidReceipt.receiptId,
        reasonCode: staffInvitationIdentityNotFoundReasonCode,
        failureSummary: "Staff invitation acceptance deferred: identity_not_found",
        failurePayload: {
          staffInvitationAcceptance: {
            ...acceptance,
            providerEventId: invalidEventId,
            ...override,
          },
        },
      });
    }

    await expect(
      store.listDeferredStaffInvitationAcceptances(`other_${providerUserId}`),
    ).resolves.toEqual([]);
    await expect(store.listDeferredStaffInvitationAcceptances(providerUserId)).resolves.toEqual([
      { receiptId: receipt.receiptId, event: acceptance },
    ]);

    await Promise.all([
      store.resolveDeferredStaffInvitationAcceptance(receipt.receiptId),
      store.resolveDeferredStaffInvitationAcceptance(receipt.receiptId),
    ]);

    await expect(store.listDeferredStaffInvitationAcceptances(providerUserId)).resolves.toEqual([]);
    expect(
      (
        await admin.query<{ recoveryStatus: string; normalizedCount: string }>(
          `SELECT dead.recovery_status AS "recoveryStatus",
                  count(reconciliation.id)::text AS "normalizedCount"
           FROM platform.dead_letter_events dead
           LEFT JOIN identity.auth_reconciliation_events reconciliation
             ON reconciliation.provider = 'workos'
            AND reconciliation.provider_event_id = dead.webhook_event_id::text
            AND reconciliation.event_type = 'workos.webhook.normalized'
           WHERE dead.webhook_event_id = $1::uuid
           GROUP BY dead.id`,
          [receipt.receiptId],
        )
      ).rows[0],
    ).toEqual({ recoveryStatus: "resolved", normalizedCount: "1" });
  });

  it("keeps invitation activation monotonic across out-of-order WorkOS events", async () => {
    const organizationId = randomUUID();
    const propertyId = randomUUID();
    const ownerUserId = randomUUID();
    const invitedUserId = randomUUID();
    const ownerWorkosUserId = `user_vay_1085_owner_${randomUUID()}`;
    const invitedWorkosUserId = `user_vay_1085_invited_${randomUUID()}`;
    const workosOrgId = `org_vay_1085_${randomUUID()}`;
    const invitedEmail = `invited-${invitedUserId}@example.test`;

    try {
      await admin.query(
        `INSERT INTO identity.users (id, email, name, status)
         VALUES ($1, $2, 'Owner', 'active'), ($3, $4, 'Invited staff', 'active')`,
        [ownerUserId, `owner-${ownerUserId}@example.test`, invitedUserId, invitedEmail],
      );
      await admin.query(
        `INSERT INTO identity.external_identities
           (user_id, provider, provider_user_id, provider_email)
         VALUES ($1, 'workos', $2, $3), ($4, 'workos', $5, $6)`,
        [
          ownerUserId,
          ownerWorkosUserId,
          `owner-${ownerUserId}@example.test`,
          invitedUserId,
          invitedWorkosUserId,
          invitedEmail,
        ],
      );
      await admin.query(
        `INSERT INTO identity.organizations (id, kind, name, slug, status, workos_org_id)
         VALUES ($1, 'hotel_group', 'VAY-1085 invitation ordering', $2, 'active', $3)`,
        [organizationId, `vay-1085-invite-${organizationId}`, workosOrgId],
      );
      await admin.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1, $2, 'VAY-1085 property')`,
        [propertyId, `property-${propertyId}`],
      );
      await admin.query(
        `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship, status)
         VALUES ($1, 'hotel_catalog', 'property', $2, 'owner', 'active')`,
        [organizationId, propertyId],
      );
      await store.upsertWorkosMembership({
        workosMembershipId: `om_owner_${randomUUID()}`,
        workosUserId: ownerWorkosUserId,
        workosOrgId,
        roleKey: "admin",
        workosRoleSlugs: ["admin"],
        status: "active",
      });
      const ownerMembershipId = (
        await admin.query<{ id: string }>(
          `SELECT id FROM identity.organization_memberships
           WHERE organization_id = $1 AND user_id = $2`,
          [organizationId, ownerUserId],
        )
      ).rows[0]!.id;
      const invitationId = (
        await admin.query<{ id: string }>(
          `INSERT INTO identity.staff_invitations
             (organization_id, email, inviter_membership_id, inviter_user_id,
              inviter_name_snapshot, role_key, permission_overrides, property_access_mode,
              configuration_revision, command_id, idempotency_key_hash,
              request_fingerprint_hash, provider_invitation_id, expires_at, request_id,
              request_source, reason, requested_at, delivery_state, delivery_attempted_at)
           VALUES ($1, $2, $3, $4, 'Owner', 'housekeeping', $5::jsonb, 'assigned',
                   1, $6, $7, $8, $9, now() + interval '1 day', $10,
                   'web', 'test event ordering', now(), 'delivered', now())
           RETURNING id`,
          [
            organizationId,
            invitedEmail,
            ownerMembershipId,
            ownerUserId,
            JSON.stringify({ grant: [], deny: ["booking.reservation.read"] }),
            `command-${randomUUID()}`,
            Buffer.alloc(32, 1),
            Buffer.alloc(32, 2),
            `invitation-${randomUUID()}`,
            `request-${randomUUID()}`,
          ],
        )
      ).rows[0]!.id;
      await admin.query(
        `INSERT INTO identity.staff_invitation_property_assignments (invitation_id, property_id)
         VALUES ($1, $2)`,
        [invitationId, propertyId],
      );

      await store.upsertWorkosMembership({
        workosMembershipId: `om_invited_${randomUUID()}`,
        workosUserId: invitedWorkosUserId,
        workosOrgId,
        roleKey: "hotel_member",
        workosRoleSlugs: ["hotel_member"],
        status: "active",
      });
      await admin.query("UPDATE identity.staff_invitations SET status = 'revoked' WHERE id = $1", [
        invitationId,
      ]);
      await store.upsertWorkosMembership({
        workosMembershipId: `om_invited_update_${randomUUID()}`,
        workosUserId: invitedWorkosUserId,
        workosOrgId,
        roleKey: "hotel_member",
        workosRoleSlugs: ["hotel_member"],
        status: "active",
      });

      expect(
        (
          await admin.query(
            `SELECT membership.status, membership.role_key AS "roleKey",
                    membership.permission_overrides AS "permissionOverrides",
                    membership.property_access_mode AS "propertyAccessMode",
                    membership.access_origin AS "accessOrigin",
                    count(assignment.property_id)::int AS "assignmentCount"
             FROM identity.organization_memberships membership
             LEFT JOIN identity.membership_property_assignments assignment
               ON assignment.membership_id = membership.id
             WHERE membership.organization_id = $1 AND membership.user_id = $2
             GROUP BY membership.id`,
            [organizationId, invitedUserId],
          )
        ).rows[0],
      ).toEqual({
        status: "pending",
        roleKey: "housekeeping",
        permissionOverrides: { grant: [], deny: ["booking.reservation.read"] },
        propertyAccessMode: "assigned",
        accessOrigin: "agency",
        assignmentCount: 0,
      });

      const invitedMembershipId = (
        await admin.query<{ id: string }>(
          "UPDATE identity.organization_memberships SET status = 'active', workos_membership_id = NULL, invited_at = NULL WHERE organization_id = $1 AND user_id = $2 RETURNING id",
          [organizationId, invitedUserId],
        )
      ).rows[0]!.id;
      await admin.query(
        `UPDATE identity.staff_invitations
         SET status = 'accepted', accepted_user_id = $2, accepted_membership_id = $3
         WHERE id = $1`,
        [invitationId, invitedUserId, invitedMembershipId],
      );
      const acceptedProviderMembership = {
        workosMembershipId: "om_invited_delayed_" + randomUUID(),
        workosUserId: invitedWorkosUserId,
        workosOrgId,
        roleKey: "hotel_member" as const,
        workosRoleSlugs: ["hotel_member"],
      };
      await store.upsertWorkosMembership({ ...acceptedProviderMembership, status: "pending" });
      expect(
        (
          await admin.query<{ status: string; workosMembershipId: string }>(
            `SELECT status, workos_membership_id AS "workosMembershipId"
             FROM identity.organization_memberships
             WHERE organization_id = $1 AND user_id = $2`,
            [organizationId, invitedUserId],
          )
        ).rows[0],
      ).toEqual({
        status: "active",
        workosMembershipId: acceptedProviderMembership.workosMembershipId,
      });

      await store.upsertWorkosMembership({ ...acceptedProviderMembership, status: "active" });
      await store.upsertWorkosMembership({ ...acceptedProviderMembership, status: "pending" });
      expect(
        (
          await admin.query<{ status: string }>(
            "SELECT status FROM identity.organization_memberships WHERE organization_id = $1 AND user_id = $2",
            [organizationId, invitedUserId],
          )
        ).rows[0],
      ).toEqual({ status: "active" });

      const replacementWorkosMembershipId = "om_invited_replacement_" + randomUUID();
      await store.upsertWorkosMembership({
        ...acceptedProviderMembership,
        workosMembershipId: replacementWorkosMembershipId,
        status: "pending",
      });
      await store.upsertWorkosMembership({ ...acceptedProviderMembership, status: "pending" });
      await store.upsertWorkosMembership({ ...acceptedProviderMembership, status: "active" });
      await store.deactivateWorkosMembership(acceptedProviderMembership.workosMembershipId);
      expect(
        (
          await admin.query<{ status: string; workosMembershipId: string }>(
            `SELECT status, workos_membership_id AS "workosMembershipId"
             FROM identity.organization_memberships
             WHERE organization_id = $1 AND user_id = $2`,
            [organizationId, invitedUserId],
          )
        ).rows[0],
      ).toEqual({ status: "pending", workosMembershipId: replacementWorkosMembershipId });

      for (const status of ["suspended", "inactive"] as const) {
        await admin.query(
          "UPDATE identity.organization_memberships SET status = $3 WHERE organization_id = $1 AND user_id = $2",
          [organizationId, invitedUserId, status],
        );
        await store.upsertWorkosMembership({ ...acceptedProviderMembership, status: "active" });
        await store.deactivateWorkosMembership(acceptedProviderMembership.workosMembershipId);
        expect(
          (
            await admin.query<{ status: string; workosMembershipId: string }>(
              `SELECT status, workos_membership_id AS "workosMembershipId"
               FROM identity.organization_memberships
               WHERE organization_id = $1 AND user_id = $2`,
              [organizationId, invitedUserId],
            )
          ).rows[0],
        ).toEqual({ status, workosMembershipId: replacementWorkosMembershipId });
      }
    } finally {
      await admin.query("DELETE FROM identity.staff_invitations WHERE organization_id = $1", [
        organizationId,
      ]);
      await admin.query(
        "DELETE FROM identity.organization_memberships WHERE organization_id = $1",
        [organizationId],
      );
      await admin.query(
        "DELETE FROM identity.organization_resource_links WHERE organization_id = $1",
        [organizationId],
      );
      await admin.query("DELETE FROM hotel_catalog.properties WHERE id = $1", [propertyId]);
      await admin.query("DELETE FROM identity.organizations WHERE id = $1", [organizationId]);
      await admin.query(
        "DELETE FROM identity.external_identities WHERE user_id = ANY($1::uuid[])",
        [[ownerUserId, invitedUserId]],
      );
      await admin.query("DELETE FROM identity.users WHERE id = ANY($1::uuid[])", [
        [ownerUserId, invitedUserId],
      ]);
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
