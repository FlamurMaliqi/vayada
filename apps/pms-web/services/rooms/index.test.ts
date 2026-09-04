import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertEnabled: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
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
    delete: mocks.delete,
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

import { linkedInventoryGroupsService, roomsService, roomTypeUpdateForm } from ".";
import { ApiErrorResponse } from "../api/client";

function pmsRoomTypeItem(overrides: Record<string, unknown> = {}) {
  return {
    roomTypeId: "room-type-1",
    version: "room-type-facts-v3",
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

const canonicalAt = "2026-09-04T00:00:00.000Z";

function canonicalCancellationTerms() {
  return {
    type: "free_until_days_before_arrival",
    freeCancellationDeadlineDays: 7,
    afterDeadlinePenalty: "full_booking_amount",
    noShowPenalty: "full_booking_amount",
    text: "Free until 7 days before",
    flexibleCancellationType: "free",
    partialRefundCancelWindowDays: 30,
    partialRefundAmountPercent: 50,
    partialRefundTiers: [],
  };
}

function canonicalRoomFacts(propertyId: string, roomTypeId: string, roomFactsRevision = 1) {
  return {
    contractVersion: "pms-room-facts.v1",
    propertyId,
    roomTypeId,
    roomFactsRevision,
    lifecycle: "active",
    facts: {
      name: "Castrop Suite",
      description: "Suite",
      category: "suite",
      occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 0 },
      beds: [{ type: "queen", quantity: 1 }],
      bedrooms: 1,
      bathrooms: 1,
      bathroomType: "private",
      size: null,
    },
    createdAt: canonicalAt,
    updatedAt: canonicalAt,
  };
}

function canonicalPricingSource(propertyId: string, roomTypeId?: string, roomFactsRevision = 1) {
  return {
    contractVersion: "pms-pricing.v1",
    propertyId,
    pricingCurrency: {
      contractVersion: "pms-pricing.v1",
      propertyId,
      currency: "EUR",
      pricingCurrencyRevision: 1,
      createdAt: canonicalAt,
      updatedAt: canonicalAt,
    },
    flexibleRatePlans: roomTypeId
      ? [
          {
            contractVersion: "pms-pricing.v1",
            propertyId,
            roomTypeId,
            flexibleRatePlanId: "44444444-4444-4444-8444-444444444444",
            flexibleRatePlanRevision: 1,
            sourceRoomFactsRevision: roomFactsRevision,
            baseAmount: { amountDecimal: "180.00", currency: "EUR" },
            cancellationTerms: canonicalCancellationTerms(),
            createdAt: canonicalAt,
            updatedAt: canonicalAt,
          },
        ]
      : [],
    capturedAt: canonicalAt,
  };
}

function canonicalFlexiblePlanResponse(
  propertyId: string,
  roomTypeId: string,
  roomFactsRevision = 1,
) {
  return {
    contractVersion: "pms-pricing.v1",
    outcome: "created",
    flexibleRatePlan: canonicalPricingSource(propertyId, roomTypeId, roomFactsRevision)
      .flexibleRatePlans[0],
    acceptedAt: canonicalAt,
  };
}

describe("roomsService lifecycle commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePropertyId.mockResolvedValue("pms-property-1");
  });

  it("duplicates with the source version and reuses the command after an ambiguous failure", async () => {
    mocks.get.mockResolvedValue({
      propertyId: "pms-property-1",
      item: pmsRoomTypeItem(),
    });
    mocks.post.mockRejectedValueOnce(new Error("network interrupted")).mockResolvedValueOnce({
      propertyId: "pms-property-1",
      item: pmsRoomTypeItem({
        roomTypeId: "room-type-copy",
        version: "room-type-facts-v1",
        name: "Alpine Suite Copy",
        roomCount: 0,
      }),
    });

    await expect(roomsService.duplicate("room-type-1")).rejects.toThrow("network interrupted");
    const duplicated = await roomsService.duplicate("room-type-1");

    expect(duplicated).toMatchObject({
      id: "room-type-copy",
      version: "room-type-facts-v1",
      name: "Alpine Suite Copy",
      totalRooms: 0,
    });
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.post.mock.calls[0]![1]).toMatchObject({
      expectedVersion: "room-type-facts-v3",
      commandId: expect.stringMatching(/^pms-room-type-duplicate-/),
    });
    expect(mocks.post.mock.calls[1]![1]).toEqual(mocks.post.mock.calls[0]![1]);
  });

  it("preflights retirement and returns actionable blockers without dispatching delete", async () => {
    mocks.get.mockResolvedValue({
      contractVersion: "pms-room-type-lifecycle.v1",
      propertyId: "pms-property-1",
      roomTypeId: "room-type-1",
      version: "room-type-facts-v3",
      canRetire: false,
      blockers: [
        {
          category: "physical_units",
          code: "active_physical_units",
          affectedCount: 2,
          action: "Retire every active physical room unit.",
        },
      ],
    });

    await expect(roomsService.delete("room-type-1")).rejects.toThrow(
      "2 affected: Retire every active physical room unit.",
    );
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it("retires with the inspected version and a durable retry key", async () => {
    mocks.get.mockResolvedValue({
      contractVersion: "pms-room-type-lifecycle.v1",
      propertyId: "pms-property-1",
      roomTypeId: "room-type-1",
      version: "room-type-facts-v3",
      canRetire: true,
      blockers: [],
    });
    mocks.delete.mockResolvedValue({});

    await roomsService.delete("room-type-1");

    expect(mocks.delete).toHaveBeenCalledWith(
      "/api/pms/properties/pms-property-1/room-types/room-type-1",
      expect.objectContaining({
        body: expect.stringContaining('"expectedVersion":"room-type-facts-v3"'),
      }),
    );
    const payload = JSON.parse(mocks.delete.mock.calls[0]![1].body);
    expect(payload.commandId).toMatch(/^pms-room-type-retire-/);
    expect(payload.idempotencyKey).toBe(payload.commandId);
  });
});

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

  it("patches room-type location and cancellation fields through PMS operations", async () => {
    const roomType = await roomsService.update("room-type-1", {
      name: "Ignored by location update",
      locationAddress: "Seestrasse 12, Innsbruck",
      latitude: 47.2692,
      longitude: 11.4041,
      flexibleCancellationType: "partial_refund",
      partialRefundCancelWindowDays: 30,
      partialRefundAmountPercent: 50,
      partialRefundTiers: [
        { minDaysBeforeCheckIn: 30, refundPercent: 50 },
        { minDaysBeforeCheckIn: 7, refundPercent: 20 },
      ],
    });

    expect(mocks.patch).toHaveBeenCalledWith(
      "/api/pms/properties/pms-property-1/room-types/room-type-1",
      expect.objectContaining({
        locationAddress: "Seestrasse 12, Innsbruck",
        latitude: 47.2692,
        longitude: 11.4041,
        flexibleCancellationType: "partial_refund",
        partialRefundCancelWindowDays: 30,
        partialRefundAmountPercent: 50,
        partialRefundTiers: [
          { minDaysBeforeCheckIn: 30, refundPercent: 50 },
          { minDaysBeforeCheckIn: 7, refundPercent: 20 },
        ],
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

  it("persists partial-refund tiers through the canonical pricing owner", async () => {
    const partialPolicy = {
      type: "free_until_days_before_arrival",
      freeCancellationDeadlineDays: 7,
      afterDeadlinePenalty: "full_booking_amount",
      noShowPenalty: "full_booking_amount",
      flexibleCancellationType: "partial_refund",
      partialRefundTiers: [
        { minDaysBeforeCheckIn: 30, refundPercent: 50 },
        { minDaysBeforeCheckIn: 7, refundPercent: 20 },
      ],
    };
    mocks.patch
      .mockRejectedValueOnce(
        new Error("Flexible cancellation is unavailable for this room type's pricing contract."),
      )
      .mockResolvedValueOnce({});
    mocks.get
      .mockResolvedValueOnce({
        pricingCurrency: { pricingCurrencyRevision: 4 },
        flexibleRatePlans: [
          {
            roomTypeId: "room-type-1",
            flexibleRatePlanRevision: 6,
            sourceRoomFactsRevision: 3,
            baseAmount: { amountDecimal: "180.00", currency: "EUR" },
            cancellationTerms: {
              type: "free_until_days_before_arrival",
              freeCancellationDeadlineDays: 7,
              afterDeadlinePenalty: "full_booking_amount",
              noShowPenalty: "full_booking_amount",
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        propertyId: "pms-property-1",
        item: pmsRoomTypeItem({
          ratePlans: [
            {
              ratePlanId: "canonical-flex-1",
              pricingContractVersion: "pms-pricing.v1",
              code: "ONB15-FLEX",
              name: "Flexible",
              rateType: "flexible",
              mealPlan: null,
              baseRate: { amountDecimal: "180.00", currency: "EUR" },
              cancellationPolicySnapshot: partialPolicy,
              active: true,
            },
          ],
        }),
      });

    const updated = await roomsService.update("room-type-1", {
      flexibleCancellationType: "partial_refund",
      partialRefundTiers: partialPolicy.partialRefundTiers,
    });

    expect(mocks.put).toHaveBeenCalledWith(
      "/api/pms/properties/pms-property-1/room-types/room-type-1/flexible-rate-plan",
      expect.objectContaining({
        expectedRoomFactsRevision: 3,
        expectedPricingCurrencyRevision: 4,
        expectedFlexibleRatePlanRevision: 6,
        baseAmountDecimal: "180.00",
        cancellationTerms: expect.objectContaining({
          flexibleCancellationType: "partial_refund",
          partialRefundTiers: partialPolicy.partialRefundTiers,
        }),
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          "Idempotency-Key": expect.stringMatching(/^pms-flexible-cancellation-update-/),
        }),
      }),
    );
    expect(mocks.patch.mock.calls[1]![1]).not.toHaveProperty("flexibleCancellationType");
    expect(updated).toMatchObject({
      flexibleCancellationType: "partial_refund",
      partialRefundTiers: partialPolicy.partialRefundTiers,
    });
  });

  it("restores the partial-refund selection and every tier from the target snapshot", async () => {
    mocks.get.mockResolvedValue({
      propertyId: "pms-property-1",
      item: pmsRoomTypeItem({
        ratePlans: [
          {
            ratePlanId: "canonical-flex-1",
            pricingContractVersion: "pms-pricing.v1",
            code: "ONB15-FLEX",
            name: "Canonical flexible",
            rateType: "flexible",
            mealPlan: null,
            baseRate: { amountDecimal: "180.00", currency: "EUR" },
            active: true,
            cancellationPolicySnapshot: {
              flexibleCancellationType: "free",
              partialRefundTiers: [],
            },
          },
          {
            ratePlanId: "flex-1",
            pricingContractVersion: null,
            code: "LEGACY-FLEX",
            name: "Flexible",
            rateType: "flexible",
            mealPlan: null,
            baseRate: { amountDecimal: "180.00", currency: "EUR" },
            active: true,
            cancellationPolicySnapshot: {
              kind: "flexible",
              text: "Partial refund by notice period",
              flexibleCancellationType: "partial_refund",
              partialRefundCancelWindowDays: 30,
              partialRefundAmountPercent: 50,
              partialRefundTiers: [
                { min_days_before_check_in: 30, refund_percent: 50 },
                { minDaysBeforeCheckIn: 7, refundPercent: 20 },
              ],
            },
          },
        ],
      }),
    });

    const roomType = await roomsService.get("room-type-1");
    expect(roomTypeUpdateForm(roomType)).toMatchObject({
      flexibleCancellationType: "partial_refund",
      cancellationPolicy: "Partial refund by notice period",
      partialRefundCancelWindowDays: 30,
      partialRefundAmountPercent: 50,
      partialRefundTiers: [
        { minDaysBeforeCheckIn: 30, refundPercent: 50 },
        { minDaysBeforeCheckIn: 7, refundPercent: 20 },
      ],
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

  it("rejects unfinished blob previews before replacing room media", async () => {
    mocks.patch.mockResolvedValueOnce({
      contractVersion: "pms-operations.v1",
      propertyId: "pms-property-1",
      item: pmsRoomTypeItem(),
    });

    await expect(
      roomsService.update("room-type-1", {
        images: [{ url: "blob:room-preview" }],
      }),
    ).rejects.toThrow("Every saved room photo must finish uploading before the room can be saved.");
    expect(mocks.put).not.toHaveBeenCalled();
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
    const propertyId = "11111111-1111-4111-8111-111111111111";
    const roomTypeId = "22222222-2222-4222-8222-222222222222";
    mocks.resolvePropertyId.mockResolvedValue(propertyId);
    const item = pmsRoomTypeItem({
      roomTypeId,
      roomMediaRevision: 1,
    });
    mocks.post.mockResolvedValue({ propertyId, item });
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
    mocks.get
      .mockResolvedValueOnce(canonicalPricingSource(propertyId, roomTypeId))
      .mockResolvedValueOnce(canonicalRoomFacts(propertyId, roomTypeId))
      .mockResolvedValueOnce({ propertyId, item })
      .mockResolvedValueOnce({
        propertyId,
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
      bathroomType: "private",
      images: [{ url: "blob:room-preview", pendingFile: file }],
    });

    expect(mocks.post.mock.calls[0]?.[1]).toMatchObject({ bathroomType: "private", images: [] });
    expect(mocks.uploadImages).toHaveBeenCalledWith([file], {
      product: "hotel_catalog",
      resourceType: "property",
      resourceId: propertyId,
      propertyId,
      targetResourceId: roomTypeId,
    });
    expect(mocks.put).toHaveBeenCalledWith(
      `/api/pms/properties/${propertyId}/room-types/${roomTypeId}/media`,
      expect.objectContaining({ expectedRoomMediaRevision: 1 }),
      expect.any(Object),
    );
  });

  it("resumes after a committed media write without uploading or writing twice", async () => {
    vi.clearAllMocks();
    const propertyId = "11111111-1111-4111-8111-111111111111";
    const roomTypeId = "22222222-2222-4222-8222-222222222222";
    const mediaObjectId = "33333333-3333-4333-8333-333333333333";
    const item = pmsRoomTypeItem({ roomTypeId, roomMediaRevision: 1 });
    const appliedItem = pmsRoomTypeItem({
      roomTypeId,
      roomMediaRevision: 2,
      media: [{ mediaObjectId, url: "https://cdn.example.com/new.webp" }],
    });
    mocks.resolvePropertyId.mockResolvedValue(propertyId);
    mocks.post.mockResolvedValue({ propertyId, item });
    mocks.uploadImages.mockResolvedValue({
      images: [{ platformMediaObjectId: mediaObjectId, url: "https://cdn.example.com/new.webp" }],
      total: 1,
    });
    let roomRead = 0;
    mocks.get.mockImplementation(async (endpoint: string) => {
      if (endpoint.endsWith("/pricing-source")) {
        return canonicalPricingSource(propertyId, roomTypeId);
      }
      if (endpoint.includes("/api/pms/setup/")) {
        return canonicalRoomFacts(propertyId, roomTypeId);
      }
      roomRead += 1;
      if (roomRead === 1) return { propertyId, item };
      if (roomRead === 2) throw new Error("room refresh interrupted");
      return { propertyId, item: appliedItem };
    });
    mocks.put.mockResolvedValue({
      propertyId,
      roomTypeId,
      roomMediaRevision: 2,
    });
    const file = new File([new Uint8Array([1])], "room.jpg", { type: "image/jpeg" });
    const data = {
      name: "Alpine Suite",
      bathroomType: "private" as const,
      images: [{ url: "blob:room-preview", pendingFile: file }],
    };

    await expect(roomsService.create(data)).rejects.toThrow("room refresh interrupted");
    await expect(roomsService.create(data)).resolves.toMatchObject({
      id: roomTypeId,
      roomMediaRevision: 2,
    });

    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.post.mock.calls[1]![1]).toEqual(mocks.post.mock.calls[0]![1]);
    expect(mocks.uploadImages).toHaveBeenCalledTimes(1);
    expect(mocks.put).toHaveBeenCalledTimes(1);
  });

  it("retries generated labels that collide elsewhere in the property", async () => {
    vi.clearAllMocks();
    const propertyId = "11111111-1111-4111-8111-111111111111";
    const roomTypeId = "22222222-2222-4222-8222-222222222222";
    const unitIds = [
      "33333333-3333-4333-8333-333333333331",
      "33333333-3333-4333-8333-333333333332",
    ];
    mocks.resolvePropertyId.mockResolvedValue(propertyId);
    mocks.post.mockResolvedValue({
      propertyId,
      item: pmsRoomTypeItem({ roomTypeId, name: "Castrop Suite", roomCount: 2 }),
    });
    mocks.get
      .mockResolvedValueOnce({
        contractVersion: "pms-room-facts.v1",
        propertyId,
        roomTypeId,
        roomUnitsRevision: 1,
        activeUnitCount: 2,
        capturedAt: "2026-09-04T00:00:00.000Z",
      })
      .mockResolvedValueOnce({
        items: unitIds.map((roomUnitId) => ({
          contractVersion: "pms-room-facts.v1",
          propertyId,
          roomTypeId,
          roomUnitId,
          lifecycle: "active",
          operationalLabel: null,
          operationalLabelStatus: "unverified",
        })),
      })
      .mockResolvedValueOnce(canonicalPricingSource(propertyId, roomTypeId))
      .mockResolvedValueOnce(canonicalRoomFacts(propertyId, roomTypeId));
    let propertyWideLabelConflict = true;
    mocks.put.mockImplementation(async (endpoint, body) => {
      if (propertyWideLabelConflict && body.operationalLabel === "Castrop Suite 1") {
        propertyWideLabelConflict = false;
        throw new ApiErrorResponse(409, { code: "operational_label_conflict" });
      }
      return {
        contractVersion: "pms-room-facts.v1",
        outcome: "updated",
        propertyId,
        roomTypeId,
        roomUnitId: endpoint.split("/").at(-2),
        roomUnitsRevision: body.expectedRevision + 1,
        operationalLabel: body.operationalLabel,
        operationalLabelStatus: "verified",
        acceptedAt: "2026-09-04T00:00:00.000Z",
      };
    });

    await roomsService.create({ name: "Castrop Suite", bathroomType: "private", totalRooms: 2 });

    expect(mocks.put).toHaveBeenCalledTimes(3);
    expect(mocks.put.mock.calls.map(([, body]) => body)).toEqual([
      { expectedRevision: 1, operationalLabel: "Castrop Suite 1" },
      { expectedRevision: 1, operationalLabel: "Castrop Suite 2" },
      { expectedRevision: 2, operationalLabel: "Castrop Suite 3" },
    ]);
  });

  it("replays the room create and resumes labels before persisting canonical pricing", async () => {
    vi.clearAllMocks();
    const propertyId = "11111111-1111-4111-8111-111111111111";
    const roomTypeId = "22222222-2222-4222-8222-222222222222";
    const unitIds = [
      "33333333-3333-4333-8333-333333333331",
      "33333333-3333-4333-8333-333333333332",
    ];
    mocks.resolvePropertyId.mockResolvedValue(propertyId);
    mocks.post.mockResolvedValue({
      propertyId,
      item: pmsRoomTypeItem({ roomTypeId, name: "Castrop Suite", roomCount: 2 }),
    });
    let setupAttempt = 0;
    mocks.get.mockImplementation(async (endpoint: string) => {
      if (endpoint.endsWith("/capacity")) {
        setupAttempt += 1;
        return {
          contractVersion: "pms-room-facts.v1",
          propertyId,
          roomTypeId,
          roomUnitsRevision: setupAttempt,
          activeUnitCount: 2,
          capturedAt: canonicalAt,
        };
      }
      if (endpoint.endsWith("/units")) {
        return {
          items: unitIds.map((roomUnitId, index) => ({
            contractVersion: "pms-room-facts.v1",
            propertyId,
            roomTypeId,
            roomUnitId,
            lifecycle: "active",
            operationalLabel: setupAttempt === 2 && index === 0 ? "Castrop Suite 1" : null,
            operationalLabelStatus: setupAttempt === 2 && index === 0 ? "verified" : "unverified",
          })),
        };
      }
      if (endpoint.endsWith("/pricing-source")) {
        throw new ApiErrorResponse(404, { code: "pricing_currency_not_configured" });
      }
      if (endpoint.endsWith(`/room-types/${roomTypeId}`)) {
        return canonicalRoomFacts(propertyId, roomTypeId);
      }
      throw new Error(`Unexpected GET ${endpoint}`);
    });
    let secondLabelAttempt = 0;
    mocks.put.mockImplementation(async (endpoint: string, body) => {
      if (endpoint.endsWith("/pricing-source/currency")) {
        return {
          contractVersion: "pms-pricing.v1",
          outcome: "created",
          pricingCurrency: canonicalPricingSource(propertyId).pricingCurrency,
          acceptedAt: canonicalAt,
        };
      }
      if (endpoint.endsWith("/flexible-rate-plan")) {
        return canonicalFlexiblePlanResponse(propertyId, roomTypeId);
      }
      const roomUnitId = endpoint.split("/").at(-2);
      if (roomUnitId === unitIds[1] && secondLabelAttempt++ === 0) {
        throw new Error("label write interrupted");
      }
      return {
        contractVersion: "pms-room-facts.v1",
        outcome: "updated",
        propertyId,
        roomTypeId,
        roomUnitId,
        roomUnitsRevision: body.expectedRevision + 1,
        operationalLabel: body.operationalLabel,
        operationalLabelStatus: "verified",
        acceptedAt: canonicalAt,
      };
    });
    const data = { name: "Castrop Suite", bathroomType: "private" as const, totalRooms: 2 };

    await expect(roomsService.create(data)).rejects.toThrow("label write interrupted");
    await expect(roomsService.create(data)).resolves.toMatchObject({
      id: roomTypeId,
      totalRooms: 2,
    });

    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.post.mock.calls[1]![1]).toEqual(mocks.post.mock.calls[0]![1]);
    expect(mocks.post.mock.calls[0]![1]).toMatchObject({
      commandId: expect.stringMatching(/^pms-room-type-create-/),
      idempotencyKey: expect.stringMatching(/^pms-room-type-create-/),
    });
    expect(mocks.put).toHaveBeenCalledWith(
      `/api/pms/properties/${propertyId}/pricing-source/currency`,
      { expectedPricingCurrencyRevision: 0, currency: "EUR" },
      expect.any(Object),
    );
    expect(mocks.put).toHaveBeenCalledWith(
      `/api/pms/properties/${propertyId}/room-types/${roomTypeId}/flexible-rate-plan`,
      {
        expectedRoomFactsRevision: 1,
        expectedPricingCurrencyRevision: 1,
        expectedFlexibleRatePlanRevision: 0,
        baseAmountDecimal: "180.00",
        cancellationTerms: canonicalCancellationTerms(),
      },
      expect.objectContaining({
        headers: expect.objectContaining({
          "Idempotency-Key": expect.stringMatching(/^pms-flexible-rate-plan-upsert-/),
        }),
      }),
    );
  });

  it("reconciles an edited room count before verifying the added unit", async () => {
    vi.clearAllMocks();
    const propertyId = "11111111-1111-4111-8111-111111111111";
    const roomTypeId = "22222222-2222-4222-8222-222222222222";
    const existingUnitId = "33333333-3333-4333-8333-333333333332";
    const roomUnitId = "33333333-3333-4333-8333-333333333333";
    mocks.resolvePropertyId.mockResolvedValue(propertyId);
    mocks.patch.mockResolvedValue({
      propertyId,
      item: pmsRoomTypeItem({ roomTypeId, name: "Castrop Suite", roomCount: 1 }),
    });
    mocks.get
      .mockResolvedValueOnce({
        contractVersion: "pms-room-facts.v1",
        propertyId,
        roomTypeId,
        roomUnitsRevision: 4,
        activeUnitCount: 1,
        capturedAt: "2026-09-04T00:00:00.000Z",
      })
      .mockResolvedValueOnce({
        items: [
          {
            contractVersion: "pms-room-facts.v1",
            propertyId,
            roomTypeId,
            roomUnitId: existingUnitId,
            lifecycle: "active",
            operationalLabel: "Castrop Suite 1",
            operationalLabelStatus: "verified",
          },
          {
            contractVersion: "pms-room-facts.v1",
            propertyId,
            roomTypeId,
            roomUnitId: "33333333-3333-4333-8333-333333333331",
            lifecycle: "retired",
            operationalLabel: "Castrop Suite 2",
            operationalLabelStatus: "unverified",
          },
          {
            contractVersion: "pms-room-facts.v1",
            propertyId,
            roomTypeId,
            roomUnitId,
            lifecycle: "active",
            operationalLabel: null,
            operationalLabelStatus: "unverified",
          },
        ],
      })
      .mockResolvedValueOnce({
        propertyId,
        item: pmsRoomTypeItem({ roomTypeId, name: "Castrop Suite", roomCount: 2 }),
      })
      .mockResolvedValueOnce(canonicalPricingSource(propertyId, roomTypeId))
      .mockResolvedValueOnce(canonicalRoomFacts(propertyId, roomTypeId));
    mocks.put
      .mockResolvedValueOnce({
        contractVersion: "pms-room-facts.v1",
        outcome: "reconciled",
        propertyId,
        roomTypeId,
        previousActiveUnitCount: 1,
        capacity: {
          contractVersion: "pms-room-facts.v1",
          propertyId,
          roomTypeId,
          roomUnitsRevision: 5,
          activeUnitCount: 2,
          capturedAt: "2026-09-04T00:00:00.000Z",
        },
        addedUnits: [
          {
            contractVersion: "pms-room-facts.v1",
            propertyId,
            roomTypeId,
            roomUnitId,
            lifecycle: "active",
            operationalLabel: null,
            operationalLabelStatus: "unverified",
          },
        ],
        retiredUnitIds: [],
        acceptedAt: "2026-09-04T00:00:00.000Z",
      })
      .mockResolvedValueOnce({
        contractVersion: "pms-room-facts.v1",
        outcome: "updated",
        propertyId,
        roomTypeId,
        roomUnitId,
        roomUnitsRevision: 6,
        operationalLabel: "Castrop Suite 3",
        operationalLabelStatus: "verified",
        acceptedAt: "2026-09-04T00:00:00.000Z",
      });

    const updated = await roomsService.update(roomTypeId, { totalRooms: 2 });

    expect(mocks.put.mock.calls[0]?.[0]).toContain("/physical-units/reconcile");
    expect(mocks.put.mock.calls[0]?.[1]).toEqual({
      expectedRevision: 4,
      targetActiveUnitCount: 2,
    });
    expect(mocks.put.mock.calls[1]?.[1]).toEqual({
      expectedRevision: 5,
      operationalLabel: "Castrop Suite 3",
    });
    expect(updated.totalRooms).toBe(2);
  });

  it("resumes verification without shrinking partially labeled physical capacity", async () => {
    vi.clearAllMocks();
    const propertyId = "11111111-1111-4111-8111-111111111111";
    const roomTypeId = "22222222-2222-4222-8222-222222222222";
    const unitIds = [
      "33333333-3333-4333-8333-333333333331",
      "33333333-3333-4333-8333-333333333332",
      "33333333-3333-4333-8333-333333333333",
    ];
    mocks.resolvePropertyId.mockResolvedValue(propertyId);
    mocks.patch.mockResolvedValue({
      propertyId,
      item: pmsRoomTypeItem({ roomTypeId, name: "Castrop Suite", roomCount: 3 }),
    });
    mocks.get
      .mockResolvedValueOnce({
        contractVersion: "pms-room-facts.v1",
        propertyId,
        roomTypeId,
        roomUnitsRevision: 5,
        activeUnitCount: 3,
        capturedAt: "2026-09-04T00:00:00.000Z",
      })
      .mockResolvedValueOnce({
        items: unitIds.map((roomUnitId, index) => ({
          contractVersion: "pms-room-facts.v1",
          propertyId,
          roomTypeId,
          roomUnitId,
          lifecycle: "active",
          operationalLabel: index === 0 ? "Castrop Suite 1" : null,
          operationalLabelStatus: index === 0 ? "verified" : "unverified",
        })),
      })
      .mockResolvedValueOnce({
        propertyId,
        item: pmsRoomTypeItem({ roomTypeId, name: "Castrop Suite", roomCount: 3 }),
      })
      .mockResolvedValueOnce(canonicalPricingSource(propertyId, roomTypeId))
      .mockResolvedValueOnce(canonicalRoomFacts(propertyId, roomTypeId));
    mocks.put.mockImplementation(async (endpoint, body) => ({
      contractVersion: "pms-room-facts.v1",
      outcome: "updated",
      propertyId,
      roomTypeId,
      roomUnitId: endpoint.split("/").at(-2),
      roomUnitsRevision: body.expectedRevision + 1,
      operationalLabel: body.operationalLabel,
      operationalLabelStatus: "verified",
      acceptedAt: "2026-09-04T00:00:00.000Z",
    }));

    await expect(roomsService.update(roomTypeId, { totalRooms: 3 })).resolves.toMatchObject({
      totalRooms: 3,
    });
    expect(
      mocks.put.mock.calls.some(([endpoint]) => endpoint.endsWith("/physical-units/reconcile")),
    ).toBe(false);
    expect(mocks.put.mock.calls.map(([, body]) => body.operationalLabel)).toEqual([
      "Castrop Suite 2",
      "Castrop Suite 3",
    ]);
  });

  it("reduces a generated verified room count through canonical reconciliation", async () => {
    vi.clearAllMocks();
    const propertyId = "11111111-1111-4111-8111-111111111111";
    const roomTypeId = "22222222-2222-4222-8222-222222222222";
    mocks.resolvePropertyId.mockResolvedValue(propertyId);
    mocks.patch.mockResolvedValue({
      propertyId,
      item: pmsRoomTypeItem({ roomTypeId, name: "Castrop Suite", roomCount: 3 }),
    });
    mocks.get
      .mockResolvedValueOnce({
        contractVersion: "pms-room-facts.v1",
        propertyId,
        roomTypeId,
        roomUnitsRevision: 7,
        activeUnitCount: 3,
        capturedAt: "2026-09-04T00:00:00.000Z",
      })
      .mockResolvedValueOnce({
        items: [1, 2].map((position) => ({
          contractVersion: "pms-room-facts.v1",
          propertyId,
          roomTypeId,
          roomUnitId: `33333333-3333-4333-8333-33333333333${position}`,
          lifecycle: "active",
          operationalLabel: `Castrop Suite ${position}`,
          operationalLabelStatus: "verified",
        })),
      })
      .mockResolvedValueOnce({
        propertyId,
        item: pmsRoomTypeItem({ roomTypeId, name: "Castrop Suite", roomCount: 2 }),
      })
      .mockResolvedValueOnce(canonicalPricingSource(propertyId, roomTypeId))
      .mockResolvedValueOnce(canonicalRoomFacts(propertyId, roomTypeId));
    mocks.put.mockResolvedValueOnce({
      contractVersion: "pms-room-facts.v1",
      outcome: "reconciled",
      propertyId,
      roomTypeId,
      previousActiveUnitCount: 3,
      capacity: {
        contractVersion: "pms-room-facts.v1",
        propertyId,
        roomTypeId,
        roomUnitsRevision: 8,
        activeUnitCount: 2,
        capturedAt: "2026-09-04T00:00:00.000Z",
      },
      addedUnits: [],
      retiredUnitIds: ["33333333-3333-4333-8333-333333333333"],
      acceptedAt: "2026-09-04T00:00:00.000Z",
    });

    await expect(roomsService.update(roomTypeId, { totalRooms: 2 })).resolves.toMatchObject({
      totalRooms: 2,
    });
    expect(mocks.put).toHaveBeenCalledWith(
      expect.stringContaining("/physical-units/reconcile"),
      { expectedRevision: 7, targetActiveUnitCount: 2 },
      expect.any(Object),
    );
  });
});

describe("linkedInventoryGroupsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePropertyId.mockResolvedValue("pms-property-1");
  });

  it("lists the selected property's linked groups", async () => {
    mocks.get.mockResolvedValue({
      propertyId: "pms-property-1",
      items: [
        {
          groupId: "group-1",
          name: "Convertible suites",
          revision: 2,
          memberRoomTypeIds: ["type-1", "type-2"],
        },
      ],
    });

    await expect(linkedInventoryGroupsService.list()).resolves.toHaveLength(1);
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/pms/properties/pms-property-1/linked-inventory-groups",
      expect.any(Object),
    );
  });

  it("sends create, revisioned replace, and delete commands", async () => {
    const group = {
      groupId: "group-1",
      name: "Convertible suites",
      revision: 2,
      memberRoomTypeIds: ["type-1", "type-2"],
    };
    mocks.post.mockResolvedValue({ group });
    mocks.put.mockResolvedValue({ group: { ...group, revision: 3 } });
    mocks.delete.mockResolvedValue({ group: null });

    await linkedInventoryGroupsService.create(group.name, group.memberRoomTypeIds);
    await linkedInventoryGroupsService.update(group);
    await linkedInventoryGroupsService.delete(group);

    expect(mocks.post).toHaveBeenCalledWith(
      "/api/pms/properties/pms-property-1/linked-inventory-groups",
      expect.objectContaining({
        name: "Convertible suites",
        memberRoomTypeIds: ["type-1", "type-2"],
      }),
      expect.any(Object),
    );
    expect(mocks.put).toHaveBeenCalledWith(
      "/api/pms/properties/pms-property-1/linked-inventory-groups/group-1",
      expect.objectContaining({
        expectedRevision: 2,
        memberRoomTypeIds: ["type-1", "type-2"],
      }),
      expect.any(Object),
    );
    expect(JSON.parse(mocks.delete.mock.calls[0]![1].body)).toMatchObject({
      expectedRevision: 2,
    });
  });

  it("reuses a create command after an ambiguous failure", async () => {
    const group = {
      groupId: "group-retry",
      name: "Retry suites",
      revision: 1,
      memberRoomTypeIds: ["type-1", "type-2"],
    };
    mocks.post.mockRejectedValueOnce(new TypeError("network lost"));
    mocks.post.mockResolvedValueOnce({ group });

    await expect(
      linkedInventoryGroupsService.create(
        ` ${group.name} `,
        [...group.memberRoomTypeIds].reverse(),
      ),
    ).rejects.toThrow("network lost");
    await expect(
      linkedInventoryGroupsService.create(group.name, group.memberRoomTypeIds),
    ).resolves.toEqual(group);

    expect(mocks.post.mock.calls[1]![1].commandId).toBe(mocks.post.mock.calls[0]![1].commandId);
  });
});
