import {
  createFakeVerifier,
  type PermissionKey,
  type IdentityRepository,
} from "@vayada/backend-auth";
import type { PropertyAccessRepository } from "@vayada/backend-authorization";
import type { NearbyCurationState } from "@vayada/domain-hotels";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
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
  const app = buildApp({
    logger: false,
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
  return { app, read, save };
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
