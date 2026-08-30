import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createWorkosBackfillCohortForOrganizationKind,
  createWorkosBackfillCohortForEmail,
  createPgWorkosBackfillRepository,
  mergeLegacyAuthBackfillFields,
  runWorkosBackfill,
  type WorkosBackfillClient,
  type WorkosBackfillRepository,
  type WorkosBackfillSource,
} from "./workosBackfill.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const TEST_BCRYPT_HASH = "$2b$12$abcdefghijklmnopqrstuuJ/lL7AGas7gSUzwl3hBRMaGQJ2dAU1y";
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe("runWorkosBackfill", () => {
  it("does not allow mutable and immutable credential sources together", () => {
    expect(() =>
      createPgWorkosBackfillRepository({
        connectionString: "postgresql://target",
        legacyAuthConnectionString: "postgresql://legacy",
        sourceRunId: "vay1351-0123456789abcdef01234567",
      }),
    ).toThrow("Use either a legacy auth connection or an immutable source run, not both.");
  });

  it("builds a one-user cohort from email and includes that user's memberships", () => {
    const source = {
      users: [
        user({ email: "Owner@Example.com" }),
        user({ id: "user_outside", email: "outside@example.com" }),
      ],
      organizations: [organization()],
      memberships: [
        membership(),
        membership({
          id: "membership_outside",
          userId: "user_outside",
          organizationId: "org_internal",
        }),
      ],
    };

    expect(createWorkosBackfillCohortForEmail(source, "owner@example.com")).toEqual({
      key: "email:Owner@Example.com",
      userIds: ["user_internal"],
      organizationIds: ["org_internal"],
      membershipIds: ["membership_internal"],
    });
  });

  it("ignores deleted duplicate users when building an email cohort", () => {
    const source = {
      users: [
        user({ id: "deleted_1", status: "deleted" }),
        user({ id: "active_user" }),
        user({ id: "deleted_2", status: "deleted" }),
      ],
      organizations: [organization()],
      memberships: [membership({ userId: "active_user" })],
    };

    expect(createWorkosBackfillCohortForEmail(source, "owner@example.com")).toEqual({
      key: "email:owner@example.com",
      userIds: ["active_user"],
      organizationIds: ["org_internal"],
      membershipIds: ["membership_internal"],
    });
  });

  it("limits an email cohort to one exact organization", () => {
    const source = {
      users: [user()],
      organizations: [organization(), organization({ id: "other_org" })],
      memberships: [
        membership(),
        membership({ id: "other_membership", organizationId: "other_org" }),
      ],
    };

    expect(createWorkosBackfillCohortForEmail(source, "owner@example.com", "org_internal")).toEqual(
      {
        key: "email:owner@example.com:organization:org_internal",
        userIds: ["user_internal"],
        organizationIds: ["org_internal"],
        membershipIds: ["membership_internal"],
      },
    );
  });

  it("rejects ambiguous non-deleted duplicate users for an email cohort", () => {
    const source = {
      users: [user(), user({ id: "other_active" })],
      organizations: [],
      memberships: [],
    };

    expect(() => createWorkosBackfillCohortForEmail(source, "owner@example.com")).toThrow(
      "Multiple non-deleted target identity users found for email owner@example.com.",
    );
  });

  it("builds a cohort from active memberships in an organization kind", () => {
    const source = {
      users: [
        user({ id: "platform_user", status: "active" }),
        user({ id: "pending_user", status: "pending" }),
      ],
      organizations: [
        organization({ id: "platform_org", kind: "platform" }),
        organization({ id: "hotel_org", kind: "hotel_group" }),
      ],
      memberships: [
        membership({
          id: "platform_membership",
          userId: "platform_user",
          organizationId: "platform_org",
        }),
        membership({
          id: "pending_membership",
          userId: "pending_user",
          organizationId: "platform_org",
        }),
        membership({
          id: "hotel_membership",
          userId: "platform_user",
          organizationId: "hotel_org",
        }),
      ],
    };

    expect(createWorkosBackfillCohortForOrganizationKind(source, " Platform ")).toEqual({
      key: "organization-kind:platform",
      userIds: ["platform_user"],
      organizationIds: ["platform_org"],
      membershipIds: ["platform_membership"],
    });
  });

  it("carries legacy auth email verification and bcrypt hashes into backfill users", () => {
    expect(
      mergeLegacyAuthBackfillFields(
        [user({ id: "platform_user", emailVerified: false })],
        [
          {
            id: "platform_user",
            emailVerified: true,
            passwordHash: TEST_BCRYPT_HASH,
          },
        ],
      )[0],
    ).toMatchObject({
      emailVerified: true,
      passwordHash: TEST_BCRYPT_HASH,
      passwordHashType: "bcrypt",
    });
  });

  it("summarizes dry-run work without calling WorkOS or writing local links", async () => {
    const repository = createMemoryRepository({
      users: [user()],
      organizations: [organization()],
      memberships: [membership()],
    });

    const summary = await runWorkosBackfill({
      mode: "dry-run",
      cohort: defaultCohort(),
      repository,
    });

    expect(summary.users).toMatchObject({ planned: 1, created: 0, linkedExisting: 0, skipped: 0 });
    expect(summary.organizations).toMatchObject({
      planned: 1,
      created: 0,
      linkedExisting: 0,
      skipped: 0,
    });
    expect(summary.memberships).toMatchObject({
      planned: 1,
      created: 0,
      linkedExisting: 0,
      skipped: 0,
    });
    expect(summary.parity).toEqual({
      missingLocalUserLinks: 1,
      missingLocalOrganizationLinks: 1,
      duplicateLocalOrganizationLinks: 0,
      missingLocalMembershipLinks: 1,
      staleLocalMembershipLinks: 0,
      membershipRoleMismatches: 0,
    });
    expect(repository.linkedUsers).toEqual([]);
  });

  it("creates missing WorkOS users, organizations, and active memberships", async () => {
    const repository = createMemoryRepository({
      users: [user({ passwordHash: TEST_BCRYPT_HASH, passwordHashType: "bcrypt" })],
      organizations: [organization()],
      memberships: [membership()],
    });
    const workos = createMemoryWorkosClient();

    const summary = await runWorkosBackfill({
      mode: "apply",
      cohort: defaultCohort(),
      repository,
      workos,
    });

    expect(summary.users.created).toBe(1);
    expect(workos.createdUsers).toEqual([
      {
        email: "owner@example.com",
        externalId: "user_internal",
        passwordHash: TEST_BCRYPT_HASH,
        passwordHashType: "bcrypt",
      },
    ]);
    expect(summary.organizations.created).toBe(1);
    expect(summary.memberships.created).toBe(1);
    expect(repository.linkedUsers).toEqual([
      expect.objectContaining({
        userId: "user_internal",
        workosUserId: "user_workos_created_1",
      }),
    ]);
    expect(repository.linkedOrganizations).toEqual([
      expect.objectContaining({
        organizationId: "org_internal",
        workosOrgId: "org_workos_created_1",
        workosExternalId: "org_internal",
      }),
    ]);
    expect(repository.linkedMemberships).toEqual([
      expect.objectContaining({
        membershipId: "membership_internal",
        workosMembershipId: "om_workos_created_1",
        roleSlugs: ["admin"],
      }),
    ]);
    expect(summary.parity).toEqual({
      missingLocalUserLinks: 0,
      missingLocalOrganizationLinks: 0,
      duplicateLocalOrganizationLinks: 0,
      missingLocalMembershipLinks: 0,
      staleLocalMembershipLinks: 0,
      membershipRoleMismatches: 0,
    });
  });

  it("uses WorkOS admin role for internal platform admins", async () => {
    const repository = createMemoryRepository({
      users: [user()],
      organizations: [organization({ kind: "platform" })],
      memberships: [membership({ roleKey: "platform_admin" })],
    });
    const workos = createMemoryWorkosClient();

    await runWorkosBackfill({
      mode: "apply",
      cohort: defaultCohort(),
      repository,
      workos,
    });

    expect(workos.createdMemberships[0]?.roleSlugs).toEqual(["admin"]);
    expect(repository.linkedMemberships[0]?.roleSlugs).toEqual(["admin"]);
  });

  it("links existing WorkOS resources by external ID before creating memberships", async () => {
    const repository = createMemoryRepository({
      users: [user({ passwordHash: TEST_BCRYPT_HASH, passwordHashType: "bcrypt" })],
      organizations: [organization()],
      memberships: [membership({ workosRoleSlugs: ["admin", "booking_manager"] })],
    });
    const workos = createMemoryWorkosClient({
      existingUsersByExternalId: new Map([["user_internal", "user_workos_existing"]]),
      existingOrganizationsByExternalId: new Map([["org_internal", "org_workos_existing"]]),
    });

    const summary = await runWorkosBackfill({
      mode: "apply",
      cohort: defaultCohort(),
      repository,
      workos,
    });

    expect(summary.users).toMatchObject({ created: 0, linkedExisting: 1, skipped: 0 });
    expect(summary.organizations).toMatchObject({ created: 0, linkedExisting: 1, skipped: 0 });
    expect(workos.createdUsers).toEqual([]);
    expect(workos.updatedUserPasswordHashes).toEqual([
      {
        userId: "user_workos_existing",
        passwordHash: TEST_BCRYPT_HASH,
        passwordHashType: "bcrypt",
      },
    ]);
    expect(workos.createdOrganizations).toEqual([]);
    expect(workos.createdMemberships).toEqual([
      {
        userId: "user_workos_existing",
        organizationId: "org_workos_existing",
        roleSlugs: ["admin"],
      },
    ]);
  });

  it("replaces a missing local WorkOS link with the canonical external-id user", async () => {
    const repository = createMemoryRepository({
      users: [user({ workosUserId: "workos_stale_missing", workosIdentityCount: 2 })],
      organizations: [],
      memberships: [],
    });
    const workos = createMemoryWorkosClient({
      existingUsersByExternalId: new Map([["user_internal", "user_workos_canonical"]]),
    });

    const summary = await runWorkosBackfill({
      mode: "apply",
      cohort: { key: "stale-user-link", userIds: ["user_internal"], organizationIds: [] },
      repository,
      workos,
    });

    expect(repository.linkedUsers).toEqual([
      expect.objectContaining({
        userId: "user_internal",
        workosUserId: "user_workos_canonical",
        retireWorkosUserIds: ["workos_stale_missing"],
      }),
    ]);
    expect(summary.users).toMatchObject({ linkedExisting: 1, conflicts: 0 });
    expect(summary.parity.missingLocalUserLinks).toBe(0);
  });

  it("links an existing WorkOS membership before creating a duplicate", async () => {
    const repository = createMemoryRepository({
      users: [user({ workosUserId: "user_workos_existing" })],
      organizations: [organization({ workosOrgId: "org_workos_existing" })],
      memberships: [membership()],
    });
    const workos = createMemoryWorkosClient({
      existingMembershipsByUserOrg: new Map([
        [
          "user_workos_existing:org_workos_existing",
          { id: "om_workos_existing", status: "active", roleSlugs: [] },
        ],
      ]),
    });

    const summary = await runWorkosBackfill({
      mode: "apply",
      cohort: defaultCohort(),
      repository,
      workos,
    });

    expect(summary.memberships).toMatchObject({ created: 0, linkedExisting: 1, skipped: 0 });
    expect(workos.createdMemberships).toEqual([]);
    expect(workos.updatedMemberships).toEqual([
      { membershipId: "om_workos_existing", roleSlugs: ["admin"] },
    ]);
    expect(repository.linkedMemberships).toEqual([
      expect.objectContaining({
        membershipId: "membership_internal",
        workosMembershipId: "om_workos_existing",
      }),
    ]);
  });

  it("reactivates existing inactive WorkOS memberships instead of treating them as linked", async () => {
    const repository = createMemoryRepository({
      users: [user({ workosUserId: "user_workos_existing" })],
      organizations: [organization({ workosOrgId: "org_workos_existing" })],
      memberships: [membership()],
    });
    const workos = createMemoryWorkosClient({
      existingMembershipsByUserOrg: new Map([
        [
          "user_workos_existing:org_workos_existing",
          { id: "om_workos_inactive", status: "inactive", roleSlugs: [] },
        ],
      ]),
    });

    const summary = await runWorkosBackfill({
      mode: "apply",
      cohort: defaultCohort(),
      repository,
      workos,
    });

    expect(summary.memberships).toMatchObject({ created: 0, linkedExisting: 1, skipped: 0 });
    expect(workos.createdMemberships).toEqual([
      {
        userId: "user_workos_existing",
        organizationId: "org_workos_existing",
        roleSlugs: ["admin"],
      },
    ]);
    expect(repository.linkedMemberships).toEqual([
      expect.objectContaining({
        membershipId: "membership_internal",
        workosMembershipId: "om_workos_inactive",
      }),
    ]);
  });

  it("repairs missing local organization external id for existing WorkOS links", async () => {
    const repository = createMemoryRepository({
      users: [user({ workosUserId: "user_workos_existing" })],
      organizations: [organization({ workosOrgId: "org_workos_existing" })],
      memberships: [membership({ workosMembershipId: "om_existing", workosRoleSlugs: ["admin"] })],
    });
    const workos = createMemoryWorkosClient({
      usersById: new Map([["user_workos_existing", { externalId: "user_internal" }]]),
      organizationsById: new Map([["org_workos_existing", { externalId: "org_internal" }]]),
    });

    const summary = await runWorkosBackfill({
      mode: "apply",
      cohort: defaultCohort(),
      repository,
      workos,
    });

    expect(repository.linkedOrganizations).toEqual([
      expect.objectContaining({
        organizationId: "org_internal",
        workosOrgId: "org_workos_existing",
        workosExternalId: "org_internal",
      }),
    ]);
    expect(summary.parity).toEqual({
      missingLocalUserLinks: 0,
      missingLocalOrganizationLinks: 0,
      duplicateLocalOrganizationLinks: 0,
      missingLocalMembershipLinks: 0,
      staleLocalMembershipLinks: 0,
      membershipRoleMismatches: 0,
    });
  });

  it("keeps parity incomplete when a user has duplicate local WorkOS identity rows", async () => {
    const repository = createMemoryRepository({
      users: [user({ workosUserId: "user_workos_existing", workosIdentityCount: 2 })],
      organizations: [
        organization({
          workosOrgId: "org_workos_existing",
          workosExternalId: "org_internal",
        }),
      ],
      memberships: [membership({ workosMembershipId: "om_existing", workosRoleSlugs: ["admin"] })],
    });

    const summary = await runWorkosBackfill({
      mode: "dry-run",
      cohort: defaultCohort(),
      repository,
    });

    expect(summary.parity).toEqual({
      missingLocalUserLinks: 1,
      missingLocalOrganizationLinks: 0,
      duplicateLocalOrganizationLinks: 0,
      missingLocalMembershipLinks: 0,
      staleLocalMembershipLinks: 0,
      membershipRoleMismatches: 0,
    });
  });

  it("keeps parity incomplete when cohort organizations share a WorkOS organization id", async () => {
    const repository = createMemoryRepository({
      users: [user({ workosUserId: "user_workos_existing" })],
      organizations: [
        organization({
          workosOrgId: "org_workos_duplicate",
          workosExternalId: "org_internal",
        }),
        organization({
          id: "org_second",
          name: "Second Organization",
          workosOrgId: "org_workos_duplicate",
          workosExternalId: "org_second",
        }),
      ],
      memberships: [membership({ workosMembershipId: "om_existing", workosRoleSlugs: ["admin"] })],
    });

    const summary = await runWorkosBackfill({
      mode: "dry-run",
      cohort: {
        key: "duplicate-orgs",
        userIds: ["user_internal"],
        organizationIds: ["org_internal", "org_second"],
      },
      repository,
    });

    expect(summary.parity).toEqual({
      missingLocalUserLinks: 0,
      missingLocalOrganizationLinks: 0,
      duplicateLocalOrganizationLinks: 2,
      missingLocalMembershipLinks: 0,
      staleLocalMembershipLinks: 0,
      membershipRoleMismatches: 0,
    });
  });

  it("updates role mismatches on existing WorkOS memberships", async () => {
    const repository = createMemoryRepository({
      users: [user({ workosUserId: "user_workos_existing" })],
      organizations: [
        organization({
          workosOrgId: "org_workos_existing",
          workosExternalId: "org_internal",
        }),
      ],
      memberships: [
        membership({
          workosMembershipId: "om_workos_existing",
          workosRoleSlugs: ["viewer"],
        }),
      ],
    });
    const workos = createMemoryWorkosClient({
      existingMembershipsByUserOrg: new Map([
        [
          "user_workos_existing:org_workos_existing",
          { id: "om_workos_existing", status: "active", roleSlugs: ["viewer"] },
        ],
      ]),
    });

    const summary = await runWorkosBackfill({
      mode: "apply",
      cohort: defaultCohort(),
      repository,
      workos,
    });

    expect(workos.updatedMemberships).toEqual([
      { membershipId: "om_workos_existing", roleSlugs: ["admin"] },
    ]);
    expect(repository.linkedMemberships).toEqual([
      expect.objectContaining({
        membershipId: "membership_internal",
        workosMembershipId: "om_workos_existing",
        roleSlugs: ["admin"],
      }),
    ]);
    expect(summary.parity).toEqual({
      missingLocalUserLinks: 0,
      missingLocalOrganizationLinks: 0,
      duplicateLocalOrganizationLinks: 0,
      missingLocalMembershipLinks: 0,
      staleLocalMembershipLinks: 0,
      membershipRoleMismatches: 0,
    });
  });

  it("reports stale local WorkOS membership links with the wrong user or organization", async () => {
    const repository = createMemoryRepository({
      users: [user({ workosUserId: "user_workos_existing" })],
      organizations: [
        organization({
          workosOrgId: "org_workos_existing",
          workosExternalId: "org_internal",
        }),
      ],
      memberships: [membership({ workosMembershipId: "om_wrong" })],
    });
    const workos = createMemoryWorkosClient({
      existingMembershipsById: new Map([
        [
          "om_wrong",
          {
            id: "om_wrong",
            userId: "user_other",
            organizationId: "org_workos_existing",
            status: "active",
            roleSlugs: ["admin"],
          },
        ],
      ]),
    });

    const summary = await runWorkosBackfill({
      mode: "apply",
      cohort: defaultCohort(),
      repository,
      workos,
    });

    expect(summary.memberships.conflicts).toBe(1);
    expect(summary.parity.staleLocalMembershipLinks).toBe(1);
    expect(repository.linkedMemberships).toEqual([]);
  });

  it("only backfills rows in the selected cohort", async () => {
    const repository = createMemoryRepository({
      users: [user(), user({ id: "user_outside", email: "outside@example.com" })],
      organizations: [organization(), organization({ id: "org_outside", name: "Outside" })],
      memberships: [
        membership(),
        membership({
          id: "membership_outside",
          userId: "user_outside",
          organizationId: "org_outside",
        }),
      ],
    });

    const summary = await runWorkosBackfill({
      mode: "dry-run",
      cohort: defaultCohort(),
      repository,
    });

    expect(summary.users.planned).toBe(1);
    expect(summary.organizations.planned).toBe(1);
    expect(summary.memberships.planned).toBe(1);
  });

  it("reports conflicts for existing WorkOS links with mismatched external ids", async () => {
    const repository = createMemoryRepository({
      users: [user({ workosUserId: "user_workos_existing" })],
      organizations: [
        organization({
          workosOrgId: "org_workos_existing",
          workosExternalId: "different_org",
        }),
      ],
      memberships: [membership()],
    });
    const workos = createMemoryWorkosClient({
      usersById: new Map([["user_workos_existing", { externalId: "different_user" }]]),
      organizationsById: new Map([["org_workos_existing", { externalId: "org_internal" }]]),
    });

    const summary = await runWorkosBackfill({
      mode: "apply",
      cohort: defaultCohort(),
      repository,
      workos,
    });

    expect(summary.users.conflicts).toBe(1);
    expect(summary.organizations.conflicts).toBe(1);
    expect(summary.memberships.skipped).toBe(1);
    expect(repository.linkedUsers).toEqual([]);
    expect(repository.linkedOrganizations).toEqual([]);
  });

  it("skips deleted users, archived organizations, and non-active memberships", async () => {
    const repository = createMemoryRepository({
      users: [user({ status: "deleted" })],
      organizations: [organization({ status: "archived" })],
      memberships: [membership({ status: "suspended" })],
    });
    const workos = createMemoryWorkosClient();

    const summary = await runWorkosBackfill({
      mode: "apply",
      cohort: defaultCohort(),
      repository,
      workos,
    });

    expect(summary.users.skipped).toBe(1);
    expect(summary.organizations.skipped).toBe(1);
    expect(summary.memberships.skipped).toBe(1);
    expect(summary.warnings).toEqual([
      "Skipped deleted user user_internal",
      "Skipped archived organization org_internal",
      "Skipped non-active membership membership_internal",
    ]);
    expect(workos.createdUsers).toEqual([]);
    expect(workos.createdOrganizations).toEqual([]);
    expect(workos.createdMemberships).toEqual([]);
    expect(summary.parity).toEqual({
      missingLocalUserLinks: 0,
      missingLocalOrganizationLinks: 0,
      duplicateLocalOrganizationLinks: 0,
      missingLocalMembershipLinks: 0,
      staleLocalMembershipLinks: 0,
      membershipRoleMismatches: 0,
    });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("WorkOS identity transfer (PostgreSQL)", () => {
  const deletedUserId = "a1334000-0000-4000-8000-000000000001";
  const activeUserId = "a1334000-0000-4000-8000-000000000002";
  const workosUserId = "workos_vay_1334_transfer";
  const replacementWorkosUserId = "workos_vay_1334_replacement";
  let client: pg.Client;
  let repository: WorkosBackfillRepository;

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query(
      `INSERT INTO identity.users (id, email, status)
       VALUES ($1, 'Admin@Example.com', 'deleted'), ($2, 'admin@example.com', 'active')`,
      [deletedUserId, activeUserId],
    );
    await client.query(
      `INSERT INTO identity.external_identities
         (user_id, provider, provider_user_id, provider_email, provider_email_verified)
       VALUES ($1, 'workos', $3, 'Admin@Example.com', true),
              ($2, 'workos', NULL, 'admin@example.com', false)`,
      [deletedUserId, activeUserId, workosUserId],
    );
    repository = createPgWorkosBackfillRepository({ connectionString: TEST_DATABASE_URL! });
  });

  afterAll(async () => {
    await repository.close?.();
    await client.query("DELETE FROM identity.auth_reconciliation_events WHERE user_id = $1", [
      activeUserId,
    ]);
    await client.query("DELETE FROM identity.external_identities WHERE user_id = ANY($1::uuid[])", [
      [deletedUserId, activeUserId],
    ]);
    await client.query("DELETE FROM identity.users WHERE id = ANY($1::uuid[])", [
      [deletedUserId, activeUserId],
    ]);
    await client.end();
  });

  it("moves a provider mapping only from a deleted same-email user", async () => {
    await repository.linkUser({
      userId: activeUserId,
      workosUserId,
      email: "admin@example.com",
      emailVerified: true,
      rawProfile: { source: "vayada-backfill" },
    });

    const { rows } = await client.query<{
      user_id: string;
      provider_user_id: string | null;
      history_reason: string | null;
    }>(
      `SELECT user_id::text, provider_user_id,
              raw_profile #>> '{provider_link_history,0,reason}' AS history_reason
       FROM identity.external_identities
       WHERE user_id = ANY($1::uuid[])
       ORDER BY user_id`,
      [[deletedUserId, activeUserId]],
    );
    expect(rows).toEqual([
      {
        user_id: deletedUserId,
        provider_user_id: null,
        history_reason: "duplicate_user_consolidation",
      },
      { user_id: activeUserId, provider_user_id: workosUserId, history_reason: null },
    ]);

    await repository.linkUser({
      userId: activeUserId,
      workosUserId: replacementWorkosUserId,
      email: "admin@example.com",
      emailVerified: true,
      rawProfile: { source: "vayada-backfill" },
      retireWorkosUserIds: [workosUserId],
    });
    expect(
      await client.query(
        `SELECT provider_user_id, raw_profile #>> '{provider_link_history,0,reason}' AS reason
         FROM identity.external_identities WHERE user_id = $1`,
        [activeUserId],
      ),
    ).toMatchObject({
      rows: [{ provider_user_id: replacementWorkosUserId, reason: "workos_user_missing" }],
    });

    await client.query(
      "UPDATE identity.external_identities SET provider_user_id = NULL WHERE user_id = $1",
      [activeUserId],
    );
    await client.query(
      "UPDATE identity.external_identities SET provider_user_id = $2 WHERE user_id = $1",
      [deletedUserId, replacementWorkosUserId],
    );
    await client.query("UPDATE identity.users SET status = 'suspended' WHERE id = $1", [
      activeUserId,
    ]);
    await expect(
      repository.linkUser({
        userId: activeUserId,
        workosUserId: replacementWorkosUserId,
        email: "admin@example.com",
        emailVerified: true,
        rawProfile: { source: "vayada-backfill" },
      }),
    ).rejects.toThrow(
      `WorkOS user ${replacementWorkosUserId} is already linked to user ${deletedUserId}`,
    );
  });
});

function user(overrides: Partial<WorkosBackfillSource["users"][number]> = {}) {
  const base = {
    id: "user_internal",
    email: "owner@example.com",
    name: "Owner",
    status: "active",
    emailVerified: true,
    workosUserId: null,
    workosIdentityCount: 0,
    passwordHash: null,
    passwordHashType: null,
    ...overrides,
  };
  if (overrides.workosUserId && overrides.workosIdentityCount === undefined) {
    base.workosIdentityCount = 1;
  }
  return base;
}

function organization(overrides: Partial<WorkosBackfillSource["organizations"][number]> = {}) {
  return {
    id: "org_internal",
    kind: "hotel_group",
    name: "Hotel Group",
    slug: "hotel-group",
    status: "active",
    workosOrgId: null,
    workosExternalId: null,
    ...overrides,
  };
}

function membership(overrides: Partial<WorkosBackfillSource["memberships"][number]> = {}) {
  return {
    id: "membership_internal",
    userId: "user_internal",
    organizationId: "org_internal",
    status: "active",
    roleKey: "hotel_owner",
    workosMembershipId: null,
    workosRoleSlugs: [],
    ...overrides,
  };
}

function defaultCohort() {
  return {
    key: "test-cohort",
    userIds: ["user_internal"],
    organizationIds: ["org_internal"],
  };
}

function createMemoryRepository(source: WorkosBackfillSource) {
  const linkedUsers: Array<Parameters<WorkosBackfillRepository["linkUser"]>[0]> = [];
  const linkedOrganizations: Array<Parameters<WorkosBackfillRepository["linkOrganization"]>[0]> =
    [];
  const linkedMemberships: Array<Parameters<WorkosBackfillRepository["linkMembership"]>[0]> = [];

  const repository: WorkosBackfillRepository & {
    linkedUsers: typeof linkedUsers;
    linkedOrganizations: typeof linkedOrganizations;
    linkedMemberships: typeof linkedMemberships;
  } = {
    linkedUsers,
    linkedOrganizations,
    linkedMemberships,
    async loadSource() {
      return source;
    },
    async linkUser(input) {
      linkedUsers.push(input);
      const sourceUser = source.users.find((candidate) => candidate.id === input.userId);
      if (sourceUser) {
        sourceUser.workosUserId = input.workosUserId;
        sourceUser.workosIdentityCount = 1;
      }
    },
    async linkOrganization(input) {
      linkedOrganizations.push(input);
      const sourceOrganization = source.organizations.find(
        (candidate) => candidate.id === input.organizationId,
      );
      if (sourceOrganization) {
        sourceOrganization.workosOrgId = input.workosOrgId;
        sourceOrganization.workosExternalId = input.workosExternalId;
      }
    },
    async linkMembership(input) {
      linkedMemberships.push(input);
      const sourceMembership = source.memberships.find(
        (candidate) => candidate.id === input.membershipId,
      );
      if (sourceMembership) {
        sourceMembership.workosMembershipId = input.workosMembershipId;
        sourceMembership.workosRoleSlugs = input.roleSlugs;
      }
    },
  };

  return repository;
}

function createMemoryWorkosClient(
  config: {
    existingUsersByExternalId?: Map<string, string>;
    existingOrganizationsByExternalId?: Map<string, string>;
    existingMembershipsByUserOrg?: Map<string, { id: string; status: string; roleSlugs: string[] }>;
    existingMembershipsById?: Map<
      string,
      {
        id: string;
        userId: string;
        organizationId: string;
        status: string;
        roleSlugs: string[];
      }
    >;
    usersById?: Map<string, { externalId: string | null }>;
    organizationsById?: Map<string, { externalId: string | null }>;
  } = {},
) {
  const createdUsers: Array<{
    email: string;
    externalId: string;
    passwordHash?: string;
    passwordHashType?: "bcrypt";
  }> = [];
  const createdOrganizations: Array<{ name: string; externalId: string }> = [];
  const createdMemberships: Array<{ userId: string; organizationId: string; roleSlugs: string[] }> =
    [];
  const updatedMemberships: Array<{ membershipId: string; roleSlugs: string[] }> = [];
  const updatedUserPasswordHashes: Array<{
    userId: string;
    passwordHash: string;
    passwordHashType: "bcrypt";
  }> = [];

  const workos: WorkosBackfillClient & {
    createdUsers: typeof createdUsers;
    createdOrganizations: typeof createdOrganizations;
    createdMemberships: typeof createdMemberships;
    updatedMemberships: typeof updatedMemberships;
    updatedUserPasswordHashes: typeof updatedUserPasswordHashes;
  } = {
    createdUsers,
    createdOrganizations,
    createdMemberships,
    updatedMemberships,
    updatedUserPasswordHashes,
    async getUserByExternalId(externalId) {
      const id = config.existingUsersByExternalId?.get(externalId);
      return id ? { id, externalId } : null;
    },
    async getUser(userId) {
      const user = config.usersById?.get(userId);
      if (user) return { id: userId, externalId: user.externalId };
      if (userId.startsWith("user_workos")) return { id: userId, externalId: "user_internal" };
      return null;
    },
    async updateUserExternalId() {},
    async updateUserPasswordHash(userId, passwordHash, passwordHashType) {
      updatedUserPasswordHashes.push({ userId, passwordHash, passwordHashType });
    },
    async getOrganization(organizationId) {
      const organization = config.organizationsById?.get(organizationId);
      if (organization) return { id: organizationId, externalId: organization.externalId };
      if (organizationId.startsWith("org_workos")) {
        return { id: organizationId, externalId: "org_internal" };
      }
      return null;
    },
    async createUser(input) {
      createdUsers.push({
        email: input.email,
        externalId: input.externalId,
        passwordHash: input.passwordHash,
        passwordHashType: input.passwordHashType,
      });
      return { id: `user_workos_created_${createdUsers.length}`, externalId: input.externalId };
    },
    async getOrganizationByExternalId(externalId) {
      const id = config.existingOrganizationsByExternalId?.get(externalId);
      return id ? { id, externalId } : null;
    },
    async updateOrganizationExternalId() {},
    async createOrganization(input) {
      createdOrganizations.push({ name: input.name, externalId: input.externalId });
      return {
        id: `org_workos_created_${createdOrganizations.length}`,
        externalId: input.externalId,
      };
    },
    async createOrganizationMembership(input) {
      createdMemberships.push(input);
      const existing = config.existingMembershipsByUserOrg?.get(
        `${input.userId}:${input.organizationId}`,
      );
      if (existing?.status === "inactive") {
        existing.status = "active";
        existing.roleSlugs = input.roleSlugs;
        return {
          id: existing.id,
          roleSlugs: input.roleSlugs,
          status: "active",
        };
      }
      return {
        id: `om_workos_created_${createdMemberships.length}`,
        roleSlugs: input.roleSlugs,
        status: "active",
      };
    },
    async getOrganizationMembership(membershipId) {
      const byId = config.existingMembershipsById?.get(membershipId);
      if (byId) return byId;
      for (const [key, membership] of config.existingMembershipsByUserOrg ?? new Map()) {
        if (membership.id !== membershipId) continue;
        const [userId, organizationId] = key.split(":");
        return {
          id: membership.id,
          userId,
          organizationId,
          roleSlugs: membership.roleSlugs,
          status: membership.status,
        };
      }
      if (membershipId.startsWith("om_")) {
        return {
          id: membershipId,
          userId: "user_workos_existing",
          organizationId: "org_workos_existing",
          roleSlugs: ["admin"],
          status: "active",
        };
      }
      return null;
    },
    async updateOrganizationMembershipRoles(membershipId, roleSlugs) {
      updatedMemberships.push({ membershipId, roleSlugs });
      for (const membership of config.existingMembershipsByUserOrg?.values() ?? []) {
        if (membership.id === membershipId) membership.roleSlugs = roleSlugs;
      }
      return { id: membershipId, roleSlugs, status: "active" };
    },
    async findOrganizationMembership(input) {
      const membership = config.existingMembershipsByUserOrg?.get(
        `${input.userId}:${input.organizationId}`,
      );
      return membership
        ? { id: membership.id, roleSlugs: membership.roleSlugs, status: membership.status }
        : null;
    },
  };

  return workos;
}
