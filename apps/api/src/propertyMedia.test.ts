import {
  createFakeVerifier,
  type IdentityRepository,
  type LinkedResource,
  type PermissionKey,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import type {
  PropertyMediaCommandError,
  PropertyMediaCommandResponse,
} from "@vayada/domain-hotels";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { agencyPropertyAccessRepository } from "./testAuthorization.js";
import type { PropertyMediaCommandRepository } from "./domains/propertyMediaCommandRepository.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const mediaId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const session: VerifiedSession = {
  workosUserId: "workos_property_owner",
  workosOrgId: "workos_hotel_group",
  sessionId: "property-media-session",
  expiresAt: Math.floor(Date.now() / 1000) + 3_600,
};

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("property media assignment routes", () => {
  it("assigns a logo for an actively linked hotel owner", async () => {
    const assignLogo = vi.fn(async () => successResponse());
    const repository = commandRepository({ assignLogo });
    app = buildPropertyMediaApp({ repository });

    const response = await injectJson<PropertyMediaCommandResponse>(app, {
      method: "PUT",
      url: `/api/hotel-setup/properties/${propertyId}/media/logo`,
      headers: { authorization: "Bearer valid-token", "idempotency-key": "logo-command-1" },
      payload: {
        expectedProfileRevision: 1,
        assignment: { mediaObjectId: mediaId, role: "logo", altText: "Hotel logo", sortOrder: 0 },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual(successResponse().response);
    expect(assignLogo).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId,
        propertyId,
        actorUserId: "user_property_owner",
        idempotencyKey: "logo-command-1",
        expectedProfileRevision: 1,
        assignment: expect.objectContaining({ mediaObjectId: mediaId, role: "logo" }),
      }),
    );
  });

  it("allows an operator to reuse one asset as cover and gallery", async () => {
    const replacePresentation = vi.fn(async () => successResponse());
    const repository = commandRepository({ replacePresentation });
    app = buildPropertyMediaApp({
      repository,
      linkedResources: [propertyLink("operator", "active")],
    });

    const response = await injectJson(app, {
      method: "PUT",
      url: `/api/hotel-setup/properties/${propertyId}/media/presentation`,
      headers: { authorization: "Bearer valid-token", "idempotency-key": "presentation-1" },
      payload: {
        expectedProfileRevision: 1,
        assignments: [
          { mediaObjectId: mediaId, role: "cover", altText: null, sortOrder: 0 },
          { mediaObjectId: mediaId, role: "gallery", altText: "Lobby", sortOrder: 1 },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(replacePresentation).toHaveBeenCalledWith(
      expect.objectContaining({
        propertyId,
        assignments: [
          expect.objectContaining({ role: "cover", sortOrder: 0 }),
          expect.objectContaining({ role: "gallery", sortOrder: 1 }),
        ],
      }),
    );
  });

  it("normalizes an uppercase property UUID before resource authorization", async () => {
    const assignLogo = vi.fn(async () => successResponse());
    app = buildPropertyMediaApp({ repository: commandRepository({ assignLogo }) });

    const response = await injectJson(app, {
      method: "PUT",
      url: `/api/hotel-setup/properties/${propertyId.toUpperCase()}/media/logo`,
      headers: { authorization: "Bearer valid-token", "idempotency-key": "uppercase-property" },
      payload: { expectedProfileRevision: 1, assignment: null },
    });

    expect(response.statusCode).toBe(200);
    expect(assignLogo).toHaveBeenCalledWith(expect.objectContaining({ propertyId }));
  });

  it.each([
    {
      name: "missing authentication",
      authorization: undefined,
      permissions: ["hotel_catalog.setup.manage"] as PermissionKey[],
      links: [propertyLink("owner", "active")],
      kind: "hotel_group" as const,
      status: 401,
      code: "unauthenticated",
    },
    {
      name: "missing permission",
      authorization: "Bearer valid-token",
      permissions: [] as PermissionKey[],
      links: [propertyLink("owner", "active")],
      kind: "hotel_group" as const,
      status: 403,
      code: "missing_permission",
    },
    {
      name: "wrong organization kind",
      authorization: "Bearer valid-token",
      permissions: ["hotel_catalog.setup.manage"] as PermissionKey[],
      links: [propertyLink("owner", "active")],
      kind: "creator_workspace" as const,
      status: 403,
      code: "invalid_organization_scope",
    },
    {
      name: "missing resource link",
      authorization: "Bearer valid-token",
      permissions: ["hotel_catalog.setup.manage"] as PermissionKey[],
      links: [] as LinkedResource[],
      kind: "hotel_group" as const,
      status: 403,
      code: "missing_property_resource_link",
    },
    {
      name: "inactive resource link",
      authorization: "Bearer valid-token",
      permissions: ["hotel_catalog.setup.manage"] as PermissionKey[],
      links: [propertyLink("owner", "suspended")],
      kind: "hotel_group" as const,
      status: 403,
      code: "missing_property_resource_link",
    },
    {
      name: "disallowed relationship",
      authorization: "Bearer valid-token",
      permissions: ["hotel_catalog.setup.manage"] as PermissionKey[],
      links: [propertyLink("front_desk", "active")],
      kind: "hotel_group" as const,
      status: 403,
      code: "missing_property_resource_link",
    },
  ])("denies $name before malformed JSON is parsed", async (testCase) => {
    const assignLogo = vi.fn(async () => successResponse());
    app = buildPropertyMediaApp({
      repository: commandRepository({ assignLogo }),
      permissions: testCase.permissions,
      linkedResources: testCase.links,
      organizationKind: testCase.kind,
    });

    const response = await app.inject({
      method: "PUT",
      url: `/api/hotel-setup/properties/${propertyId}/media/logo`,
      headers: {
        ...(testCase.authorization ? { authorization: testCase.authorization } : {}),
        "content-type": "application/json",
        "idempotency-key": "denied-command",
      },
      payload: "{ malformed",
    });

    expect(response.statusCode).toBe(testCase.status);
    expect(response.json()).toMatchObject({ code: testCase.code });
    expect(assignLogo).not.toHaveBeenCalled();
  });

  it("rejects malformed assignments and missing idempotency keys without calling the repository", async () => {
    const assignLogo = vi.fn(async () => successResponse());
    app = buildPropertyMediaApp({ repository: commandRepository({ assignLogo }) });

    const malformed = await injectJson(app, {
      method: "PUT",
      url: `/api/hotel-setup/properties/${propertyId}/media/logo`,
      headers: { authorization: "Bearer valid-token", "idempotency-key": "malformed-1" },
      payload: { expectedProfileRevision: 1, assignment: { role: "logo" } },
    });
    const missingKey = await injectJson(app, {
      method: "PUT",
      url: `/api/hotel-setup/properties/${propertyId}/media/logo`,
      headers: { authorization: "Bearer valid-token" },
      payload: { expectedProfileRevision: 1, assignment: null },
    });

    expect(malformed.statusCode).toBe(422);
    expect(missingKey.statusCode).toBe(422);
    expect(assignLogo).not.toHaveBeenCalled();
  });

  it.each<[PropertyMediaCommandError, number]>([
    [{ code: "profile_revision_conflict", currentRevision: 2 }, 409],
    [{ code: "media_not_found", mediaObjectIds: [mediaId] }, 404],
    [{ code: "media_not_authorized", mediaObjectIds: [mediaId] }, 403],
    [{ code: "media_not_ready", mediaObjectIds: [mediaId] }, 422],
    [{ code: "media_publication_failed" }, 503],
  ])("maps command error %o to HTTP %i", async (error, status) => {
    app = buildPropertyMediaApp({
      repository: commandRepository({
        assignLogo: vi.fn(async () => ({ ok: false as const, error })),
      }),
    });

    const response = await injectJson(app, {
      method: "PUT",
      url: `/api/hotel-setup/properties/${propertyId}/media/logo`,
      headers: { authorization: "Bearer valid-token", "idempotency-key": "error-case" },
      payload: { expectedProfileRevision: 1, assignment: null },
    });

    expect(response.statusCode).toBe(status);
    expect(response.body).toEqual(error);
  });
});

function buildPropertyMediaApp(options: {
  repository: PropertyMediaCommandRepository;
  permissions?: PermissionKey[];
  linkedResources?: LinkedResource[];
  organizationKind?: "hotel_group" | "creator_workspace";
}): FastifyInstance {
  return buildApp({
    logger: false,
    propertyMediaCommandRepository: options.repository,
    auth: {
      verifier: createFakeVerifier(new Map([["valid-token", session]])),
      repository: identityRepository(options),
      propertyAccessRepository: agencyPropertyAccessRepository,
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return options.permissions ?? ["hotel_catalog.setup.manage"];
        },
      },
    },
  });
}

function commandRepository(
  overrides: Partial<PropertyMediaCommandRepository> = {},
): PropertyMediaCommandRepository {
  return {
    async assignLogo() {
      throw new Error("Unexpected logo assignment");
    },
    async replacePresentation() {
      throw new Error("Unexpected presentation replacement");
    },
    async replacePlatformAdminHero() {
      throw new Error("Unexpected Platform Admin hero replacement");
    },
    async runPublicationBatch() {
      return { processed: 0, deferred: 0, deadLettered: 0 };
    },
    async close() {},
    ...overrides,
  };
}

function identityRepository(options: {
  linkedResources?: LinkedResource[];
  organizationKind?: "hotel_group" | "creator_workspace";
}): IdentityRepository {
  return {
    async findUserByProviderUserId() {
      return { userId: "user_property_owner", email: "owner@example.com", status: "active" };
    },
    async findOrganizationByWorkosOrgId() {
      return {
        organizationId,
        workosOrgId: session.workosOrgId ?? null,
        kind: options.organizationKind ?? "hotel_group",
        status: "active",
      };
    },
    async findActiveMembership() {
      return {
        membershipId: "membership_property_owner",
        status: "active",
        roleKey: "hotel_owner",
        workosMembershipId: "membership_workos",
        workosRoleSlugs: ["hotel_owner"],
      };
    },
    async findLinkedResources() {
      return options.linkedResources ?? [propertyLink("owner", "active")];
    },
  };
}

function propertyLink(
  relationship: LinkedResource["relationship"],
  status: LinkedResource["status"],
): LinkedResource {
  return {
    product: "hotel_catalog",
    resourceType: "property",
    resourceId: propertyId,
    relationship,
    status,
  };
}

function successResponse() {
  return {
    ok: true as const,
    response: {
      outcome: "updated" as const,
      profileRevision: 2,
      logoAssignment: null,
      presentationAssignments: [],
    },
  };
}
