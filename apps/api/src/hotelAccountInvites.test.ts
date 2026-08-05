import {
  createFakeVerifier,
  type IdentityRepository,
  type PermissionKey,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import type { SetupTrack, UpdateTracksResponse } from "@vayada/domain-hotels";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import type { HotelSetupTrackCommandRepository } from "./domains/hotelSetupTrackCommandRepository.js";
import {
  createPgHotelAccountInviteRepository,
  type HotelAccountInvite,
  type HotelAccountInviteLookupResponse,
  type HotelAccountInviteRedemptionResponse,
  type HotelAccountInviteRepository,
} from "./routes/hotelAccountInvites.js";

const NOW = new Date("2026-08-02T12:00:00.000Z");
const INVITE_CODE = "VAY-0123456789abcdef";
const HOTEL_ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_HOTEL_ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_USER_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_USER_ID = "44444444-4444-4444-8444-444444444444";

const ownerSession: VerifiedSession = {
  workosUserId: "workos_owner",
  workosOrgId: "workos_hotel",
  sessionId: "owner_session",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};
const otherOwnerSession: VerifiedSession = {
  workosUserId: "workos_other_owner",
  workosOrgId: "workos_second_hotel",
  sessionId: "other_owner_session",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};
const creatorSession: VerifiedSession = {
  workosUserId: "workos_creator",
  workosOrgId: "workos_creator_org",
  sessionId: "creator_session",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

describe("hotel account invite routes", () => {
  let app: ReturnType<typeof buildApp> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("returns only the safe public lookup contract", async () => {
    const repository = createMemoryInviteRepository();
    const tracks = createMemoryTrackCommands();
    app = buildInviteApp(repository, tracks.repository);

    const response = await injectJson<HotelAccountInviteLookupResponse>(app, {
      method: "POST",
      url: "/api/marketplace/hotel-account-invites/lookup",
      payload: { code: INVITE_CODE },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      contractVersion: "hotel-account-invite.v1",
      identity: { emailHint: "o****@example.test" },
      organization: { displayName: "Alpenrose Hospitality" },
      property: { displayName: "Hotel Alpenrose" },
      selectedTracks: ["creator_marketplace"],
      handoffPath: "/setup",
      expiresAt: "2026-08-20T12:00:00.000Z",
    });
    expect(JSON.stringify(response.body)).not.toContain(INVITE_CODE);
    expect(JSON.stringify(response.body)).not.toContain("owner@example.test");
  });

  it.each(["expired", "revoked"] as const)(
    "does not expose %s invitations through lookup or redemption",
    async (status) => {
      const repository = createMemoryInviteRepository({ status });
      const tracks = createMemoryTrackCommands();
      app = buildInviteApp(repository, tracks.repository);

      const lookup = await injectJson(app, {
        method: "POST",
        url: "/api/marketplace/hotel-account-invites/lookup",
        payload: { code: INVITE_CODE },
      });
      const redeem = await injectJson(app, {
        method: "POST",
        url: "/api/marketplace/hotel-account-invites/redeem",
        headers: { authorization: "Bearer owner-token" },
        payload: { code: INVITE_CODE },
      });

      expect(lookup.statusCode).toBe(404);
      expect(redeem.statusCode).toBe(404);
      expect(lookup.body).toEqual(redeem.body);
      expect(tracks.calls).toHaveLength(0);
    },
  );

  it("uses the same non-sensitive error for malformed, unknown, and wrong-identity tokens", async () => {
    const repository = createMemoryInviteRepository();
    const tracks = createMemoryTrackCommands();
    app = buildInviteApp(repository, tracks.repository);

    const malformed = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/hotel-account-invites/lookup",
      payload: { code: INVITE_CODE, email: "owner@example.test" },
    });
    const unknown = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/hotel-account-invites/lookup",
      payload: { code: "VAY-unknown00" },
    });
    const wrongIdentity = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/hotel-account-invites/redeem",
      headers: { authorization: "Bearer other-owner-token" },
      payload: { code: INVITE_CODE },
    });

    expect(malformed.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(wrongIdentity.statusCode).toBe(404);
    for (const response of [malformed, unknown, wrongIdentity]) {
      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain(INVITE_CODE);
      expect(serialized).not.toContain("owner@example.test");
    }
    expect(tracks.calls).toHaveLength(0);
  });

  it("requires an authenticated active hotel account before reading the redemption token", async () => {
    const repository = createMemoryInviteRepository();
    const tracks = createMemoryTrackCommands();
    app = buildInviteApp(repository, tracks.repository);

    const unauthenticated = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/hotel-account-invites/redeem",
      payload: { code: INVITE_CODE },
    });
    const creator = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/hotel-account-invites/redeem",
      headers: { authorization: "Bearer creator-token" },
      payload: { code: INVITE_CODE },
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(creator.statusCode).toBe(403);
    expect(repository.calls.redeem).toHaveLength(0);
    expect(tracks.calls).toHaveLength(0);
  });

  it("requires canonical hotel product management permission before reading the token", async () => {
    const repository = createMemoryInviteRepository();
    const tracks = createMemoryTrackCommands();
    app = buildInviteApp(repository, tracks.repository, ["hotel_catalog.setup.read"]);

    const response = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/hotel-account-invites/redeem",
      headers: { authorization: "Bearer owner-token" },
      payload: { code: INVITE_CODE },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toMatchObject({ code: "missing_permission" });
    expect(repository.calls.redeem).toHaveLength(0);
    expect(tracks.calls).toHaveLength(0);
  });

  it.each([
    ["Marketplace", ["creator_marketplace"]],
    ["Hotel Operations", ["hotel_operations"]],
    ["combined", ["hotel_operations", "creator_marketplace"]],
  ] as const)(
    "redeems the %s intent only after the canonical track command succeeds",
    async (_, selectedTracks) => {
      const repository = createMemoryInviteRepository({ selectedTracks: [...selectedTracks] });
      const tracks = createMemoryTrackCommands();
      app = buildInviteApp(repository, tracks.repository);

      const response = await injectJson<HotelAccountInviteRedemptionResponse>(app, {
        method: "POST",
        url: "/api/marketplace/hotel-account-invites/redeem",
        headers: { authorization: "Bearer owner-token" },
        payload: { code: INVITE_CODE },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual({
        contractVersion: "hotel-account-invite.v1",
        status: "redeemed",
        selectedTracks,
        handoffPath: "/setup",
      });
      expect(tracks.calls).toHaveLength(1);
      expect(tracks.calls[0]).toMatchObject({
        organizationId: HOTEL_ORGANIZATION_ID,
        actorUserId: OWNER_USER_ID,
        selectedTracks,
        expectedRevision: 0,
        idempotencyKey: "hotel-account-invite:invite-1050:tracks:r0",
        audit: {
          source: "api",
          correlationId: "hotel-account-invite:invite-1050:tracks",
        },
      });
      expect(repository.status()).toBe("redeemed");
    },
  );

  it("uses a fresh canonical key after a track revision race", async () => {
    const repository = createMemoryInviteRepository();
    const tracks = createMemoryTrackCommands({ revisionConflicts: 1 });
    app = buildInviteApp(repository, tracks.repository);

    const first = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/hotel-account-invites/redeem",
      headers: { authorization: "Bearer owner-token" },
      payload: { code: INVITE_CODE },
    });
    expect(first.statusCode).toBe(503);
    expect(repository.status()).toBe("pending");

    const retry = await injectJson<HotelAccountInviteRedemptionResponse>(app, {
      method: "POST",
      url: "/api/marketplace/hotel-account-invites/redeem",
      headers: { authorization: "Bearer owner-token" },
      payload: { code: INVITE_CODE },
    });

    expect(retry.statusCode).toBe(200);
    expect(retry.body.status).toBe("redeemed");
    expect(tracks.calls).toHaveLength(2);
    expect(tracks.calls.map((call) => call.idempotencyKey)).toEqual([
      "hotel-account-invite:invite-1050:tracks:r0",
      "hotel-account-invite:invite-1050:tracks:r1",
    ]);
    expect(tracks.calls.map((call) => call.audit)).toEqual([
      expect.objectContaining({ correlationId: "hotel-account-invite:invite-1050:tracks" }),
      expect.objectContaining({ correlationId: "hotel-account-invite:invite-1050:tracks" }),
    ]);
  });

  it("does not consume the invitation when the canonical track command conflicts", async () => {
    const repository = createMemoryInviteRepository({
      selectedTracks: ["creator_marketplace"],
    });
    const tracks = createMemoryTrackCommands({ selectedTracks: ["hotel_operations"] });
    app = buildInviteApp(repository, tracks.repository);

    const response = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/hotel-account-invites/redeem",
      headers: { authorization: "Bearer owner-token" },
      payload: { code: INVITE_CODE },
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ code: "invite_track_conflict" });
    expect(repository.status()).toBe("pending");
    expect(tracks.calls).toHaveLength(0);
  });

  it("rejects a selected hotel organization without the invite-derived durable binding", async () => {
    const repository = createMemoryInviteRepository({
      boundOrganizationId: SECOND_HOTEL_ORGANIZATION_ID,
    });
    const tracks = createMemoryTrackCommands();
    app = buildInviteApp(repository, tracks.repository);

    const response = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/hotel-account-invites/redeem",
      headers: { authorization: "Bearer owner-token" },
      payload: { code: INVITE_CODE },
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ code: "invite_wrong_organization" });
    expect(repository.status()).toBe("pending");
    expect(tracks.calls).toHaveLength(0);
  });

  it("recovers when canonical intent commits but invite finalization initially fails", async () => {
    const repository = createMemoryInviteRepository({ finalizeFailures: 1 });
    const tracks = createMemoryTrackCommands();
    app = buildInviteApp(repository, tracks.repository);

    const first = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/hotel-account-invites/redeem",
      headers: { authorization: "Bearer owner-token" },
      payload: { code: INVITE_CODE },
    });
    expect(first.statusCode).toBe(503);
    expect(repository.status()).toBe("pending");
    expect(tracks.selectedTracks()).toEqual(["creator_marketplace"]);
    expect(tracks.calls).toHaveLength(1);

    const retry = await injectJson<HotelAccountInviteRedemptionResponse>(app, {
      method: "POST",
      url: "/api/marketplace/hotel-account-invites/redeem",
      headers: { authorization: "Bearer owner-token" },
      payload: { code: INVITE_CODE },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.body.status).toBe("redeemed");
    expect(repository.status()).toBe("redeemed");
    expect(tracks.calls).toHaveLength(1);
  });

  it("returns an idempotent replay only to the same actor on an account with the persisted intent", async () => {
    const repository = createMemoryInviteRepository();
    const tracks = createMemoryTrackCommands();
    app = buildInviteApp(repository, tracks.repository);

    const first = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/hotel-account-invites/redeem",
      headers: { authorization: "Bearer owner-token" },
      payload: { code: INVITE_CODE },
    });
    const replay = await injectJson<HotelAccountInviteRedemptionResponse>(app, {
      method: "POST",
      url: "/api/marketplace/hotel-account-invites/redeem",
      headers: { authorization: "Bearer owner-token" },
      payload: { code: INVITE_CODE },
    });
    const otherActor = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/hotel-account-invites/redeem",
      headers: { authorization: "Bearer other-owner-token" },
      payload: { code: INVITE_CODE },
    });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.body.status).toBe("already_redeemed");
    expect(otherActor.statusCode).toBe(409);
    expect(otherActor.body).toMatchObject({ code: "invite_already_redeemed" });
    expect(tracks.calls).toHaveLength(1);
  });

  it("serializes concurrent redemption so only one actor can apply the invite", async () => {
    const repository = createMemoryInviteRepository({ acceptAnyEmailForTest: true });
    const tracks = createMemoryTrackCommands({ updateDelayMs: 20 });
    app = buildInviteApp(repository, tracks.repository);

    const [owner, other] = await Promise.all([
      injectJson(app, {
        method: "POST",
        url: "/api/marketplace/hotel-account-invites/redeem",
        headers: { authorization: "Bearer owner-token" },
        payload: { code: INVITE_CODE },
      }),
      injectJson(app, {
        method: "POST",
        url: "/api/marketplace/hotel-account-invites/redeem",
        headers: { authorization: "Bearer other-owner-token" },
        payload: { code: INVITE_CODE },
      }),
    ]);

    expect([owner.statusCode, other.statusCode].sort()).toEqual([200, 409]);
    expect(tracks.calls).toHaveLength(1);
    expect(repository.status()).toBe("redeemed");
  });
});

