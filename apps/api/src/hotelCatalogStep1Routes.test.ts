import type {
  LinkedResource,
  PermissionKey,
  ProductEntitlement,
  RequestContext,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import type {
  HotelCatalogStep1ReadModel,
  PropertyMediaAssignment,
  SaveHotelCatalogStep1Request,
  SaveHotelCatalogStep1Result,
} from "@vayada/domain-hotels";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import type {
  HotelCatalogStep1Repository,
  HotelCatalogStep1State,
  PrepareHotelCatalogStep1Result,
  SaveHotelCatalogStep1Command,
} from "./domains/hotelCatalogStep1Repository.js";
import type { PropertyMediaCommandRepository } from "./domains/propertyMediaCommandRepository.js";

const propertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherPropertyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const organizationId = "11111111-1111-4111-8111-111111111111";
const actorUserId = "22222222-2222-4222-8222-222222222222";
const coverId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const galleryId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const summary =
  "A welcoming independent hotel with calm rooms, thoughtful service, and an easy walk to local highlights.";

type Product = "marketplace" | "booking" | "pms";
type AccessOptions = {
  kind?: "hotel_group" | "creator_workspace";
  permissions?: PermissionKey[];
  entitlements?: ProductEntitlement[];
  links?: LinkedResource[];
};

describe("Hotel Catalog canonical Step 1 routes", () => {
  let app: ReturnType<typeof buildApp> | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("reads the exact current-owner profile model", async () => {
    const repository = fakeRepository();
    app = testApp(repository);

    const response = await injectJson<HotelCatalogStep1ReadModel>(app, {
      method: "GET",
      url: stepUrl(),
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual(readModel());
    expect(repository.getState).toHaveBeenCalledWith({ organizationId, propertyId, actorUserId });
  });

  it("derives public-safe assignments and chains the exact VAY-1047 revision", async () => {
    const repository = fakeRepository({
      state: state({ assignments: [] }),
      saveResult: success(10),
    });
    const replacePresentation = vi.fn(async () => ({
      ok: true as const,
      response: {
        outcome: "updated" as const,
        profileRevision: 9,
        logoAssignment: null,
        presentationAssignments: desiredAssignments(),
      },
    }));
    app = testApp(repository, {}, replacePresentation);

    const response = await put(app, request());

    expect(response.statusCode).toBe(200);
    expect(replacePresentation).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId,
        propertyId,
        actorUserId,
        expectedProfileRevision: 7,
        idempotencyKey: expect.stringMatching(/^hotel-catalog-step1-media:[a-f0-9]{64}$/),
        assignments: desiredAssignments(),
      }),
    );
    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        propertyId,
        idempotencyKey: "step1-command",
        claimToken: "step1-claim",
        writeProfileRevision: 9,
        request: request(),
      }),
    );
  });

  it("skips the media command when canonical role, order, and alt text already match", async () => {
    const repository = fakeRepository({ state: state({ assignments: desiredAssignments() }) });
    const replacePresentation = vi.fn();
    app = testApp(repository, {}, replacePresentation);

    const response = await put(app, request({ media: mediaSelection() }));

    expect(response.statusCode).toBe(200);
    expect(replacePresentation).not.toHaveBeenCalled();
    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({ writeProfileRevision: 7 }),
    );
  });

  it("replays the inner media command for a recovered media-required intent", async () => {
    const recoveredState = state({ assignments: desiredAssignments() });
    const repository = fakeRepository({
      prepareResult: {
        kind: "prepared",
        claimToken: "recovered-claim",
        mediaRequired: true,
        state: recoveredState,
      },
    });
    const replacePresentation = vi.fn(async () => ({
      ok: true as const,
      response: {
        outcome: "idempotent_replay" as const,
        profileRevision: 8,
        logoAssignment: null,
        presentationAssignments: desiredAssignments(),
      },
    }));
    app = testApp(repository, {}, replacePresentation);

    const response = await put(app, request());

    expect(response.statusCode).toBe(200);
    expect(replacePresentation).toHaveBeenCalledOnce();
    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({ claimToken: "recovered-claim", writeProfileRevision: 8 }),
    );
  });

  it("surfaces a content CAS conflict after the separately committed media handoff", async () => {
    const repository = fakeRepository({
      state: state({ assignments: [] }),
      saveResult: {
        ok: false,
        error: { code: "profile_revision_conflict", currentRevision: 9 },
      },
    });
    const replacePresentation = vi.fn(async () => ({
      ok: true as const,
      response: {
        outcome: "updated" as const,
        profileRevision: 8,
        logoAssignment: null,
        presentationAssignments: desiredAssignments(),
      },
    }));
    app = testApp(repository, {}, replacePresentation);

    const response = await put(app, request());

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({ code: "profile_revision_conflict", currentRevision: 9 });
    expect(replacePresentation).toHaveBeenCalledOnce();
    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({ writeProfileRevision: 8 }),
    );
  });

  it("replays the outer command before reading state or calling media", async () => {
    const repository = fakeRepository({
      prepareResult: { kind: "result", result: success(8, "idempotent_replay") },
    });
    const replacePresentation = vi.fn();
    app = testApp(repository, {}, replacePresentation);

    const response = await put(app, request());

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ outcome: "idempotent_replay", profileRevision: 8 });
    expect(repository.getState).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
    expect(replacePresentation).not.toHaveBeenCalled();
  });

  it("records a stale revision during outer preparation without touching media", async () => {
    const conflict: SaveHotelCatalogStep1Result = {
      ok: false,
      error: { code: "profile_revision_conflict", currentRevision: 7 },
    };
    const repository = fakeRepository({
      prepareResult: { kind: "result", result: conflict },
    });
    const replacePresentation = vi.fn();
    app = testApp(repository, {}, replacePresentation);

    const response = await put(app, request({ expectedProfileRevision: 6 }));

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual(conflict.error);
    expect(replacePresentation).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
  });

  it.each([
    ["missing authentication", null, {}, 401],
    ["wrong organization kind", "valid-token", { kind: "creator_workspace" }, 403],
    ["missing permission", "valid-token", { permissions: [] as PermissionKey[] }, 403],
    ["missing Catalog link", "valid-token", { links: [productLink("pms")] }, 403],
    [
      "disallowed Catalog relationship",
      "valid-token",
      { links: [catalogLink({ relationship: "front_desk" }), productLink("pms")] },
      403,
    ],
    [
      "inactive Catalog link",
      "valid-token",
      { links: [catalogLink({ status: "suspended" }), productLink("pms")] },
      403,
    ],
    ["missing product entitlement", "valid-token", { entitlements: [] }, 403],
    [
      "suspended product entitlement",
      "valid-token",
      { entitlements: [entitlement("pms", "suspended")] },
      403,
    ],
    ["missing product resource link", "valid-token", { links: [catalogLink()] }, 403],
    [
      "suspended product resource link",
      "valid-token",
      { links: [catalogLink(), productLink("pms", { status: "suspended" })] },
      403,
    ],
    [
      "product access for another property",
      "valid-token",
      {
        entitlements: [entitlement("pms", "active", otherPropertyId)],
        links: [catalogLink(), productLink("pms", {}, otherPropertyId)],
      },
      403,
    ],
  ] as Array<[string, string | null, AccessOptions, number]>)(
    "denies %s before malformed JSON is parsed",
    async (_name, token, access, status) => {
      const repository = fakeRepository();
      const replacePresentation = vi.fn();
      app = testApp(repository, access, replacePresentation);

      const response = await app.inject({
        method: "PUT",
        url: stepUrl(),
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "content-type": "application/json",
          "idempotency-key": "denied-command",
        },
        payload: "{ malformed",
      });

      expect(response.statusCode).toBe(status);
      expect(repository.prepare).not.toHaveBeenCalled();
      expect(replacePresentation).not.toHaveBeenCalled();
    },
  );

  it.each(["marketplace", "booking"] as const)(
    "accepts complete %s product access",
    async (product) => {
      const repository = fakeRepository({ state: state({ assignments: desiredAssignments() }) });
      app = testApp(repository, {
        entitlements: [entitlement(product)],
        links: [catalogLink(), productLink(product)],
      });

      const response = await put(app, request());

      expect(response.statusCode).toBe(200);
      expect(repository.prepare).toHaveBeenCalledOnce();
    },
  );

  it("rejects partial canonical input and a missing idempotency key", async () => {
    const repository = fakeRepository();
    app = testApp(repository);

    const partial = await put(app, {
      ...request(),
      amenities: { reviewed: false, keys: [] } as never,
    });
    const missingKey = await put(app, request(), null);

    expect(partial.statusCode).toBe(422);
    expect(missingKey.statusCode).toBe(422);
    expect(repository.prepare).not.toHaveBeenCalled();
  });

  it("maps typed media failures without attempting the content transaction", async () => {
    const repository = fakeRepository({ state: state({ assignments: [] }) });
    const replacePresentation = vi.fn(async () => ({
      ok: false as const,
      error: { code: "media_not_ready" as const, mediaObjectIds: [coverId] },
    }));
    app = testApp(repository, {}, replacePresentation);

    const response = await put(app, request());

    expect(response.statusCode).toBe(422);
    expect(response.body).toEqual({ code: "media_not_ready", mediaObjectIds: [coverId] });
    expect(repository.save).not.toHaveBeenCalled();
    expect(repository.completeFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        claimToken: "step1-claim",
        error: { code: "media_not_ready", mediaObjectIds: [coverId] },
      }),
    );
  });
});

