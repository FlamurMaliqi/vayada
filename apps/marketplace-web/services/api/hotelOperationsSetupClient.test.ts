import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  getStatus: vi.fn(),
  getPropertyProfile: vi.fn(),
  updatePropertyProfile: vi.fn(),
  getPublicPropertyProfile: vi.fn(),
  updatePublicPropertyProfile: vi.fn(),
  uploadPlatformMedia: vi.fn(),
}));

vi.mock("./targetClient", () => ({
  targetApiClient: {
    get: mocks.get,
    patch: mocks.patch,
    post: mocks.post,
    put: mocks.put,
  },
}));

vi.mock("./sharedHotelSetupClient", () => ({
  sharedHotelSetupApi: {
    getStatus: mocks.getStatus,
    getPropertyProfile: mocks.getPropertyProfile,
    updatePropertyProfile: mocks.updatePropertyProfile,
    getPublicPropertyProfile: mocks.getPublicPropertyProfile,
    updatePublicPropertyProfile: mocks.updatePublicPropertyProfile,
  },
}));

vi.mock("@vayada/marketplace-shared/api/platformMedia", () => ({
  uploadPlatformMedia: mocks.uploadPlatformMedia,
}));

import {
  buildPaymentSettingsRequest,
  buildRoomSetupRequest,
  hotelOperationsSetupApi,
  hotelOperationsWriteMayHaveCommitted,
  isPropertyCurrencyConflict,
  isPublicationReady,
  isStripeReady,
  stableSetupCommandId,
} from "./hotelOperationsSetupClient";
import { ApiErrorResponse } from "./client";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getStatus.mockResolvedValue(roomSetupStatus("actionable"));
});