describe("Postgres hotel account invite repository", () => {
  it("derives the internal onboarding binding from the validated invite row, never the code", async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const repository = createPgHotelAccountInviteRepository({
      connectionString: "postgresql://target-db",
      pool: {
        async connect() {
          throw new Error("unexpected transaction");
        },
        async query(sql: string, values: unknown[]) {
          queries.push({ sql, values });
          return { rows: [inviteRow()], rowCount: 1 };
        },
        async end() {},
      } as never,
    });

    const resolution = await repository.resolveForOnboarding({
      code: INVITE_CODE,
      now: NOW,
      actorEmail: " OWNER@example.test ",
    });
    const wrongEmail = await repository.resolveForOnboarding({
      code: INVITE_CODE,
      now: NOW,
      actorEmail: "other@example.test",
    });

    expect(resolution).toEqual({
      inviteId: "invite-1050",
      organizationName: "Alpenrose Hospitality",
      organizationExternalId: "vayada-signup:marketplace-web:hotel:invite:invite-1050",
    });
    expect(resolution?.organizationExternalId).not.toContain(INVITE_CODE);
    expect(wrongEmail).toBeNull();
    expect(queries[0]?.values[0]).toBe(INVITE_CODE);
    expect(queries[0]?.sql).toContain("invite.status = 'pending'");
    expect(queries[0]?.sql).toContain("invite.expires_at > $3::timestamptz");
  });

  it("holds the invite row lock across canonical intent application and finalizes afterward", async () => {
    const events: string[] = [];
    const client = scriptedClient(events, inviteRow());
    const repository = createPgHotelAccountInviteRepository({
      connectionString: "postgresql://target-db",
      pool: {
        async connect() {
          return client as never;
        },
        async query() {
          throw new Error("unexpected pool query");
        },
        async end() {},
      } as never,
    });

    const result = await repository.redeem({
      code: INVITE_CODE,
      now: NOW,
      actorUserId: OWNER_USER_ID,
      actorEmail: "owner@example.test",
      organizationId: HOTEL_ORGANIZATION_ID,
      async applyTracks(_invite, mode) {
        expect(mode).toBe("apply");
        events.push("APPLY_CANONICAL_TRACKS");
        return "applied";
      },
    });

    expect(result.outcome).toBe("redeemed");
    expect(events).toEqual([
      "BEGIN",
      "SELECT_FOR_UPDATE",
      "CHECK_ORGANIZATION_BINDING",
      "FIND_TRACK_BINDING",
      "APPLY_CANONICAL_TRACKS",
      "FIND_TRACK_BINDING",
      "UPDATE_REDEEMED",
      "COMMIT",
      "RELEASE",
    ]);
  });

  it("rolls back without consuming when canonical application fails", async () => {
    const events: string[] = [];
    const client = scriptedClient(events, inviteRow());
    const repository = createPgHotelAccountInviteRepository({
      connectionString: "postgresql://target-db",
      pool: {
        async connect() {
          return client as never;
        },
        async query() {
          throw new Error("unexpected pool query");
        },
        async end() {},
      } as never,
    });

    const result = await repository.redeem({
      code: INVITE_CODE,
      now: NOW,
      actorUserId: OWNER_USER_ID,
      actorEmail: "owner@example.test",
      organizationId: HOTEL_ORGANIZATION_ID,
      async applyTracks(_invite, mode) {
        expect(mode).toBe("apply");
        events.push("APPLY_CANONICAL_TRACKS");
        return "temporarily_unavailable";
      },
    });

    expect(result.outcome).toBe("temporarily_unavailable");
    expect(events).toEqual([
      "BEGIN",
      "SELECT_FOR_UPDATE",
      "CHECK_ORGANIZATION_BINDING",
      "FIND_TRACK_BINDING",
      "APPLY_CANONICAL_TRACKS",
      "ROLLBACK",
      "RELEASE",
    ]);
  });

  it("rejects an organization whose stored WorkOS external ID is not invite-bound", async () => {
    const events: string[] = [];
    const client = scriptedClient(events, inviteRow(), { organizationBound: false });
    const repository = createPgHotelAccountInviteRepository({
      connectionString: "postgresql://target-db",
      pool: {
        async connect() {
          return client as never;
        },
        async query() {
          throw new Error("unexpected pool query");
        },
        async end() {},
      } as never,
    });
    const applyTracks = vi.fn(async () => "applied" as const);

    const result = await repository.redeem({
      code: INVITE_CODE,
      now: NOW,
      actorUserId: OWNER_USER_ID,
      actorEmail: "owner@example.test",
      organizationId: HOTEL_ORGANIZATION_ID,
      applyTracks,
    });

    expect(result.outcome).toBe("wrong_organization");
    expect(applyTracks).not.toHaveBeenCalled();
    expect(events).toEqual([
      "BEGIN",
      "SELECT_FOR_UPDATE",
      "CHECK_ORGANIZATION_BINDING",
      "ROLLBACK",
      "RELEASE",
    ]);
  });

  it("finds canonical recovery only through the invite-bound organization external ID", async () => {
    const events: string[] = [];
    const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
    const client = scriptedClient(events, inviteRow(), { queries });
    const repository = createPgHotelAccountInviteRepository({
      connectionString: "postgresql://target-db",
      pool: {
        async connect() {
          return client as never;
        },
        async query() {
          throw new Error("unexpected pool query");
        },
        async end() {},
      } as never,
    });

    await repository.redeem({
      code: INVITE_CODE,
      now: NOW,
      actorUserId: OWNER_USER_ID,
      actorEmail: "owner@example.test",
      organizationId: HOTEL_ORGANIZATION_ID,
      async applyTracks() {
        events.push("APPLY_CANONICAL_TRACKS");
        return "applied";
      },
    });

    const bindingQuery = queries.find(({ sql }) =>
      sql.includes("FROM platform.idempotency_keys redemption"),
    );
    expect(bindingQuery?.sql).toContain("JOIN identity.organizations organization");
    expect(bindingQuery?.sql).toContain("organization.workos_external_id = $3");
    expect(bindingQuery?.values).toEqual([
      "hotel_setup.tracks.update",
      "hotel-account-invite:invite-1050:tracks",
      "vayada-signup:marketplace-web:hotel:invite:invite-1050",
    ]);
  });

  it("recovers a committed canonical binding after invite expiry without applying twice", async () => {
    const events: string[] = [];
    const row = { ...inviteRow(), expiresAt: "2026-08-01T12:00:00.000Z" };
    const client = scriptedClient(events, row, {
      trackBindingOrganizationId: HOTEL_ORGANIZATION_ID,
    });
    const repository = createPgHotelAccountInviteRepository({
      connectionString: "postgresql://target-db",
      pool: {
        async connect() {
          return client as never;
        },
        async query() {
          throw new Error("unexpected pool query");
        },
        async end() {},
      } as never,
    });
    const applyTracks = vi.fn(async (_invite, mode: "apply" | "recover") => {
      expect(mode).toBe("recover");
      return "applied" as const;
    });

    const result = await repository.redeem({
      code: INVITE_CODE,
      now: NOW,
      actorUserId: OWNER_USER_ID,
      actorEmail: "owner@example.test",
      organizationId: HOTEL_ORGANIZATION_ID,
      applyTracks,
    });

    expect(result.outcome).toBe("redeemed");
    expect(applyTracks).toHaveBeenCalledOnce();
    expect(events).toEqual([
      "BEGIN",
      "SELECT_FOR_UPDATE",
      "CHECK_ORGANIZATION_BINDING",
      "FIND_TRACK_BINDING",
      "UPDATE_REDEEMED",
      "COMMIT",
      "RELEASE",
    ]);
  });
});

