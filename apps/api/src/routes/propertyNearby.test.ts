import {
  createFakeVerifier,
  type PermissionKey,
  type IdentityRepository,
} from "@vayada/backend-auth";
import type { PropertyAccessRepository } from "@vayada/backend-authorization";
import type { NearbyCurationState } from "@vayada/domain-hotels";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import type {
  NearbyClaim,
  NearbyDiscoveryState,
} from "../domains/propertyNearbyDiscoveryRepository.js";
import type { NearbySaveResult } from "../domains/propertyNearbyRepository.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const actorUserId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const path = `/api/hotel-setup/properties/${propertyId}/nearby/curation`;
const payload = {
  schemaVersion: 1,
  expectedProfileRevision: 1,
  expectedCurationRevision: 0,
  choices: [],
  customPlaces: [],
};
const state: NearbyCurationState = {
  schemaVersion: 1,
  profileRevision: 1,
  curationRevision: 1,
  savedProfileRevision: 1,
  choices: [],
  customPlaces: [],
};
const permissions: PermissionKey[] = [
  "hotel_catalog.setup.read",
  "hotel_catalog.setup.manage",
  "booking.settings.manage",
];
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup(
  options: {
    permissions?: PermissionKey[];
    linked?: boolean;
    assigned?: boolean;
    suspended?: boolean;
    saveResult?: NearbySaveResult;
    configured?: boolean;
    claim?: NearbyClaim;
    completed?: NearbyDiscoveryState | null;
  } = {},
) {
  const repository: IdentityRepository = {
    async findUserByProviderUserId() {
      return { userId: actorUserId, email: "owner@example.test", status: "active" };
    },
    async findOrganizationByWorkosOrgId() {
      return { organizationId, workosOrgId: "org", kind: "hotel_group", status: "active" };
    },
    async findActiveMembership() {
      return {
        membershipId: "member",
        status: options.suspended ? "suspended" : "active",
        roleKey: "hotel_owner",
        workosMembershipId: "om",
        workosRoleSlugs: ["hotel_owner"],
      };
    },
    async findLinkedResources() {
      return options.linked === false
        ? []
        : [
            {
              product: "hotel_catalog",
              resourceType: "property",
              resourceId: propertyId,
              relationship: "owner",
              status: "active",
            },
          ];
    },
  };
  const propertyAccessRepository: PropertyAccessRepository = {
    async findMembershipPropertyScope() {
      return {
        mode: options.assigned === false ? "assigned" : "all",
        roleKey: "hotel_owner",
        accessOrigin: "agency",
        assignedPropertyIds: [],
      };
    },
  };
  const read = vi.fn(async () => state);
  const save = vi.fn(
    async (): Promise<NearbySaveResult> => options.saveResult ?? { ok: true, state },
  );
  const discoveryState: NearbyDiscoveryState = {
    schemaVersion: 1,
    profileRevision: 1,
    status: "ready",
    places: [{ placeId: "beach", category: "nature" }],
    retryAfter: null,
  };
  const claim = vi.fn(
    async (): Promise<NearbyClaim> =>
      options.claim ?? {
        status: "claimed",
        token: "lease",
        profileRevision: 1,
        origin: { latitude: 1, longitude: 2 },
      },
  );
  const complete = vi.fn(async () =>
    options.completed === undefined ? discoveryState : options.completed,
  );
  const discover = vi.fn(async () => ({ status: "empty" as const, places: [] as [] }));
  const discoveryRead = vi.fn(async () => discoveryState);
  const app = buildApp({
    logger: false,
    propertyNearbyDiscovery: {
      repository: { read: discoveryRead, claim, complete, async close() {} },
      apiKey: options.configured === false ? undefined : "test-only",
      discover,
    },
    propertyNearbyRepository: { read, save, async close() {} },
    auth: {
      verifier: createFakeVerifier(
        new Map([
          [
            "valid",
            {
              workosUserId: "user",
              workosOrgId: "org",
              sessionId: "session",
              expiresAt: Math.floor(Date.now() / 1000) + 3600,
            },
          ],
        ]),
      ),
      repository,
      propertyAccessRepository,
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return options.permissions ?? permissions;
        },
      },
    },
  });
  apps.push(app);
  return { app, read, save, claim, complete, discover, discoveryRead };
}

