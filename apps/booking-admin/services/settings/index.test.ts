import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearAuthData, setAuthKitSession } from "../auth/sessionStore";
import { settingsService } from ".";

const originalAuthKitFlag = process.env.NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED;
const originalCompatibilityFlag = process.env.NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED;
const originalApiUrl = process.env.NEXT_PUBLIC_API_URL;

describe("settingsService next-stack bootstrap data", () => {
  let propertySettingsFailure: number | Error | null;

  beforeEach(() => {
    propertySettingsFailure = null;
    const storage = createMemoryStorage();
    let designSettings = {
      headerLogo: "https://cdn.vayada.test/hotels/alpenrose/logo.webp",
      heroImage: "https://cdn.vayada.test/hotels/alpenrose/hero.jpg",
      heroHeading: "Stay above the clouds",
      heroSubtext: "An independent alpine escape.",
      primaryColor: "#2563EB",
      fontPairing: "modern-minimalist",
    };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", { localStorage: storage });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const href = String(url);
        if (href.includes("/api/hotel-setup/status?entryProduct=booking")) {
          return new Response(
            JSON.stringify(
              adaptiveSetupStatus([
                {
                  propertyId: "property_alpenrose",
                  publicId: "hotel-alpenrose",
                  displayName: "Hotel Alpenrose",
                  locationSummary: "Innsbruck, AT",
                },
              ]),
            ),
            { headers: { "content-type": "application/json" } },
          );
        }
        if (href.endsWith("/api/booking/hotels/booking_hotel_alpenrose/property-link")) {
          return new Response(
            JSON.stringify({
              hotelId: "booking_hotel_alpenrose",
              propertyId: "property_alpenrose",
              resourceLinks: {
                bookingHotel: true,
                pmsProperty: true,
                financeProperty: true,
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        if (href.endsWith("/api/booking/hotels/property_alpenrose/property-link")) {
          return new Response(
            JSON.stringify({
              hotelId: "property_alpenrose",
              propertyId: "property_alpenrose",
              resourceLinks: {
                bookingHotel: true,
                pmsProperty: true,
                financeProperty: true,
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        if (href.endsWith("/api/booking/hotels/property_alpenrose/settings/property")) {
          return new Response(JSON.stringify({ detail: "Booking hotel settings not found." }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }
        if (href.endsWith("/api/booking/hotels/booking_hotel_alpenrose/settings/property")) {
          if (propertySettingsFailure instanceof Error) throw propertySettingsFailure;
          if (propertySettingsFailure !== null) {
            return new Response(JSON.stringify({ detail: "Booking settings unavailable." }), {
              status: propertySettingsFailure,
              headers: { "content-type": "application/json" },
            });
          }
          if (init?.method === "PATCH") {
            return new Response(
              JSON.stringify({
                id: "booking_hotel_alpenrose",
                slug: "hotel-alpenrose",
                property_name: "Updated",
                reservation_email: "reservations@example.com",
                phone_number: "+43 1 2345",
                whatsapp_number: "+43 1 6789",
                address: "Alpenweg 1, Innsbruck",
                default_currency: "EUR",
                default_language: "de",
                supported_currencies: ["EUR"],
                supported_languages: ["de", "en"],
                check_in_time: "15:00",
                check_out_time: "11:00",
                pay_at_property_enabled: true,
                pay_at_hotel_methods: ["cash"],
                online_card_payment: false,
                bank_transfer: false,
                free_cancellation_days: 7,
                email_notifications: true,
                new_booking_alerts: true,
                payment_alerts: true,
                ota_booking_alerts: false,
              }),
              { headers: { "content-type": "application/json" } },
            );
          }
          return new Response(
            JSON.stringify({
              id: "booking_hotel_alpenrose",
              slug: "hotel-alpenrose",
              property_name: "Hotel Alpenrose",
              reservation_email: "reservations@example.com",
              phone_number: "+43 1 2345",
              whatsapp_number: "+43 1 6789",
              address: "Alpenweg 1, Innsbruck",
              default_currency: "EUR",
              default_language: "de",
              supported_currencies: ["EUR"],
              supported_languages: ["de", "en"],
              check_in_time: "15:00",
              check_out_time: "11:00",
              pay_at_property_enabled: true,
              pay_at_hotel_methods: ["cash"],
              online_card_payment: false,
              bank_transfer: false,
              free_cancellation_days: 7,
              email_notifications: true,
              new_booking_alerts: true,
              payment_alerts: true,
              ota_booking_alerts: false,
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        if (href.endsWith("/api/booking/hotels/booking_hotel_alpenrose/settings/design")) {
          if (init?.method === "PATCH") {
            designSettings = {
              ...designSettings,
              ...(JSON.parse(String(init.body)) as Partial<typeof designSettings>),
            };
          }
          return new Response(JSON.stringify(designSettings), {
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected request: ${href}`);
      }),
    );
    process.env.NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED = "true";
    process.env.NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED = "false";
    process.env.NEXT_PUBLIC_API_URL = "https://next-api.vayada.com";
    setAuthKitSession({
      accessToken: "workos-access-token",
      resources: {
        "booking:booking_hotel": ["property_alpenrose", "booking_hotel_alpenrose"],
      },
      user: {
        id: "user_1",
        email: "owner@example.com",
        status: "active",
      },
    });
  });

  afterEach(() => {
    clearAuthData();
    vi.unstubAllGlobals();
    restoreEnv("NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED", originalAuthKitFlag);
    restoreEnv("NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED", originalCompatibilityFlag);
    restoreEnv("NEXT_PUBLIC_API_URL", originalApiUrl);
  });

  it("uses scoped booking hotels instead of legacy admin setup routes", async () => {
    await expect(settingsService.listHotels()).resolves.toEqual([
      {
        id: "booking_hotel_alpenrose",
        propertyId: "property_alpenrose",
        bookingHotelId: "booking_hotel_alpenrose",
        name: "Hotel Alpenrose",
        slug: "hotel-alpenrose",
        location: "Innsbruck, AT",
        country: "",
      },
    ]);
    localStorage.setItem("selectedHotelId", "booking_hotel_alpenrose");
    await expect(settingsService.getPropertySettings()).resolves.toMatchObject({
      id: "booking_hotel_alpenrose",
      property_name: "Hotel Alpenrose",
    });
    await expect(
      settingsService.updatePropertySettings({ property_name: "Updated" }),
    ).resolves.toMatchObject({
      id: "booking_hotel_alpenrose",
      property_name: "Updated",
    });
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([input]) => String(input).includes("/admin/settings/setup-status")),
    ).toBe(false);
    expect(fetch).toHaveBeenLastCalledWith(
      expect.stringMatching(/\/api\/booking\/hotels\/booking_hotel_alpenrose\/settings\/property$/),
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("loads and saves the design model for an explicit Booking hotel", async () => {
    await expect(settingsService.getDesignSettings(" booking_hotel_alpenrose ")).resolves.toEqual({
      header_logo: "https://cdn.vayada.test/hotels/alpenrose/logo.webp",
      hero_image: "https://cdn.vayada.test/hotels/alpenrose/hero.jpg",
      hero_heading: "Stay above the clouds",
      hero_subtext: "An independent alpine escape.",
      primary_color: "#2563EB",
      font_pairing: "modern-minimalist",
    });

    await expect(
      settingsService.updateDesignSettings(
        {
          header_logo: "https://cdn.vayada.test/hotels/alpenrose/new-logo.webp",
          hero_image: "https://cdn.vayada.test/hotels/alpenrose/summer.jpg",
          hero_heading: "Book the mountain directly",
          hero_subtext: "A quieter stay starts here.",
          primary_color: "#0F766E",
          font_pairing: "grand-classic",
        },
        "booking_hotel_alpenrose",
      ),
    ).resolves.toEqual({
      header_logo: "https://cdn.vayada.test/hotels/alpenrose/new-logo.webp",
      hero_image: "https://cdn.vayada.test/hotels/alpenrose/summer.jpg",
      hero_heading: "Book the mountain directly",
      hero_subtext: "A quieter stay starts here.",
      primary_color: "#0F766E",
      font_pairing: "grand-classic",
    });

    const designCalls = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => String(url).includes("/settings/design"));
    expect(
      designCalls.map(([url, init]) => ({
        path: new URL(String(url)).pathname,
        method: init?.method,
        body: init?.body,
      })),
    ).toEqual([
      {
        path: "/api/booking/hotels/booking_hotel_alpenrose/settings/design",
        method: "GET",
        body: undefined,
      },
      {
        path: "/api/booking/hotels/booking_hotel_alpenrose/settings/design",
        method: "PATCH",
        body: JSON.stringify({
          headerLogo: "https://cdn.vayada.test/hotels/alpenrose/new-logo.webp",
          heroImage: "https://cdn.vayada.test/hotels/alpenrose/summer.jpg",
          heroHeading: "Book the mountain directly",
          heroSubtext: "A quieter stay starts here.",
          primaryColor: "#0F766E",
          fontPairing: "grand-classic",
        }),
      },
    ]);
  });

  it.each([401, 500])(
    "does not hide a %i response from the canonical property settings request",
    async (status) => {
      propertySettingsFailure = status;

      await expect(settingsService.listHotels()).rejects.toMatchObject({ status });
    },
  );

  it("does not hide a network failure from the canonical property settings request", async () => {
    propertySettingsFailure = new Error("property settings network failure");

    await expect(settingsService.listHotels()).rejects.toThrow("property settings network failure");
  });

  it("keeps the canonical Booking hotel id and slug together with an explicit self fallback", async () => {
    setAuthKitSession({
      accessToken: "workos-access-token",
      resources: {
        "booking:booking_hotel": [
          "booking_hotel_z",
          "booking_hotel_a",
          "property_alpenrose",
          "property_self",
        ],
      },
      user: {
        id: "user_1",
        email: "owner@example.com",
        status: "active",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const href = String(url);
        if (href.includes("/api/hotel-setup/status?entryProduct=booking")) {
          return jsonResponse(
            adaptiveSetupStatus([
              {
                propertyId: "property_alpenrose",
                publicId: "hotel-alpenrose",
                displayName: "Hotel Alpenrose",
                locationSummary: "Innsbruck, AT",
              },
              {
                propertyId: "property_self",
                publicId: "self-managed",
                displayName: "Self-managed hotel",
                locationSummary: "Salzburg, AT",
              },
            ]),
          );
        }

        const hotelId = decodeURIComponent(
          new URL(href).pathname.match(/\/hotels\/([^/]+)\//)?.[1] ?? "",
        );
        if (href.endsWith("/property-link")) {
          return jsonResponse({
            hotelId,
            propertyId: hotelId === "property_self" ? "property_self" : "property_alpenrose",
            resourceLinks: {
              bookingHotel: true,
              pmsProperty: true,
              financeProperty: true,
            },
          });
        }
        if (href.endsWith("/settings/property")) {
          const slugByHotelId: Record<string, string> = {
            booking_hotel_z: "hotel-z",
            booking_hotel_a: "hotel-a",
            property_alpenrose: "self-alpenrose",
            property_self: "self-managed",
          };
          return jsonResponse({ slug: slugByHotelId[hotelId] });
        }
        throw new Error(`unexpected request: ${href}`);
      }),
    );

    await expect(settingsService.listHotels()).resolves.toEqual([
      {
        id: "booking_hotel_a",
        propertyId: "property_alpenrose",
        bookingHotelId: "booking_hotel_a",
        name: "Hotel Alpenrose",
        slug: "hotel-a",
        location: "Innsbruck, AT",
        country: "",
      },
      {
        id: "property_self",
        propertyId: "property_self",
        bookingHotelId: undefined,
        name: "Self-managed hotel",
        slug: "self-managed",
        location: "Salzburg, AT",
        country: "",
      },
    ]);
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function adaptiveSetupStatus(
  properties: Array<{
    propertyId: string;
    publicId: string;
    displayName: string | null;
    locationSummary: string | null;
  }>,
) {
  const selectedPropertyId = properties.length === 1 ? properties[0]!.propertyId : null;
  return {
    contractVersion: "adaptive-hotel-setup.v1",
    organization: {
      organizationId: "organization_1",
      displayName: "Alpenrose Hotels",
      websiteUrl: null,
      selectedTracks: ["hotel_operations"],
      trackRevision: 1,
      canManageTracks: true,
      tracks: [
        {
          track: "hotel_operations",
          provisioning: "active",
          components: [
            { product: "pms", access: "active" },
            { product: "booking", access: "active" },
          ],
          allowedActions: ["manage_service"],
        },
        {
          track: "creator_marketplace",
          provisioning: "not_selected",
          components: [{ product: "marketplace", access: "absent" }],
          allowedActions: ["add"],
        },
      ],
    },
    propertySelection: {
      state: properties.length === 1 ? "single_property" : "multiple_properties",
      selectedPropertyId,
      availableProperties: properties,
    },
    entryDecision: selectedPropertyId
      ? {
          requestedProduct: "booking",
          propertyId: selectedPropertyId,
          decision: "enter",
          destinationRouteKey: "booking.workspace",
          reasonCode: null,
        }
      : {
          requestedProduct: "booking",
          propertyId: null,
          decision: "setup_required",
          destinationRouteKey: "hotel_setup",
          reasonCode: "property_selection_required",
        },
    setupPlan: selectedPropertyId
      ? {
          propertyId: selectedPropertyId,
          planRevision: "plan-1",
          tasks: hotelOperationsTasks(selectedPropertyId),
          recommendedTaskId: null,
          ownerProgress: { complete: 5, total: 5 },
          launchReadiness: {
            operationsUse: "ready",
            directBookingPublish: "ready",
            marketplacePublish: "not_applicable",
          },
        }
      : null,
    updatedAt: "2026-07-10T10:00:00.000Z",
  };
}

function hotelOperationsTasks(propertyId: string) {
  return [
    setupTask(
      "shared_identity",
      "shared",
      "hotel_catalog",
      "hotel_catalog.shared_identity",
      propertyId,
    ),
    setupTask(
      "rooms_rates_availability",
      "hotel_operations",
      "pms",
      "pms.rooms_rates_availability",
      propertyId,
    ),
    setupTask(
      "guest_settings_policies",
      "hotel_operations",
      "booking",
      "booking.guest_settings_policies",
      propertyId,
    ),
    setupTask("payment", "hotel_operations", "finance", "finance.payment", propertyId),
    setupTask(
      "direct_booking_publication",
      "hotel_operations",
      "distribution",
      "distribution.direct_booking_publication",
      propertyId,
    ),
  ];
}

function setupTask(
  taskId: string,
  track: string,
  requirementOwnerDomain: string,
  destinationRouteKey: string,
  propertyId: string,
) {
  return {
    taskId,
    propertyId,
    track,
    requirementOwnerDomain,
    destinationRouteKey,
    callerCapability: "allowed",
    ownerProgress: "owner_complete",
    readiness: "complete",
    actionableBy: null,
    reasonCodes: [],
    sourceRevision: `${taskId}-1`,
    freshness: "fresh",
    evaluatedAt: "2026-07-10T10:00:00.000Z",
  };
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}