function buildInviteApp(
  repository: HotelAccountInviteRepository,
  trackCommandRepository: Pick<HotelSetupTrackCommandRepository, "getTrackStatus" | "updateTracks">,
  permissions: PermissionKey[] = [
    "hotel_catalog.setup.read",
    "hotel_catalog.setup.manage",
    "hotel_catalog.products.manage",
  ],
) {
  const identityRepository: IdentityRepository = {
    async findUserByProviderUserId(_provider, providerUserId) {
      if (providerUserId === "workos_owner") {
        return { userId: OWNER_USER_ID, email: "owner@example.test", status: "active" };
      }
      if (providerUserId === "workos_other_owner") {
        return { userId: OTHER_USER_ID, email: "other@example.test", status: "active" };
      }
      return {
        userId: "55555555-5555-4555-8555-555555555555",
        email: "creator@example.test",
        status: "active",
      };
    },
    async findOrganizationByWorkosOrgId(workosOrgId) {
      if (workosOrgId === "workos_hotel") {
        return {
          organizationId: HOTEL_ORGANIZATION_ID,
          workosOrgId,
          name: "Alpenrose Hospitality",
          kind: "hotel_group",
          status: "active",
        };
      }
      if (workosOrgId === "workos_second_hotel") {
        return {
          organizationId: SECOND_HOTEL_ORGANIZATION_ID,
          workosOrgId,
          name: "Second Hotel Group",
          kind: "hotel_group",
          status: "active",
        };
      }
      return {
        organizationId: "66666666-6666-4666-8666-666666666666",
        workosOrgId,
        kind: "creator_workspace",
        status: "active",
      };
    },
    async findActiveMembership(_userId, organizationId) {
      return {
        membershipId: `membership-${organizationId}`,
        status: "active",
        roleKey: organizationId === HOTEL_ORGANIZATION_ID ? "hotel_owner" : "creator_owner",
        workosMembershipId: null,
        workosRoleSlugs: [],
      };
    },
    async findLinkedResources() {
      return [];
    },
  };

  return buildApp({
    logger: false,
    hotelAccountInvites: { repository, now: () => NOW },
    hotelSetupTrackCommandRepository: trackCommandRepository as HotelSetupTrackCommandRepository,
    auth: {
      verifier: createFakeVerifier(
        new Map([
          ["owner-token", ownerSession],
          ["other-owner-token", otherOwnerSession],
          ["creator-token", creatorSession],
        ]),
      ),
      repository: identityRepository,
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return [...permissions];
        },
      },
    },
  });
}