describe("protected nearby curation routes", () => {
  it.each(["GET", "PUT"] as const)(
    "denies missing/invalid auth for %s before repository access",
    async (method) => {
      const { app, read, save } = setup();
      for (const headers of [{}, { authorization: "Bearer invalid" }]) {
        const response = await app.inject({
          method,
          url: path,
          headers,
          ...(method === "PUT" ? { payload } : {}),
        });
        expect(response.statusCode).toBe(401);
      }
      expect(read).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    },
  );
  it.each(["GET", "PUT"] as const)(
    "denies permission/link/member assignment failures for %s",
    async (method) => {
      for (const options of [
        { permissions: [] },
        { linked: false },
        { assigned: false },
        { suspended: true },
      ]) {
        const { app, read, save } = setup(options);
        const response = await app.inject({
          method,
          url: path,
          headers: { authorization: "Bearer valid" },
          ...(method === "PUT" ? { payload } : {}),
        });
        expect([401, 403]).toContain(response.statusCode);
        expect(read).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
      }
    },
  );
  it("requires publication permission to write, while shared setup has no paid entitlement gate", async () => {
    const denied = setup({
      permissions: ["hotel_catalog.setup.read", "hotel_catalog.setup.manage"],
    });
    expect(
      (
        await denied.app.inject({
          method: "PUT",
          url: path,
          headers: { authorization: "Bearer valid" },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect(denied.save).not.toHaveBeenCalled();
    const { app, read, save } = setup(); // no entitlement repository: catalog edits remain available
    for (const method of ["GET", "PUT"] as const) {
      const response = await app.inject({
        method,
        url: path,
        headers: { authorization: "Bearer valid" },
        ...(method === "PUT" ? { payload } : {}),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(state);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ organizationId, propertyId }));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId, organizationId, propertyId }),
      payload,
    );
  });
  it("maps conflicts and rejects invalid input and oversized raw bodies without saving", async () => {
    const { app, save } = setup({ saveResult: { ok: false, code: "revision_conflict" } });
    const inject = (body: unknown) =>
      app.inject({
        method: "PUT",
        url: path,
        headers: { authorization: "Bearer valid" },
        payload: body as object,
      });
    expect((await inject(payload)).statusCode).toBe(409);
    save.mockClear();
    expect((await inject({ ...payload, propertyId: "other" })).statusCode).toBe(400);
    expect((await inject({ ...payload, padding: "x".repeat(66000) })).statusCode).toBe(413);
    expect(save).not.toHaveBeenCalled();
  });
  it("rejects cross-property URLs and honors links revoked after policy resolution", async () => {
    const { app, read, save } = setup({
      saveResult: { ok: false, code: "missing_property_resource_link" },
    });
    const response = await app.inject({
      method: "GET",
      url: path.replace(propertyId, actorUserId),
      headers: { authorization: "Bearer valid" },
    });
    expect(response.statusCode).toBe(403);
    expect(read).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: "PUT",
          url: path,
          headers: { authorization: "Bearer valid" },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect(save).toHaveBeenCalledOnce();
  });
});

const refreshPath = path.replace("/curation", "/refresh");
const headers = { authorization: "Bearer valid" };
const refreshBody = { expectedProfileRevision: 1 };
describe("protected nearby discovery routes", () => {
  it("denies auth, link, assignment, membership and permission failures before discovery", async () => {
    for (const options of [
      { permissions: [] },
      { linked: false },
      { assigned: false },
      { suspended: true },
    ]) {
      const { app, claim, discoveryRead, discover } = setup(options);
      for (const method of ["GET", "POST"] as const) {
        const response = await app.inject({
          method,
          url: method === "GET" ? path.replace("/curation", "") : refreshPath,
          headers,
          ...(method === "POST" ? { payload: refreshBody } : {}),
        });
        expect([401, 403]).toContain(response.statusCode);
      }
      expect(claim).not.toHaveBeenCalled();
      expect(discoveryRead).not.toHaveBeenCalled();
      expect(discover).not.toHaveBeenCalled();
    }
    for (const authorization of [undefined, "Bearer invalid"]) {
      const { app, claim } = setup();
      expect(
        (
          await app.inject({
            method: "POST",
            url: refreshPath,
            headers: authorization ? { authorization } : {},
            payload: refreshBody,
          })
        ).statusCode,
      ).toBe(401);
      expect(claim).not.toHaveBeenCalled();
    }
    const denied = setup({ permissions: ["hotel_catalog.setup.manage"] });
    expect(
      (await denied.app.inject({ method: "POST", url: refreshPath, headers, payload: refreshBody }))
        .statusCode,
    ).toBe(403);
    expect(denied.claim).not.toHaveBeenCalled();
  });
  it("rejects missing configuration and caller-controlled search inputs without claiming", async () => {
    const disabled = setup({ configured: false });
    expect(
      (
        await disabled.app.inject({
          method: "POST",
          url: refreshPath,
          headers,
          payload: refreshBody,
        })
      ).statusCode,
    ).toBe(503);
    expect(disabled.claim).not.toHaveBeenCalled();
    const { app, claim } = setup();
    for (const payload of [
      {},
      { expectedProfileRevision: 0 },
      { ...refreshBody, force: "true" },
      { ...refreshBody, origin: { latitude: 0, longitude: 0 } },
    ])
      expect(
        (await app.inject({ method: "POST", url: refreshPath, headers, payload })).statusCode,
      ).toBe(400);
    expect(claim).not.toHaveBeenCalled();
  });
  it("returns cached/leased states and cooldown/conflict/link errors without provider calls", async () => {
    for (const [claim, status] of [
      [{ status: "cooldown", retryAfter: new Date(Date.now() + 60000).toISOString() }, 429],
      [{ status: "revision_conflict" }, 409],
      [{ status: "missing_property_resource_link" }, 403],
      [
        {
          status: "state",
          state: {
            schemaVersion: 1,
            profileRevision: 1,
            status: "refreshing",
            places: [],
            retryAfter: null,
          },
        },
        202,
      ],
      [
        {
          status: "state",
          state: {
            schemaVersion: 1,
            profileRevision: 1,
            status: "empty",
            places: [],
            retryAfter: null,
          },
        },
        200,
      ],
    ] as const) {
      const { app, discover } = setup({ claim: claim as NearbyClaim });
      const response = await app.inject({
        method: "POST",
        url: refreshPath,
        headers,
        payload: refreshBody,
      });
      expect(response.statusCode).toBe(status);
      if (status === 429) expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
      expect(discover).not.toHaveBeenCalled();
    }
  });
  it("uses only the claimed origin and returns the completed ID snapshot", async () => {
    const { app, claim, complete, discover } = setup();
    const response = await app.inject({
      method: "POST",
      url: refreshPath,
      headers,
      payload: { ...refreshBody, force: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().places).toEqual([{ placeId: "beach", category: "nature" }]);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(claim).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId, propertyId }),
      1,
      true,
    );
    expect(discover).toHaveBeenCalledWith({
      origin: { latitude: 1, longitude: 2 },
      apiKey: "test-only",
    });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ propertyId }), "lease", 1, {
      status: "empty",
      places: [],
    });
    expect(
      (await app.inject({ method: "GET", url: path.replace("/curation", ""), headers })).statusCode,
    ).toBe(200);
  });
  it("maps completion failures, stale revisions and revoked links without leaking provider errors", async () => {
    for (const [completed, status] of [
      [null, 403],
      [
        { schemaVersion: 1, profileRevision: 2, status: "stale", places: [], retryAfter: null },
        409,
      ],
      [
        { schemaVersion: 1, profileRevision: 1, status: "timeout", places: [], retryAfter: null },
        503,
      ],
      [
        {
          schemaVersion: 1,
          profileRevision: 1,
          status: "quota_exhausted",
          places: [],
          retryAfter: new Date(Date.now() + 60000).toISOString(),
        },
        429,
      ],
    ] as const) {
      const { app } = setup({ completed: completed as NearbyDiscoveryState | null });
      const response = await app.inject({
        method: "POST",
        url: refreshPath,
        headers,
        payload: refreshBody,
      });
      expect(response.statusCode).toBe(status);
      expect(response.body).not.toContain("test-only");
    }
  });
});
