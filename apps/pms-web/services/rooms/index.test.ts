import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertEnabled: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  uploadImages: vi.fn(),
  resolvePropertyId: vi.fn(),
}));

vi.mock("../api/pmsOperationsClient", () => ({
  assertPmsOperationsReadModelEnabled: mocks.assertEnabled,
  pmsOperationsClient: {
    get: mocks.get,
    post: mocks.post,
    put: mocks.put,
    patch: mocks.patch,
  },
  pmsOperationsRequestOptions: { headers: { "X-Vayada-Omit-Hotel-Context": "true" } },
}));

vi.mock("../upload", () => ({
  imageReferenceUrl: (image: string | { url?: string | null }) =>
    typeof image === "string" ? image : (image.url ?? ""),
  pmsRoomMediaResource: (propertyId: string, roomTypeId?: string) => ({
    product: "hotel_catalog",
    resourceType: "property",
    resourceId: propertyId,
    propertyId,
    ...(roomTypeId ? { targetResourceId: roomTypeId } : {}),
  }),
  uploadService: { uploadImages: mocks.uploadImages },
}));

vi.mock("../api/pmsPropertyClient", () => ({
  resolveSelectedPmsPropertyId: mocks.resolvePropertyId,
}));

vi.mock("../api/unsupported", () => ({
  unsupportedPmsNextStackFeature: vi.fn((feature: string) =>
    Promise.reject(new Error(`${feature} is not available on PMS next-stack yet.`)),
  ),
}));

import { roomsService } from ".";

function pmsRoomTypeItem(overrides: Record<string, unknown> = {}) {
  return {
    roomTypeId: "room-type-1",
    name: "Alpine Suite",
    description: "Suite",
    category: "suite",
    occupancyLimits: { total: 2 },
    attributes: {},
    amenities: [],
    media: [],
    roomMediaRevision: 3,
    baseRate: { amountDecimal: "180.00", currency: "EUR" },
    active: true,
    sortOrder: 1,
    ratePlans: [],
    rateRulesSummary: {
      minStayNights: null,
      maxStayNights: null,
      closedToArrival: false,
      closedToDeparture: false,
      activeRuleCount: 0,
    },
    roomCount: 2,
    ...overrides,
  };
}

