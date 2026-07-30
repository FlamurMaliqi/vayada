import { describe, expect, it } from "vitest";

import {
  HOTEL_ACTIVE_STATUSES,
  HOTEL_CATALOG_SETUP_FIELDS,
  PROPERTY_MEDIA_AUTHORIZATION,
  SHARED_PROPERTY_TYPE_OPTIONS,
  createPropertyMediaProjectionInput,
  hotelCatalogCommandTypes,
  hotelCatalogIdempotencyKey,
  parsePropertyMediaCommandResponse,
  type HotelCatalogCommand,
  type HotelCatalogCommandBus,
  type HotelCatalogCommandResult,
  type HotelIdentityReadModel,
  type HotelIdentityReadPort,
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

  it("exports the shared property type catalog", () => {
    expect(SHARED_PROPERTY_TYPE_OPTIONS).toContainEqual({ value: "hotel", label: "Hotel" });
    expect(SHARED_PROPERTY_TYPE_OPTIONS).toContainEqual({ value: "other", label: "Other" });
  });

  it("exports the canonical property media authorization contract", () => {
    expect(PROPERTY_MEDIA_AUTHORIZATION.product).toBe("hotel_catalog");
    expect(PROPERTY_MEDIA_AUTHORIZATION.resourceType).toBe("property");
    expect(createPropertyMediaProjectionInput).toBeTypeOf("function");
    expect(parsePropertyMediaCommandResponse).toBeTypeOf("function");
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