describe("hotel operations setup client", () => {
  it("hydrates the first active PMS room type for a completed setup step", async () => {
    const signal = new AbortController().signal;
    mocks.get.mockResolvedValue({
      items: [
        {
          roomTypeId: "inactive-room",
          name: "Old room",
          occupancyLimits: { total: 2 },
          baseRate: { amountDecimal: "100.00", currency: "EUR" },
          active: false,
          rateRulesSummary: { minStayNights: 1 },
          roomCount: 1,
        },
        {
          roomTypeId: "active-room",
          name: "Alpine Suite",
          occupancyLimits: { adults: 2, children: 1, total: 3 },
          baseRate: { amountDecimal: "180.00", currency: "EUR" },
          active: true,
          rateRulesSummary: { minStayNights: 2 },
          roomCount: 4,
        },
      ],
    });

    await expect(
      hotelOperationsSetupApi.getExistingRoomSetup("property / one", signal),
    ).resolves.toEqual({
      roomTypeId: "active-room",
      active: true,
      name: "Alpine Suite",
      totalRooms: 4,
      maxOccupancy: 3,
      nightlyRate: "180.00",
      currency: "EUR",
      minimumStay: 2,
    });
    expect(mocks.get).toHaveBeenCalledWith("/api/pms/properties/property%20%2F%20one/room-types", {
      signal,
    });
  });

  it("hydrates the first inactive room type when PMS has no active room type", async () => {
    mocks.get.mockResolvedValue({
      items: [
        {
          roomTypeId: "inactive-room",
          name: "Old room",
          occupancyLimits: { total: 2 },
          baseRate: { amountDecimal: "100.00", currency: "EUR" },
          active: false,
          rateRulesSummary: { minStayNights: null },
          roomCount: 1,
        },
      ],
    });

    await expect(hotelOperationsSetupApi.getExistingRoomSetup("property-1")).resolves.toMatchObject(
      {
        roomTypeId: "inactive-room",
        active: false,
        name: "Old room",
      },
    );
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("treats an inactive-only room type as recovery even when all active facts are missing", async () => {
    mocks.getStatus.mockResolvedValue(
      roomSetupStatus("actionable", [
        "missing_active_room_type",
        "missing_non_retired_room",
        "missing_active_rate_plan",
        "missing_future_inventory",
      ]),
    );
    mocks.get.mockResolvedValue({
      items: [
        {
          roomTypeId: "inactive-room",
          name: "Old room",
          occupancyLimits: { total: 2 },
          baseRate: { amountDecimal: "100.00", currency: "EUR" },
          active: false,
          rateRulesSummary: { minStayNights: 1 },
          roomCount: 0,
        },
      ],
    });

    await expect(hotelOperationsSetupApi.getRoomSetupState("property-1")).resolves.toMatchObject({
      status: "needs_recovery",
      room: {
        roomTypeId: "inactive-room",
        active: false,
      },
    });
  });

  it("refuses to POST a duplicate room type when only an inactive room type exists", async () => {
    mocks.getStatus.mockResolvedValue(
      roomSetupStatus("actionable", [
        "missing_active_room_type",
        "missing_non_retired_room",
        "missing_active_rate_plan",
        "missing_future_inventory",
      ]),
    );
    mocks.get.mockResolvedValue({
      items: [
        {
          roomTypeId: "inactive-room",
          name: "Old room",
          occupancyLimits: { total: 2 },
          baseRate: { amountDecimal: "100.00", currency: "EUR" },
          active: false,
          rateRulesSummary: { minStayNights: 1 },
          roomCount: 0,
        },
      ],
    });

    await expect(
      hotelOperationsSetupApi.saveRoomSetup("property-1", {
        name: "Duplicate room",
        totalRooms: 1,
        maxOccupancy: 2,
        nightlyRate: 100,
        currency: "EUR",
      }),
    ).resolves.toMatchObject({
      status: "needs_recovery",
      room: {
        roomTypeId: "inactive-room",
        active: false,
      },
    });
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("does not create a duplicate when authoritative setup completed in another session", async () => {
    mocks.getStatus.mockResolvedValue(roomSetupStatus("complete"));
    mocks.get.mockResolvedValue({ items: [] });

    await expect(
      hotelOperationsSetupApi.saveRoomSetup("property-1", {
        name: "Duplicate suite",
        totalRooms: 4,
        maxOccupancy: 3,
        nightlyRate: 190,
        currency: "EUR",
      }),
    ).resolves.toEqual({ status: "complete", room: null });
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("blocks recovery instead of creating a duplicate for a partial active room setup", async () => {
    mocks.getStatus.mockResolvedValue(
      roomSetupStatus("actionable", ["missing_non_retired_room", "missing_future_inventory"]),
    );
    mocks.get.mockResolvedValue({
      items: [
        {
          roomTypeId: "active-room",
          name: "Partial suite",
          occupancyLimits: { total: 2 },
          baseRate: { amountDecimal: "150.00", currency: "EUR" },
          active: true,
          rateRulesSummary: { minStayNights: 1 },
          roomCount: 0,
        },
      ],
    });

    await expect(
      hotelOperationsSetupApi.saveRoomSetup("property-1", {
        name: "Duplicate suite",
        totalRooms: 2,
        maxOccupancy: 2,
        nightlyRate: 150,
        currency: "EUR",
      }),
    ).resolves.toMatchObject({
      status: "needs_recovery",
      room: { roomTypeId: "active-room" },
      reasonCodes: ["missing_non_retired_room", "missing_future_inventory"],
    });
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("trusts authoritative active-room readiness when the PMS list projection is still empty", async () => {
    mocks.getStatus.mockResolvedValue(
      roomSetupStatus("actionable", ["missing_non_retired_room", "missing_future_inventory"]),
    );
    mocks.get.mockResolvedValue({ items: [] });

    await expect(
      hotelOperationsSetupApi.saveRoomSetup("property-1", {
        name: "Duplicate suite",
        totalRooms: 2,
        maxOccupancy: 2,
        nightlyRate: 150,
        currency: "EUR",
      }),
    ).resolves.toEqual({
      status: "needs_recovery",
      room: null,
      reasonCodes: ["missing_non_retired_room", "missing_future_inventory"],
    });
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("blocks creation when an active type is missing but another room fact already exists", async () => {
    mocks.getStatus.mockResolvedValue(
      roomSetupStatus("actionable", [
        "missing_active_room_type",
        "missing_non_retired_room",
        "missing_future_inventory",
      ]),
    );
    mocks.get.mockResolvedValue({ items: [] });

    await expect(
      hotelOperationsSetupApi.saveRoomSetup("property-1", {
        name: "Conflicting room",
        totalRooms: 2,
        maxOccupancy: 2,
        nightlyRate: 150,
        currency: "EUR",
      }),
    ).resolves.toEqual({
      status: "needs_recovery",
      room: null,
      reasonCodes: [
        "missing_active_room_type",
        "missing_non_retired_room",
        "missing_future_inventory",
      ],
    });
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("creates the atomic room setup only when readiness is actionable and no active room exists", async () => {
    mocks.getStatus.mockResolvedValue(
      roomSetupStatus("actionable", [
        "missing_active_room_type",
        "missing_non_retired_room",
        "missing_active_rate_plan",
        "missing_future_inventory",
      ]),
    );
    mocks.get.mockResolvedValue({ items: [] });
    mocks.post.mockResolvedValue({});

    await expect(
      hotelOperationsSetupApi.saveRoomSetup("property-1", {
        name: "Double room",
        totalRooms: 2,
        maxOccupancy: 2,
        nightlyRate: 150,
        currency: "EUR",
      }),
    ).resolves.toEqual({ status: "created" });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/pms/properties/property-1/room-types",
      expect.objectContaining({ name: "Double room", totalRooms: 2 }),
    );
    expect(mocks.get).toHaveBeenCalledWith("/api/pms/properties/property-1/room-types", undefined);
  });

  it("adds another room type without reusing the initial-setup guard", async () => {
    mocks.post.mockResolvedValue({});

    await hotelOperationsSetupApi.addRoomSetup("property-1", {
      name: "Pool Villa",
      totalRooms: 3,
      maxOccupancy: 4,
      nightlyRate: 280,
      currency: "IDR",
    });

    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.getStatus).not.toHaveBeenCalled();
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/pms/properties/property-1/room-types",
      expect.objectContaining({
        initialSetupOnly: false,
        name: "Pool Villa",
        currency: "IDR",
        seasons: [expect.objectContaining({ minStay: 1 })],
      }),
    );
  });

  it("builds an atomic room, rate, and inventory command with a stable retry key", () => {
    const draft = {
      name: "Double room",
      totalRooms: 4,
      maxOccupancy: 2,
      nightlyRate: 189.5,
      currency: "eur",
    };

    const first = buildRoomSetupRequest("property-1", draft);
    const retry = buildRoomSetupRequest("property-1", { ...draft });

    expect(first).toMatchObject({
      onboardingSetup: true,
      initialSetupOnly: true,
      name: "Double room",
      totalRooms: 4,
      maxOccupancy: 2,
      baseRate: "189.50",
      currency: "EUR",
      operatingPeriods: [{ from: "01-01", to: "12-31" }],
      seasons: [
        expect.objectContaining({
          from: "01-01",
          to: "12-31",
          rate: "189.50",
          minStay: 1,
        }),
      ],
    });
    expect(first.commandId).toBe(first.idempotencyKey);
    expect(retry.commandId).toBe(first.commandId);
  });

  it("distinguishes ambiguous room writes from definitive client rejections", () => {
    expect(hotelOperationsWriteMayHaveCommitted(new TypeError("Failed to fetch"))).toBe(true);
    expect(hotelOperationsWriteMayHaveCommitted(new ApiErrorResponse(503, {}))).toBe(true);
    expect(hotelOperationsWriteMayHaveCommitted(new ApiErrorResponse(409, {}))).toBe(false);
    expect(
      isPropertyCurrencyConflict(new ApiErrorResponse(409, { code: "property_currency_conflict" })),
    ).toBe(true);
    expect(isPropertyCurrencyConflict(new ApiErrorResponse(409, {}))).toBe(false);
  });

  it("changes command keys when the authoritative payload changes", () => {
    expect(stableSetupCommandId("setup", "property-1", { rate: 100 })).not.toBe(
      stableSetupCommandId("setup", "property-1", { rate: 120 }),
    );
    expect(stableSetupCommandId("setup", "property-1", { a: 1, b: 2 })).toBe(
      stableSetupCommandId("setup", "property-1", { b: 2, a: 1 }),
    );
  });

  it("uses canonical property IDs for Booking guest-policy reads and writes", async () => {
    mocks.get.mockResolvedValue({
      property_name: "Hotel Alpenrose",
      check_in_time: "16:00",
      check_out_time: "10:30",
      terms_text: "Existing terms.",
      cancellation_policy_text: "Free until 5 days before arrival.",
    });
    mocks.patch.mockResolvedValue({});

    await expect(
      hotelOperationsSetupApi.getGuestSettingsPolicies("property / one"),
    ).resolves.toEqual({
      checkInTime: "16:00",
      checkOutTime: "10:30",
      termsAndConditions: "Existing terms.",
      cancellationPolicyText: "Free until 5 days before arrival.",
    });
    await hotelOperationsSetupApi.updateGuestSettingsPolicies("property / one", {
      checkInTime: "15:00",
      checkOutTime: "11:00",
      termsAndConditions: " Custom terms. ",
      cancellationPolicyText: " Free until 7 days before arrival. ",
    });

    expect(mocks.get).toHaveBeenCalledWith(
      "/api/booking/hotels/property%20%2F%20one/settings/property",
      undefined,
    );
    expect(mocks.patch).toHaveBeenCalledWith(
      "/api/booking/hotels/property%20%2F%20one/settings/property",
      {
        check_in_time: "15:00",
        check_out_time: "11:00",
        terms_text: "Custom terms.",
        cancellation_policy_text: "Free until 7 days before arrival.",
      },
    );
  });

  it("seeds terms only before the policy task has been completed", async () => {
    mocks.get.mockResolvedValue({ property_name: "Green Poya Resort" });

    const seeded = await hotelOperationsSetupApi.getGuestSettingsPolicies(
      "property-1",
      undefined,
      true,
    );
    await hotelOperationsSetupApi.updateGuestSettingsPolicies("property-1", {
      ...seeded,
      termsAndConditions: "",
    });
    const revisited = await hotelOperationsSetupApi.getGuestSettingsPolicies(
      "property-1",
      undefined,
      false,
    );

    expect(seeded.termsAndConditions).toContain('direct agreement with Green Poya Resort ("Host")');
    expect(revisited.termsAndConditions).toBe("");
    expect(mocks.patch).toHaveBeenCalledWith(
      "/api/booking/hotels/property-1/settings/property",
      expect.objectContaining({ terms_text: "" }),
    );
    expect(seeded.checkInTime).toBe("15:00");
    expect(seeded.checkOutTime).toBe("11:00");
  });

  it("reads and writes launch settings through the property-owned setup endpoint", async () => {
    mocks.get.mockResolvedValue({
      defaultCurrency: "EUR",
      supportedCurrencies: ["CHF", "GBP", 7],
      defaultLanguage: "de",
      supportedLanguages: ["en", "fr"],
      instagram: "https://instagram.com/alpenrose",
      facebook: "https://facebook.com/alpenrose",
      tiktok: "https://tiktok.com/@alpenrose",
      youtube: "https://youtube.com/@alpenrose",
    });
    mocks.put.mockResolvedValue({});

    await expect(
      hotelOperationsSetupApi.getPropertyLaunchSettings("property / one"),
    ).resolves.toEqual({
      defaultCurrency: "EUR",
      supportedCurrencies: ["CHF", "GBP"],
      defaultLanguage: "de",
      supportedLanguages: ["en", "fr"],
      instagram: "https://instagram.com/alpenrose",
      facebook: "https://facebook.com/alpenrose",
      tiktok: "https://tiktok.com/@alpenrose",
      youtube: "https://youtube.com/@alpenrose",
    });

    await hotelOperationsSetupApi.updatePropertyLaunchSettings("property / one", {
      defaultCurrency: "EUR",
      supportedCurrencies: ["CHF"],
      defaultLanguage: "de",
      supportedLanguages: ["en"],
      instagram: "https://instagram.com/alpenrose",
      facebook: "",
      tiktok: "https://tiktok.com/@alpenrose",
      youtube: "",
    });

    expect(mocks.get).toHaveBeenCalledWith(
      "/api/hotel-setup/properties/property%20%2F%20one/launch-settings",
      undefined,
    );
    expect(mocks.put).toHaveBeenCalledWith(
      "/api/hotel-setup/properties/property%20%2F%20one/launch-settings",
      {
        defaultCurrency: "EUR",
        supportedCurrencies: ["CHF"],
        defaultLanguage: "de",
        supportedLanguages: ["en"],
        instagram: "https://instagram.com/alpenrose",
        facebook: "",
        tiktok: "https://tiktok.com/@alpenrose",
        youtube: "",
      },
    );
  });

  it("builds honest manual and Stripe payment settings", () => {
    expect(buildPaymentSettingsRequest("property-1", "pay_at_property", "EUR")).toMatchObject({
      paymentSettings: {
        paymentsEnabled: true,
        paymentProvider: "manual",
        acceptedMethods: ["pay_at_property"],
        defaultCurrency: "EUR",
        supportedCurrencies: ["EUR"],
      },
    });
    expect(buildPaymentSettingsRequest("property-1", "stripe", "USD")).toMatchObject({
      paymentSettings: {
        paymentsEnabled: true,
        paymentProvider: "stripe",
        acceptedMethods: ["card"],
        defaultCurrency: "USD",
        supportedCurrencies: ["USD"],
      },
    });
  });

  it("only treats Stripe as ready when the provider can charge", () => {
    const base = {
      paymentsEnabled: true,
      paymentProvider: "stripe" as const,
      acceptedMethods: ["card"],
      defaultCurrency: "EUR",
      supportedCurrencies: ["EUR"],
      requiresManualReview: false,
      providerAccount: {
        providerAccountId: "provider-1",
        provider: "stripe",
        status: "active",
        onboardingStatus: "completed",
        chargesEnabled: true,
        payoutsEnabled: true,
      },
    };
    expect(isStripeReady(base)).toBe(true);
    expect(
      isStripeReady({
        ...base,
        providerAccount: { ...base.providerAccount, chargesEnabled: false },
      }),
    ).toBe(false);
  });

  it("writes the minimum public description for Operations-only setup", async () => {
    const file = new File(["image"], "hotel.webp", { type: "image/webp" });
    mocks.getPropertyProfile.mockResolvedValue({
      propertyId: "property-1",
      profileRevision: 3,
      profile: {
        displayName: "Hotel One",
        location: { localityPublic: false },
      },
    });
    mocks.updatePropertyProfile.mockResolvedValue({
      propertyId: "property-1",
      profileRevision: 4,
      profile: {
        displayName: "Hotel One",
        location: { localityPublic: true },
      },
    });
    mocks.uploadPlatformMedia.mockResolvedValue([{ mediaId: "media-1", url: "https://cdn/hotel" }]);
    mocks.getPublicPropertyProfile.mockResolvedValue({
      propertyId: "property-1",
      profileRevision: 5,
      publicProfile: {
        shortDescription: null,
        longDescription: null,
        media: [],
      },
    });
    mocks.updatePublicPropertyProfile.mockResolvedValue({});
    mocks.patch.mockResolvedValue({});

    const heroImageUrl = await hotelOperationsSetupApi.uploadDirectBookingHero(
      "property-1",
      file,
      3,
    );
    await hotelOperationsSetupApi.saveDirectBookingSetup("property-1", {
      localityPublic: true,
      publicDescription: "A small city hotel.",
      heroHeading: "Stay with us",
      heroSubtext: "Book directly for our best available rooms.",
      primaryColor: "#1E3EDB",
      fontPairing: "modern-minimalist",
      heroImageUrl,
    });
    await hotelOperationsSetupApi.saveDirectBookingSetup("property-1", {
      localityPublic: true,
      publicDescription: "A small city hotel.",
      heroHeading: "Stay with us",
      heroSubtext: "Book directly for our best available rooms.",
      primaryColor: "#1E3EDB",
      fontPairing: "modern-minimalist",
      heroImageUrl,
    });

    expect(mocks.uploadPlatformMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "booking.direct-hero:property-1:revision:3",
        purpose: "property.hero_image",
        expectedProfileRevision: 3,
        resource: {
          product: "booking",
          resourceType: "booking_hotel",
          resourceId: "property-1",
          propertyId: "property-1",
        },
        files: [file],
      }),
    );
    expect(mocks.uploadPlatformMedia).toHaveBeenCalledTimes(1);
    expect(mocks.updatePublicPropertyProfile).toHaveBeenCalledWith("property-1", {
      expectedProfileRevision: 5,
      patch: { shortDescription: "A small city hotel." },
    });
    expect(mocks.patch).toHaveBeenCalledWith(
      "/api/booking/hotels/property-1/settings/design",
      expect.objectContaining({ heroImage: "https://cdn/hotel" }),
    );
  });

  it("does not read or write the canonical description for a both-track setup", async () => {
    mocks.getPropertyProfile.mockResolvedValue({
      propertyId: "property-1",
      profileRevision: 8,
      profile: {
        displayName: "Hotel One",
        location: { localityPublic: true },
      },
    });
    mocks.patch.mockResolvedValue({});

    await hotelOperationsSetupApi.saveDirectBookingSetup("property-1", {
      localityPublic: true,
      heroHeading: "Stay with us",
      heroSubtext: "Book directly for our best available rooms.",
      primaryColor: "#1E3EDB",
      fontPairing: "modern-minimalist",
      heroImageUrl: "https://cdn/hotel",
    });

    expect(mocks.getPublicPropertyProfile).not.toHaveBeenCalled();
    expect(mocks.updatePublicPropertyProfile).not.toHaveBeenCalled();
    expect(mocks.patch).toHaveBeenCalledWith("/api/booking/hotels/property-1/settings/design", {
      heroImage: "https://cdn/hotel",
      heroHeading: "Stay with us",
      heroSubtext: "Book directly for our best available rooms.",
      primaryColor: "#1E3EDB",
      fontPairing: "modern-minimalist",
    });
  });

  it("requires the authoritative publication to be public, fresh, and complete", () => {
    expect(
      isPublicationReady({
        propertyId: "property-1",
        canonicalSlug: "hotel-one",
        canonicalUrl: "https://hotel-one.booking.localhost/en",
        bookingBaseUrl: "https://hotel-one.booking.localhost",
        profileStatus: "public",
        freshnessStatus: "fresh",
        missingReadiness: [],
      }),
    ).toBe(true);
    expect(
      isPublicationReady({
        propertyId: "property-1",
        canonicalSlug: "hotel-one",
        canonicalUrl: "https://hotel-one.booking.localhost/en",
        bookingBaseUrl: "https://hotel-one.booking.localhost",
        profileStatus: "incomplete",
        freshnessStatus: "fresh",
        missingReadiness: ["profile"],
      }),
    ).toBe(false);
  });
});

function roomSetupStatus(readiness: "actionable" | "complete", reasonCodes: string[] = []) {
  return {
    setupPlan: {
      tasks: [{ taskId: "rooms_rates_availability", readiness, reasonCodes }],
    },
  };
}