function createMemoryInviteRepository(
  options: {
    status?: "pending" | "redeemed" | "expired" | "revoked";
    selectedTracks?: SetupTrack[];
    finalizeFailures?: number;
    acceptAnyEmailForTest?: boolean;
    boundOrganizationId?: string;
  } = {},
) {
  const invite = inviteFixture(options.selectedTracks);
  let status = options.status ?? "pending";
  let redeemedBy: string | null = status === "redeemed" ? OWNER_USER_ID : null;
  let redemptionOrganizationId: string | null =
    status === "redeemed" ? HOTEL_ORGANIZATION_ID : null;
  let trackBindingOrganizationId: string | null =
    status === "redeemed" ? HOTEL_ORGANIZATION_ID : null;
  const boundOrganizationId = options.boundOrganizationId ?? HOTEL_ORGANIZATION_ID;
  let finalizeFailures = options.finalizeFailures ?? 0;
  let queue = Promise.resolve();
  const calls = { lookup: [] as unknown[], redeem: [] as unknown[] };

  const repository: HotelAccountInviteRepository & {
    calls: typeof calls;
    status(): typeof status;
  } = {
    calls,
    status: () => status,
    async lookup(input) {
      calls.lookup.push(input);
      return input.code === INVITE_CODE &&
        status === "pending" &&
        new Date(invite.expiresAt) > input.now
        ? invite
        : null;
    },
    async resolveForOnboarding(input) {
      return input.code === INVITE_CODE &&
        status === "pending" &&
        new Date(invite.expiresAt) > input.now &&
        input.actorEmail.trim().toLowerCase() === invite.identity.email
        ? {
            inviteId: invite.id,
            organizationName: invite.organization.displayName,
            organizationExternalId: `vayada-signup:marketplace-web:hotel:invite:${invite.id}`,
          }
        : null;
    },
    async redeem(input) {
      calls.redeem.push({
        code: input.code,
        actorUserId: input.actorUserId,
        actorEmail: input.actorEmail,
      });
      const previous = queue;
      let release = () => {};
      queue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        if (input.code !== INVITE_CODE || status === "expired" || status === "revoked") {
          return { outcome: "not_available" };
        }
        if (new Date(invite.expiresAt) <= input.now) {
          status = "expired";
          return { outcome: "not_available" };
        }
        if (status === "redeemed") {
          return redeemedBy === input.actorUserId &&
            redemptionOrganizationId === input.organizationId
            ? { outcome: "already_redeemed", invite }
            : { outcome: "replayed_by_another_actor" };
        }
        if (!options.acceptAnyEmailForTest && input.actorEmail !== invite.identity.email) {
          return { outcome: "wrong_identity" };
        }
        if (input.organizationId !== boundOrganizationId) {
          return { outcome: "wrong_organization" };
        }
        if (trackBindingOrganizationId && trackBindingOrganizationId !== input.organizationId) {
          return { outcome: "wrong_organization" };
        }
        const applied = await input.applyTracks(
          invite,
          trackBindingOrganizationId ? "recover" : "apply",
        );
        if (applied !== "applied") return { outcome: applied };
        trackBindingOrganizationId = input.organizationId;
        if (finalizeFailures > 0) {
          finalizeFailures -= 1;
          throw new Error("simulated invite finalization failure");
        }
        status = "redeemed";
        redeemedBy = input.actorUserId;
        redemptionOrganizationId = input.organizationId;
        return { outcome: "redeemed", invite };
      } finally {
        release();
      }
    },
  };
  return repository;
}

