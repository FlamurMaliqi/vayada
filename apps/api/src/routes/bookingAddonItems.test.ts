import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  createPgTargetBookingAddonItemsRepository,
  type BookingAddonItemsPool,
  type BookingAddonItemsPoolClient,
} from "./bookingAddonItems.js";

describe("target booking add-on plan enforcement", () => {
  it("reads a newly created add-on in a separate statement before committing", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const addonItemId = "d3000000-0000-0000-0000-000000000683";
    const mediaObjectId = "d3000000-0000-4000-8000-000000000684";
    let persistedMetadata: unknown;
    const client: BookingAddonItemsPoolClient = {
      async query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
        queries.push({ text, values });
        if (text.includes("FROM pms.property_pricing_settings"))
          return {
            rows: [
              {
                propertyId: "d3000000-0000-4000-8000-000000000682",
                currency: "EUR",
                pricingCurrencyRevision: 1,
                createdAt: "2026-08-11T10:00:00.000Z",
                updatedAt: "2026-08-11T10:00:00.000Z",
              },
            ] as unknown as T[],
          };
        if (text.includes("WITH direct_property AS")) {
          return {
            rows: [{ propertyId: "d3000000-0000-4000-8000-000000000682" }] as unknown as T[],
          };
        }
        if (text.includes('count(*)::text AS "currentCount"')) {
          return { rows: [{ currentCount: "0" }] as unknown as T[] };
        }
        if (text.includes("FROM platform.media_objects media")) {
          return {
            rows: [
              {
                mediaObjectId: values?.[0],
                imageUrl: `https://media.example.test/${values?.[0]}.webp`,
              },
            ] as unknown as T[],
          };
        }
        if (text.includes('AS "nextOrder"')) return { rows: [{ nextOrder: 3 }] as unknown as T[] };
        if (text.includes("INSERT INTO booking.addon_definitions")) {
          persistedMetadata = JSON.parse(String(values?.[11]));
          return { rows: [{ addonItemId }] as unknown as T[] };
        }
        if (text.includes("WHERE addon_definitions.id = $1::uuid")) {
          return {
            rows: [
              {
                addonItemId,
                propertyId: "d3000000-0000-4000-8000-000000000682",
                name: "Spa ritual",
                description: "Private treatment.",
                category: "wellness",
                pricingModel: "per_guest",
                price: "125.50",
                currency: "EUR",
                publicVisible: true,
                status: "active",
                ownershipKind: "property",
                partnerCommissionRate: null,
                metadata: persistedMetadata,
                createdAt: "2026-08-11T10:00:00.000Z",
                updatedAt: "2026-08-11T10:00:00.000Z",
              },
            ] as unknown as T[],
          };
        }
        return { rows: [] as T[] };
      },
      release() {},
    };
    const repository = createPgTargetBookingAddonItemsRepository({
      connectionString: "postgresql://target-db",
      pool: {
        async query() {
          throw new Error("Creation must use one transaction client");
        },
        async connect() {
          return client;
        },
      },
    });

    const result = await repository.createAddonItemByHotelId("booking_hotel_alpenrose", {
      name: "Spa ritual",
      description: "Private treatment.",
      price: "125.50",
      currency: "EUR",
      category: "wellness",
      imageMediaObjectId: null,
      photos: [
        {
          mediaObjectId: "d3000000-0000-4000-8000-000000000685",
          imageUrl: "ignored",
          isCover: false,
        },
        { mediaObjectId, imageUrl: "ignored", isCover: true },
      ],
      maxQuantity: 2,
      maxGuests: 6,
      leadTime: "24h before",
      location: "Lobby",
      duration: null,
      pricingModel: "per_guest",
      publicVisible: true,
      status: "active",
      sortOrder: 3,
      ownershipKind: "property",
      partnerCommissionRate: null,
    });

    expect(result).toMatchObject({
      outcome: "created",
      addonItem: {
        addonItemId,
        name: "Spa ritual",
        sortOrder: 3,
        imageMediaObjectId: mediaObjectId,
        ownershipKind: "property",
        partnerCommissionRate: null,
      },
    });
    expect(persistedMetadata).toMatchObject({
      maxQuantity: 2,
      maxGuests: 6,
      leadTime: "24h before",
      location: "Lobby",
      sortOrder: 3,
      mediaObjectId,
    });
    expect(result?.outcome === "created" && result.addonItem.photos).toEqual([
      {
        mediaObjectId: "d3000000-0000-4000-8000-000000000685",
        imageUrl: "https://media.example.test/d3000000-0000-4000-8000-000000000685.webp",
        isCover: false,
      },
      {
        mediaObjectId,
        imageUrl: `https://media.example.test/${mediaObjectId}.webp`,
        isCover: true,
      },
    ]);
    const insertIndex = queries.findIndex((query) =>
      query.text.includes("INSERT INTO booking.addon_definitions"),
    );
    const readIndex = queries.findIndex((query) =>
      query.text.includes("WHERE addon_definitions.id = $1::uuid"),
    );
    expect(insertIndex).toBeGreaterThan(-1);
    expect(readIndex).toBeGreaterThan(insertIndex);
    expect(queries[insertIndex]?.values?.slice(9, 11)).toEqual(["property", null]);
    expect(queries[insertIndex]?.values?.[11]).toContain(mediaObjectId);
    expect(queries[readIndex]?.values).toEqual([addonItemId]);
    const mediaLookup = queries.find((query) =>
      query.text.includes("FROM platform.media_objects media"),
    );
    expect(mediaLookup?.text).toContain("'public/media/' || media.id::text");
    expect(mediaLookup?.text).toContain("variant.storage_key = media.storage_key");
    expect(mediaLookup?.text).toContain("substring(variant.storage_key FROM 8)");
    expect(queries.at(-1)?.text).toBe("COMMIT");
  });

  it("rejects an add-on image outside the canonical active media registry", async () => {
    const client: BookingAddonItemsPoolClient = {
      async query<T extends QueryResultRow = QueryResultRow>(text: string) {
        if (text.includes("FROM pms.property_pricing_settings"))
          return {
            rows: [
              {
                propertyId: "d3000000-0000-4000-8000-000000000682",
                currency: "EUR",
                pricingCurrencyRevision: 1,
                createdAt: "2026-08-11T10:00:00.000Z",
                updatedAt: "2026-08-11T10:00:00.000Z",
              },
            ] as unknown as T[],
          };
        if (text.includes("WITH direct_property AS"))
          return {
            rows: [{ propertyId: "d3000000-0000-4000-8000-000000000682" }] as unknown as T[],
          };
        if (text.includes('count(*)::text AS "currentCount"'))
          return { rows: [{ currentCount: "0" }] as unknown as T[] };
        return { rows: [] as T[] };
      },
      release() {},
    };
    const repository = createPgTargetBookingAddonItemsRepository({
      connectionString: "postgresql://target-db",
      pool: {
        async query() {
          return { rows: [] };
        },
        async connect() {
          return client;
        },
      },
    });

    await expect(
      repository.createAddonItemByHotelId("booking_hotel_alpenrose", {
        name: "Spa ritual",
        description: "Private treatment.",
        price: "125.50",
        currency: "EUR",
        category: "wellness",
        imageMediaObjectId: "d3000000-0000-4000-8000-000000000699",
        duration: null,
        pricingModel: "per_guest",
        publicVisible: true,
        status: "active",
        sortOrder: 0,
        ownershipKind: "property",
        partnerCommissionRate: null,
      }),
    ).rejects.toThrow("active approved add-on image for this property");
  });

  it("serializes creation and preserves existing add-ons when the plan cap is reached", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    let released = false;
    const client: BookingAddonItemsPoolClient = {
      async query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
        queries.push({ text, values });
        if (text.includes("FROM pms.property_pricing_settings"))
          return {
            rows: [
              {
                propertyId: "d3000000-0000-4000-8000-000000000682",
                currency: "EUR",
                pricingCurrencyRevision: 1,
                createdAt: "2026-08-11T10:00:00.000Z",
                updatedAt: "2026-08-11T10:00:00.000Z",
              },
            ] as unknown as T[],
          };
        if (text.includes("WITH direct_property AS")) {
          return {
            rows: [{ propertyId: "d3000000-0000-4000-8000-000000000682" }] as unknown as T[],
          };
        }
        if (text.includes('count(*)::text AS "currentCount"')) {
          return { rows: [{ currentCount: "3" }] as unknown as T[] };
        }
        return { rows: [] as T[] };
      },
      release() {
        released = true;
      },
    };
    const pool: BookingAddonItemsPool = {
      async query() {
        throw new Error("Creation must use one transaction client");
      },
      async connect() {
        return client;
      },
    };
    const repository = createPgTargetBookingAddonItemsRepository({
      connectionString: "postgresql://target-db",
      pool,
    });

    const result = await repository.createAddonItemByHotelId("booking_hotel_alpenrose", {
      name: "Spa ritual",
      description: "Private treatment.",
      price: "125.50",
      currency: "EUR",
      category: "wellness",
      imageMediaObjectId: null,
      duration: null,
      pricingModel: "per_guest",
      publicVisible: true,
      status: "active",
      sortOrder: 3,
      ownershipKind: "property",
      partnerCommissionRate: null,
    });

    expect(result).toMatchObject({
      outcome: "plan_limit_reached",
      currentCount: 3,
      propertyPlan: { plan: "commission", limits: { maxAddons: 3 } },
    });
    expect(queries.map((query) => query.text)).toContain("BEGIN");
    expect(queries.some((query) => query.text.includes("FOR UPDATE"))).toBe(true);
    expect(
      queries.some((query) => query.text.includes("INSERT INTO booking.addon_definitions")),
    ).toBe(false);
    expect(queries.at(-1)?.text).toBe("COMMIT");
    expect(released).toBe(true);
  });

  it("does not reactivate retired add-ons through the update path", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const repository = createPgTargetBookingAddonItemsRepository({
      connectionString: "postgresql://target-db",
      pool: {
        async query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
          queries.push({ text, values });
          if (text.includes("FROM pms.property_pricing_settings"))
            return {
              rows: [
                {
                  propertyId: "d3000000-0000-4000-8000-000000000682",
                  currency: "EUR",
                  pricingCurrencyRevision: 1,
                  createdAt: "2026-08-11T10:00:00.000Z",
                  updatedAt: "2026-08-11T10:00:00.000Z",
                },
              ] as unknown as T[],
            };
          if (text.includes("WITH direct_property AS")) {
            return {
              rows: [{ propertyId: "d3000000-0000-4000-8000-000000000682" }] as unknown as T[],
            };
          }
          return { rows: [] as T[] };
        },
      },
    });

    await expect(
      repository.updateAddonItemByHotelId(
        "booking_hotel_alpenrose",
        "d3000000-0000-0000-0000-000000000683",
        { status: "active" },
      ),
    ).resolves.toBeNull();

    const update = queries.find((query) => query.text.includes("UPDATE booking.addon_definitions"));
    expect(update?.text).toContain("status <> 'retired'");
  });
});