describe("roomsService.update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePropertyId.mockResolvedValue("pms-property-1");
    mocks.patch.mockResolvedValue({
      contractVersion: "pms-operations.v1",
      propertyId: "pms-property-1",
      item: pmsRoomTypeItem({
        description: "Suite with mountain view.",
        occupancyLimits: { adults: 2, total: 2 },
        attributes: {
          locationAddress: "Seestrasse 12, Innsbruck",
          latitude: 47.2692,
          longitude: 11.4041,
        },
      }),
      commandMeta: {
        contractVersion: "pms-operations.v1",
        commandId: "cmd",
        idempotencyKey: "cmd",
        acceptedAt: "2026-08-14T17:45:00.000Z",
        sideEffects: ["audit_event"],
      },
    });
  });

  it("patches only room-type location fields through PMS operations", async () => {
    const roomType = await roomsService.update("room-type-1", {
      name: "Ignored by location update",
      locationAddress: "Seestrasse 12, Innsbruck",
      latitude: 47.2692,
      longitude: 11.4041,
    });

    expect(mocks.patch).toHaveBeenCalledWith(
      "/api/pms/properties/pms-property-1/room-types/room-type-1",
      expect.objectContaining({
        locationAddress: "Seestrasse 12, Innsbruck",
        latitude: 47.2692,
        longitude: 11.4041,
        commandId: expect.stringMatching(/^pms-room-type-update-/),
        idempotencyKey: expect.stringMatching(/^pms-room-type-update-/),
      }),
      { headers: { "X-Vayada-Omit-Hotel-Context": "true" } },
    );
    expect(mocks.patch.mock.calls[0]![1]).not.toHaveProperty("name");
    expect(roomType).toMatchObject({
      id: "room-type-1",
      locationAddress: "Seestrasse 12, Innsbruck",
      latitude: 47.2692,
      longitude: 11.4041,
    });
  });

  it("keeps the existing gate when PMS operations writes are disabled", async () => {
    mocks.assertEnabled.mockImplementationOnce(() => {
      throw new Error("PMS operations disabled");
    });

    await expect(roomsService.update("room-type-1", { latitude: 47.2692 })).rejects.toThrow(
      "PMS operations disabled",
    );
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("persists changed room media through the revisioned assignment endpoint", async () => {
    const currentItem = pmsRoomTypeItem({
      media: [
        {
          mediaObjectId: "11111111-1111-4111-8111-111111111111",
          url: "https://cdn.example.com/old.webp",
        },
      ],
    });
    mocks.patch.mockResolvedValueOnce({
      contractVersion: "pms-operations.v1",
      propertyId: "pms-property-1",
      item: currentItem,
    });
    mocks.put.mockResolvedValue({
      propertyId: "pms-property-1",
      roomTypeId: "room-type-1",
      roomMediaRevision: 4,
    });
    mocks.get.mockResolvedValue({
      propertyId: "pms-property-1",
      item: {
        ...currentItem,
        media: [
          {
            mediaObjectId: "22222222-2222-4222-8222-222222222222",
            url: "https://cdn.example.com/new.webp",
          },
        ],
        roomMediaRevision: 4,
      },
    });

    const updated = await roomsService.update("room-type-1", {
      images: [
        {
          url: "https://cdn.example.com/new.webp",
          platformMediaObjectId: "22222222-2222-4222-8222-222222222222",
        },
      ],
    });

    expect(mocks.put).toHaveBeenCalledWith(
      "/api/pms/properties/pms-property-1/room-types/room-type-1/media",
      {
        expectedRoomMediaRevision: 3,
        assignments: [
          {
            mediaObjectId: "22222222-2222-4222-8222-222222222222",
            altText: null,
            sortOrder: 0,
          },
        ],
      },
      expect.objectContaining({
        headers: expect.objectContaining({ "Idempotency-Key": expect.any(String) }),
      }),
    );
    expect(updated.images[0]).toMatchObject({
      platformMediaObjectId: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("persists reordering and removal for URL-only legacy room photos", async () => {
    const currentItem = pmsRoomTypeItem({
      media: [
        { url: "https://legacy.example.com/first.webp" },
        { url: "https://legacy.example.com/second.webp" },
      ],
    });
    mocks.patch.mockResolvedValueOnce({
      contractVersion: "pms-operations.v1",
      propertyId: "pms-property-1",
      item: currentItem,
    });
    mocks.put.mockResolvedValue({ roomMediaRevision: 4 });
    mocks.get.mockResolvedValue({
      propertyId: "pms-property-1",
      item: {
        ...currentItem,
        media: [{ url: "https://legacy.example.com/second.webp" }],
        roomMediaRevision: 4,
      },
    });

    await roomsService.update("room-type-1", {
      images: [{ url: "https://legacy.example.com/second.webp" }],
    });

    expect(mocks.put).toHaveBeenCalledWith(
      "/api/pms/properties/pms-property-1/room-types/room-type-1/media",
      {
        expectedRoomMediaRevision: 3,
        assignments: [],
        legacyMediaSnapshot: [
          {
            mediaObjectId: null,
            url: "https://legacy.example.com/second.webp",
            altText: null,
            sortOrder: 0,
          },
        ],
      },
      expect.any(Object),
    );
  });

  it("preserves legacy photos while adding validated Platform Media", async () => {
    const currentItem = pmsRoomTypeItem({
      media: [{ url: "https://legacy.example.com/first.webp" }],
    });
    mocks.patch.mockResolvedValueOnce({
      contractVersion: "pms-operations.v1",
      propertyId: "pms-property-1",
      item: currentItem,
    });
    mocks.put.mockResolvedValue({ roomMediaRevision: 4 });
    mocks.get.mockResolvedValue({
      propertyId: "pms-property-1",
      item: {
        ...currentItem,
        media: [
          { url: "https://legacy.example.com/first.webp" },
          {
            mediaObjectId: "22222222-2222-4222-8222-222222222222",
            url: "https://cdn.example.com/new.webp",
          },
        ],
        roomMediaRevision: 4,
      },
    });

    await roomsService.update("room-type-1", {
      images: [
        { url: "https://legacy.example.com/first.webp" },
        {
          url: "https://cdn.example.com/new.webp",
          platformMediaObjectId: "22222222-2222-4222-8222-222222222222",
        },
      ],
    });

    expect(mocks.put.mock.calls[0]?.[1]).toEqual({
      expectedRoomMediaRevision: 3,
      assignments: [
        {
          mediaObjectId: "22222222-2222-4222-8222-222222222222",
          altText: null,
          sortOrder: 0,
        },
      ],
      legacyMediaSnapshot: [
        {
          mediaObjectId: null,
          url: "https://legacy.example.com/first.webp",
          altText: null,
          sortOrder: 0,
        },
        {
          mediaObjectId: "22222222-2222-4222-8222-222222222222",
          url: "https://cdn.example.com/new.webp",
          altText: null,
          sortOrder: 1,
        },
      ],
    });
  });
});

describe("roomsService.getPropertyPlan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePropertyId.mockResolvedValue("pms-property-1");
    mocks.get.mockResolvedValue({
      contractVersion: "pms-operations.v1",
      propertyId: "pms-property-1",
      propertyPlan: {
        propertyId: "pms-property-1",
        plan: "commission",
        limits: {
          maxRoomPhotosPerType: 10,
          maxAddons: 3,
          guestContactAccess: "after_acceptance",
        },
      },
    });
  });

  it("reads centralized plan limits for the selected property", async () => {
    await expect(roomsService.getPropertyPlan()).resolves.toMatchObject({
      plan: "commission",
      limits: { maxRoomPhotosPerType: 10 },
    });
    expect(mocks.get).toHaveBeenCalledWith("/api/pms/properties/pms-property-1/plan-limits", {
      headers: { "X-Vayada-Omit-Hotel-Context": "true" },
    });
  });
});

describe("roomsService.create", () => {
  it("uploads staged files only after receiving the canonical room UUID", async () => {
    vi.clearAllMocks();
    mocks.resolvePropertyId.mockResolvedValue("pms-property-1");
    const item = pmsRoomTypeItem({
      roomMediaRevision: 1,
    });
    mocks.post.mockResolvedValue({ propertyId: "pms-property-1", item });
    mocks.uploadImages.mockResolvedValue({
      images: [
        {
          platformMediaObjectId: "22222222-2222-4222-8222-222222222222",
          url: "https://cdn.example.com/new.webp",
        },
      ],
      total: 1,
    });
    mocks.put.mockResolvedValue({ roomMediaRevision: 2 });
    mocks.get.mockResolvedValue({
      propertyId: "pms-property-1",
      item: {
        ...item,
        roomMediaRevision: 2,
        media: [
          {
            mediaObjectId: "22222222-2222-4222-8222-222222222222",
            url: "https://cdn.example.com/new.webp",
          },
        ],
      },
    });
    const file = new File([new Uint8Array([1])], "room.jpg", { type: "image/jpeg" });

    await roomsService.create({
      name: "Alpine Suite",
      images: [{ url: "blob:room-preview", pendingFile: file }],
    });

    expect(mocks.post.mock.calls[0]?.[1]).toMatchObject({ images: [] });
    expect(mocks.uploadImages).toHaveBeenCalledWith([file], {
      product: "hotel_catalog",
      resourceType: "property",
      resourceId: "pms-property-1",
      propertyId: "pms-property-1",
      targetResourceId: "room-type-1",
    });
    expect(mocks.put).toHaveBeenCalledWith(
      "/api/pms/properties/pms-property-1/room-types/room-type-1/media",
      expect.objectContaining({ expectedRoomMediaRevision: 1 }),
      expect.any(Object),
    );
  });
});