function createMemoryTrackCommands(
  options: {
    selectedTracks?: SetupTrack[];
    updateDelayMs?: number;
    revisionConflicts?: number;
  } = {},
) {
  let selectedTracks = [...(options.selectedTracks ?? [])];
  let revision = selectedTracks.length > 0 ? 1 : 0;
  let revisionConflicts = options.revisionConflicts ?? 0;
  const calls: Array<Record<string, unknown>> = [];
  const repository = {
    async getTrackStatus() {
      return setupStatus(selectedTracks, revision);
    },
    async updateTracks(command: Parameters<HotelSetupTrackCommandRepository["updateTracks"]>[0]) {
      calls.push(command);
      if (options.updateDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.updateDelayMs));
      }
      if (revisionConflicts > 0) {
        revisionConflicts -= 1;
        revision += 1;
        return {
          ok: false as const,
          error: { code: "track_revision_conflict" as const, currentRevision: revision },
        };
      }
      selectedTracks = [...command.selectedTracks];
      revision += 1;
      return { ok: true as const, response: setupStatus(selectedTracks, revision) };
    },
  };
  return { repository, calls, selectedTracks: () => selectedTracks };
}

function setupStatus(selectedTracks: SetupTrack[], trackRevision: number): UpdateTracksResponse {
  return {
    trackRevision,
    selectedTracks: [...selectedTracks],
    tracks: ["hotel_operations", "creator_marketplace"].map((track) => ({
      track: track as SetupTrack,
      provisioning: selectedTracks.includes(track as SetupTrack) ? "active" : "not_selected",
      components: [],
      allowedActions: selectedTracks.includes(track as SetupTrack) ? ["manage_service"] : ["add"],
    })),
  };
}