function testApp(
  repository: HotelCatalogStep1Repository,
  access: AccessOptions = {},
  replacePresentation: Pick<
    PropertyMediaCommandRepository,
    "replacePresentation"
  >["replacePresentation"] = vi.fn(),
) {
  const app = buildApp({
    logger: false,
    hotelCatalogStep1: { repository, mediaCommands: { replacePresentation } },
  });
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization !== "Bearer valid-token") return;
    request.authContext = {
      actor: { internalUserId: actorUserId },
      selectedOrganization: { organizationId, kind: access.kind ?? "hotel_group" },
      membership: {
        permissions: access.permissions ?? ["hotel_catalog.setup.manage"],
      },
      linkedResources: access.links ?? [catalogLink(), productLink("pms")],
      entitlements: access.entitlements ?? [entitlement("pms")],
      audit: {
        requestId: "request-step1",
        correlationId: "correlation-step1",
        source: "api",
        receivedAt: "2026-08-02T10:00:00.000Z",
      },
    } as RequestContext;
  });
  return app;
}

function fakeRepository(
  options: {
    state?: HotelCatalogStep1State | null;
    prepareResult?: PrepareHotelCatalogStep1Result;
    saveResult?: SaveHotelCatalogStep1Result;
  } = {},
): HotelCatalogStep1Repository & {
  getState: ReturnType<typeof vi.fn<HotelCatalogStep1Repository["getState"]>>;
  prepare: ReturnType<typeof vi.fn<HotelCatalogStep1Repository["prepare"]>>;
  save: ReturnType<typeof vi.fn<HotelCatalogStep1Repository["save"]>>;
  completeFailure: ReturnType<typeof vi.fn<HotelCatalogStep1Repository["completeFailure"]>>;
} {
  const preparedState = options.state === undefined ? state() : options.state;
  return {
    getState: vi.fn(async () => (options.state === undefined ? state() : options.state)),
    prepare: vi.fn(
      async () =>
        options.prepareResult ??
        (preparedState
          ? {
              kind: "prepared" as const,
              claimToken: "step1-claim",
              mediaRequired: !sameTestAssignments(
                preparedState.presentationAssignments,
                desiredAssignments(),
              ),
              state: preparedState,
            }
          : { kind: "result" as const, result: propertyNotFoundResult() }),
    ),
    save: vi.fn(async (_command: SaveHotelCatalogStep1Command) => options.saveResult ?? success(8)),
    completeFailure: vi.fn(async (command) => ({ ok: false as const, error: command.error })),
    async close() {},
  };
}

