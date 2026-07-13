import { describe, expect, it } from "vitest";

import {
  HOTEL_ACTIVE_STATUSES,
  HOTEL_CATALOG_SETUP_FIELDS,
  SHARED_HOTEL_SETUP_NEXT_ACTIONS,
  SHARED_HOTEL_SETUP_PRODUCTS,
  SHARED_HOTEL_SETUP_READ_PERMISSION,
  SHARED_HOTEL_PRODUCTS_MANAGE_PERMISSION,
  SHARED_HOTEL_SETUP_STATUS_CONTRACT_VERSION,
  SHARED_PRODUCT_ACTIVATION_STATUSES,
  SHARED_PROPERTY_ACCESS_RELATIONSHIPS,
  SHARED_PROPERTY_ACCESS_RESOURCE,
  SHARED_PROPERTY_PROFILE_MISSING_FIELDS,
  SHARED_PROPERTY_PROFILE_STATUSES,
  SHARED_PROPERTY_SELECTION_STATES,
  hotelCatalogCommandTypes,
  hotelCatalogIdempotencyKey,
  type HotelCatalogCommand,
  type HotelCatalogCommandBus,
  type HotelCatalogCommandResult,
  type HotelIdentityReadModel,
  type HotelIdentityReadPort,
  type SharedHotelSetupStatus,
  type UpdateHotelNameCommand,
  type UpdateHotelSlugCommand,
} from "./index.js";

