import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearAuthData, setAuthKitSession } from "../auth/sessionStore";
import { settingsService } from ".";

const originalAuthKitFlag = process.env.NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED;
const originalCompatibilityFlag = process.env.NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED;
const originalApiUrl = process.env.NEXT_PUBLIC_API_URL;

describe("settingsService next-stack bootstrap data", () => {
  beforeEach(() => {
    const storage = createMemoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", { localStorage: storage });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const href = String(url);
        if (href.includes("/api/hotel-setup/status?entryProduct=booking")) {
          return new Response(
            JSON.stringify({
              contractVersion: "shared-hotel-setup-status.v1",
              entry: { entryProduct: "booking", returnTo: null },
              hotelGroup: {
                organizationId: "organization_1",
                displayName: "Alpenrose Hotels",
                websiteUrl: null,
                selectedProducts: ["booking"],
              },
              selection: {
                state: "single_property",
                selectedPropertyId: "property_alpenrose",
              },
              properties: [
                {
                  propertyId: "property_alpenrose",
                  publicId: "hotel-alpenrose",
                  displayName: "Hotel Alpenrose",
                  locationSummary: "Innsbruck, AT",
                  sharedProfile: {
                    status: "incomplete",
                    source: "canonical",
                    completionPercent: 33,
                    missingFields: ["website", "phone", "description", "media"],
                  },
                  products: {
                    booking: {
                      product: "booking",
                      status: "selected_incomplete",
                      missingSteps: ["bookingSettings"],
                      statusReasons: ["booking_activation_incomplete"],
                      updatedAt: null,
                    },
                    pms: {
                      product: "pms",
                      status: "not_selected",
                      missingSteps: [],
                      statusReasons: [],
                      updatedAt: null,
                    },
                    marketplace: {
                      product: "marketplace",
                      status: "not_selected",
                      missingSteps: [],
                      statusReasons: [],
                      updatedAt: null,
                    },
                  },
                },
              ],
              nextAction: {
                action: "complete_product_activation",
                propertyId: "property_alpenrose",
                product: "booking",
                missingSteps: ["bookingSettings"],
                reasonCodes: ["entry_product_activation_incomplete"],
              },
              updatedAt: "2026-07-10T10:00:00.000Z",
            }),
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
        if (href.endsWith("/api/booking/hotels/booking_hotel_alpenrose/settings/property")) {
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
        productReady: true,
        name: "Hotel Alpenrose",
        slug: "hotel-alpenrose",
        location: "Innsbruck, AT",
        country: "",
      },
    ]);
    localStorage.setItem("selectedHotelId", "booking_hotel_alpenrose");
    await expect(settingsService.getSetupStatus()).resolves.toMatchObject({
      setup_complete: true,
      missing_fields: [],
    });
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
    expect(fetch).toHaveBeenCalledTimes(8);
    expect(fetch).toHaveBeenLastCalledWith(
      expect.stringMatching(/\/api\/booking\/hotels\/booking_hotel_alpenrose\/settings\/property$/),
      expect.objectContaining({ method: "PATCH" }),
    );
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
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