function inviteFixture(selectedTracks: SetupTrack[] = ["creator_marketplace"]): HotelAccountInvite {
  return {
    id: "invite-1050",
    contractVersion: "hotel-account-invite.v1",
    identity: { email: "owner@example.test" },
    organization: { displayName: "Alpenrose Hospitality" },
    property: { displayName: "Hotel Alpenrose" },
    selectedTracks,
    handoffPath: "/setup",
    expiresAt: "2026-08-20T12:00:00.000Z",
    redemptionOrganizationId: null,
  };
}

function inviteRow() {
  const { id, expiresAt, redemptionOrganizationId, ...payload } = inviteFixture();
  return {
    id,
    status: "pending",
    payload,
    redeemedByUserId: null,
    redemptionOrganizationId,
    expiresAt,
  };
}

function scriptedClient(
  events: string[],
  row: ReturnType<typeof inviteRow>,
  options: {
    organizationBound?: boolean;
    trackBindingOrganizationId?: string;
    queries?: Array<{ sql: string; values: readonly unknown[] }>;
  } = {},
) {
  return {
    async query(sql: string, values: readonly unknown[] = []) {
      const normalized = sql.trim();
      options.queries?.push({ sql: normalized, values });
      if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
        events.push(normalized);
        return { rows: [], rowCount: null };
      }
      if (normalized.includes("FOR UPDATE")) {
        events.push("SELECT_FOR_UPDATE");
        return { rows: [row], rowCount: 1 };
      }
      if (normalized.includes("FROM platform.idempotency_keys")) {
        events.push("FIND_TRACK_BINDING");
        const organizationId =
          options.trackBindingOrganizationId ??
          (events.includes("APPLY_CANONICAL_TRACKS") ? HOTEL_ORGANIZATION_ID : null);
        return organizationId
          ? { rows: [{ organizationId }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (normalized.includes("FROM identity.organizations")) {
        events.push("CHECK_ORGANIZATION_BINDING");
        return options.organizationBound === false
          ? { rows: [], rowCount: 0 }
          : { rows: [{ exists: 1 }], rowCount: 1 };
      }
      if (normalized.includes("SET status = 'redeemed'")) {
        events.push("UPDATE_REDEEMED");
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    },
    release: vi.fn(() => events.push("RELEASE")),
  };
}