describe("@vayada/domain-hotels", () => {
  it("exports the hotel catalog setup fields", () => {
    expect(HOTEL_CATALOG_SETUP_FIELDS).toContain("name");
    expect(HOTEL_CATALOG_SETUP_FIELDS).toContain("slug");
    expect(HOTEL_CATALOG_SETUP_FIELDS).toContain("timezone");
    // currency is intentionally absent — it is owned by @vayada/domain-finance
    expect(HOTEL_CATALOG_SETUP_FIELDS).not.toContain("currency");
  });

  it("exports the hotel active statuses", () => {
    expect(HOTEL_ACTIVE_STATUSES).toContain("active");
    expect(HOTEL_ACTIVE_STATUSES).toContain("suspended");
    expect(HOTEL_ACTIVE_STATUSES).toContain("archived");
  });

  it("exports the hotel catalog command types", () => {
    expect(hotelCatalogCommandTypes).toContain("hotel.catalog.name.update");
    expect(hotelCatalogCommandTypes).toContain("hotel.catalog.slug.update");
  });

  it("exports the shared hotel setup status contract constants", () => {
    expect(SHARED_HOTEL_SETUP_STATUS_CONTRACT_VERSION).toBe("shared-hotel-setup-status.v1");
    expect(SHARED_HOTEL_SETUP_PRODUCTS).toEqual(["booking", "pms", "marketplace"]);
    expect(SHARED_PROPERTY_SELECTION_STATES).toEqual([
      "no_property",
      "single_property",
      "multiple_properties",
    ]);
    expect(SHARED_PROPERTY_PROFILE_STATUSES).toEqual([
      "incomplete",
      "complete",
      "disabled",
      "private",
    ]);
    expect(SHARED_PROPERTY_PROFILE_MISSING_FIELDS).toEqual([
      "displayName",
      "location",
      "website",
      "phone",
      "description",
      "media",
    ]);
    expect(SHARED_PRODUCT_ACTIVATION_STATUSES).toEqual([
      "not_selected",
      "selected_incomplete",
      "active",
      "suspended",
      "unavailable",
    ]);
    expect(SHARED_HOTEL_SETUP_NEXT_ACTIONS).toEqual([
      "create_property",
      "select_property",
      "complete_shared_profile",
      "select_products",
      "complete_product_activation",
      "enter_product",
    ]);
  });

  it("models direct canonical property access for shared setup", () => {
    expect(SHARED_HOTEL_SETUP_READ_PERMISSION).toBe("hotel_catalog.setup.read");
    expect(SHARED_HOTEL_PRODUCTS_MANAGE_PERMISSION).toBe("hotel_catalog.products.manage");
    expect(SHARED_PROPERTY_ACCESS_RESOURCE).toEqual({
      product: "hotel_catalog",
      resourceType: "property",
    });
    expect(SHARED_PROPERTY_ACCESS_RELATIONSHIPS).toEqual(["owner", "operator"]);
  });

  it("keeps shared profile completion separate from product activation", () => {
    const status: SharedHotelSetupStatus = {
      contractVersion: SHARED_HOTEL_SETUP_STATUS_CONTRACT_VERSION,
      entry: { entryProduct: "marketplace", returnTo: "/marketplace" },
      hotelGroup: {
        organizationId: "org_123",
        displayName: "Bali Hospitality Group",
        websiteUrl: null,
        selectedProducts: ["marketplace"],
      },
      selection: {
        state: "single_property",
        selectedPropertyId: "property_123",
      },
      properties: [
        {
          propertyId: "property_123",
          publicId: "alpenrose-resort",
          displayName: "Alpenrose Resort",
          locationSummary: "Bali, Indonesia",
          sharedProfile: {
            status: "complete",
            source: "canonical",
            completionPercent: 100,
            missingFields: [],
          },
          products: {
            booking: {
              product: "booking",
              status: "active",
              missingSteps: [],
              statusReasons: [],
              updatedAt: "2026-06-30T08:00:00.000Z",
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
              status: "selected_incomplete",
              missingSteps: ["creatorPitch", "marketplaceListing"],
              statusReasons: ["marketplace_activation_incomplete"],
              updatedAt: "2026-06-30T08:00:00.000Z",
            },
          },
        },
      ],
      nextAction: {
        action: "complete_product_activation",
        propertyId: "property_123",
        product: "marketplace",
        missingSteps: ["creatorPitch", "marketplaceListing"],
        reasonCodes: ["entry_product_activation_incomplete"],
      },
      updatedAt: "2026-06-30T08:00:00.000Z",
    };

    expect(status.properties[0].sharedProfile.status).toBe("complete");
    expect(status.properties[0].products.marketplace.status).toBe("selected_incomplete");
    expect(status.nextAction.action).toBe("complete_product_activation");
  });

  it("builds a stable idempotency key", () => {
    const key = hotelCatalogIdempotencyKey(
      "hotel.catalog.name.update",
      "prop_abc123",
      "admin-rename-2026-06",
    );
    expect(key).toBe("hotel.catalog.name.update:property:prop_abc123:admin-rename-2026-06");
  });

  it("throws when suffix is an empty string", () => {
    expect(() =>
      hotelCatalogIdempotencyKey("hotel.catalog.name.update", "prop_abc123", ""),
    ).toThrow("hotelCatalogIdempotencyKey: suffix must not be empty or blank");
  });

  it("throws when suffix is blank (whitespace only)", () => {
    expect(() =>
      hotelCatalogIdempotencyKey("hotel.catalog.name.update", "prop_abc123", "   "),
    ).toThrow("hotelCatalogIdempotencyKey: suffix must not be empty or blank");
  });

  it("allows downstream code to implement HotelIdentityReadPort without importing BookingEngineDatabase", async () => {
    const mockIdentity: HotelIdentityReadModel = {
      propertyId: "prop_abc123",
      slug: "grand-hotel-berlin",
      name: "Grand Hotel Berlin",
      timezone: "Europe/Berlin",
      defaultLocale: "en",
      location: { country: "DE", city: "Berlin" },
      status: "active",
      updatedAt: "2026-06-07T10:00:00.000Z",
    };

    const fakePort: HotelIdentityReadPort = {
      async getByPropertyId(propertyId) {
        return propertyId === "prop_abc123" ? mockIdentity : null;
      },
      async getBySlug(slug) {
        return slug === "grand-hotel-berlin" ? mockIdentity : null;
      },
      async batchGetByPropertyId(propertyIds) {
        const result = new Map<string, HotelIdentityReadModel>();
        for (const id of propertyIds) {
          if (id === "prop_abc123") result.set(id, mockIdentity);
        }
        return result;
      },
    };

    const byId = await fakePort.getByPropertyId("prop_abc123");
    expect(byId?.name).toBe("Grand Hotel Berlin");
    expect(byId?.slug).toBe("grand-hotel-berlin");
    expect(byId?.timezone).toBe("Europe/Berlin");

    const bySlug = await fakePort.getBySlug("grand-hotel-berlin");
    expect(bySlug?.propertyId).toBe("prop_abc123");

    const batch = await fakePort.batchGetByPropertyId(["prop_abc123", "prop_missing"]);
    expect(batch.size).toBe(1);
    expect(batch.get("prop_abc123")?.name).toBe("Grand Hotel Berlin");
    expect(batch.has("prop_missing")).toBe(false);

    const missing = await fakePort.getByPropertyId("prop_missing");
    expect(missing).toBeNull();
  });

  it("allows downstream code to implement HotelCatalogCommandBus", async () => {
    const commands: HotelCatalogCommand[] = [];

    const fakeBus: HotelCatalogCommandBus = {
      async execute(command): Promise<HotelCatalogCommandResult> {
        commands.push(command);
        return {
          status: "accepted",
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          propertyId: command.propertyId,
        };
      },
    };

    const nameCommand: UpdateHotelNameCommand = {
      commandType: "hotel.catalog.name.update",
      commandId: "cmd_name_001",
      idempotencyKey: hotelCatalogIdempotencyKey(
        "hotel.catalog.name.update",
        "prop_abc123",
        "rename-001",
      ),
      propertyId: "prop_abc123",
      audit: {
        actor: { kind: "user", userId: "user_123", organizationId: "org_456" },
        requestId: "req_001",
        reason: "Hotel rebranding",
        requestedAt: "2026-06-07T11:00:00.000Z",
      },
      payload: { name: "Grand Hotel Berlin Mitte" },
    };

    const slugCommand: UpdateHotelSlugCommand = {
      commandType: "hotel.catalog.slug.update",
      commandId: "cmd_slug_001",
      idempotencyKey: hotelCatalogIdempotencyKey(
        "hotel.catalog.slug.update",
        "prop_abc123",
        "reslug-001",
      ),
      propertyId: "prop_abc123",
      audit: {
        actor: { kind: "user", userId: "user_123", organizationId: "org_456" },
        requestId: "req_002",
        reason: "Slug update following rename",
        requestedAt: "2026-06-07T11:00:01.000Z",
      },
      payload: {
        slug: "grand-hotel-berlin-mitte",
        previousSlug: "grand-hotel-berlin",
      },
    };

    const nameResult = await fakeBus.execute(nameCommand);
    expect(nameResult.status).toBe("accepted");
    expect(nameResult.propertyId).toBe("prop_abc123");

    const slugResult = await fakeBus.execute(slugCommand);
    expect(slugResult.status).toBe("accepted");

    expect(commands).toHaveLength(2);
    expect(commands[0].commandType).toBe("hotel.catalog.name.update");
    expect(commands[1].commandType).toBe("hotel.catalog.slug.update");
  });
});