function propertyNotFoundResult(): SaveHotelCatalogStep1Result {
  return { ok: false, error: { code: "property_not_found" } };
}

function sameTestAssignments(
  left: readonly (PropertyMediaAssignment & { role: "cover" | "gallery" })[],
  right: readonly (PropertyMediaAssignment & { role: "cover" | "gallery" })[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function request(patch: Partial<SaveHotelCatalogStep1Request> = {}): SaveHotelCatalogStep1Request {
  return {
    expectedProfileRevision: 7,
    locale: "en",
    shortDescription: summary,
    amenities: { reviewed: true, keys: [] },
    media: mediaSelection(),
    ...patch,
  };
}

function mediaSelection() {
  return { coverMediaObjectId: coverId, galleryMediaObjectIds: [galleryId] };
}

function desiredAssignments(): (PropertyMediaAssignment & { role: "cover" | "gallery" })[] {
  return [
    {
      mediaObjectId: coverId,
      role: "cover",
      altText: "Cover photo of Hotel Alpenrose",
      sortOrder: 0,
    },
    {
      mediaObjectId: galleryId,
      role: "gallery",
      altText: "Hotel Alpenrose gallery photo 1",
      sortOrder: 1,
    },
  ];
}

function state(
  options: {
    assignments?: readonly (PropertyMediaAssignment & { role: "cover" | "gallery" })[];
  } = {},
): HotelCatalogStep1State {
  return { readModel: readModel(), presentationAssignments: options.assignments ?? [] };
}

function readModel(revision = 7): HotelCatalogStep1ReadModel {
  return {
    contractVersion: "hotel-catalog-step1.v1",
    propertyId,
    displayName: "Hotel Alpenrose",
    profileRevision: revision,
    supportedLocales: ["en"],
    profile: {
      locale: "en",
      shortDescription: summary,
      publicSlug: "hotel-alpenrose",
      amenities: { reviewed: false, keys: [] },
      media: { coverMediaObjectId: null, galleryMediaObjectIds: [] },
    },
    baseRevisions: {
      "hotel_catalog.profile": `profile:${revision}`,
      "hotel_catalog.media": `profile:${revision}`,
      "hotel_catalog.amenities": `profile:${revision}`,
    },
  };
}

function success(
  revision: number,
  outcome: "updated" | "idempotent_replay" = "updated",
): SaveHotelCatalogStep1Result {
  return { ok: true, response: { ...readModel(revision), outcome } };
}

async function put(
  app: ReturnType<typeof buildApp>,
  body: Record<string, unknown> | SaveHotelCatalogStep1Request,
  key: string | null = "step1-command",
) {
  return injectJson<Record<string, unknown>>(app, {
    method: "PUT",
    url: stepUrl(),
    headers: {
      authorization: "Bearer valid-token",
      ...(key ? { "idempotency-key": key } : {}),
    },
    payload: body,
  });
}

function stepUrl() {
  return `/api/hotel-setup/properties/${propertyId}/steps/present-hotel`;
}

function entitlement(
  product: Product,
  status: ProductEntitlement["status"] = "active",
  resourceId = propertyId,
): ProductEntitlement {
  const access = productAccess(product);
  return {
    product,
    key: access.key,
    status,
    resource: { product, resourceType: access.resourceType, resourceId },
  };
}

function catalogLink(overrides: Partial<LinkedResource> = {}): LinkedResource {
  return {
    product: "hotel_catalog",
    resourceType: "property",
    resourceId: propertyId,
    relationship: "owner",
    status: "active",
    ...overrides,
  };
}

function productLink(
  product: Product,
  overrides: Partial<LinkedResource> = {},
  resourceId = propertyId,
): LinkedResource {
  return {
    product,
    resourceType: productAccess(product).resourceType,
    resourceId,
    relationship: "operator",
    status: "active",
    ...overrides,
  };
}

function productAccess(product: Product) {
  const access = {
    marketplace: { key: "marketplace-hotel-profile", resourceType: "hotel_profile" },
    booking: { key: "booking-engine", resourceType: "booking_hotel" },
    pms: { key: "property-management", resourceType: "pms_property" },
  } as const;
  return access[product];
}
