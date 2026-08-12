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
    const client: BookingAddonItemsPoolClient = {
      async query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
        queries.push({ text, values });
        if (text.includes("WITH direct_property AS")) {
          return {
            rows: [{ propertyId: "d3000000-0000-0000-0000-000000000682" }] as unknown as T[],
          };
        }
        if (text.includes('count(*)::text AS "currentCount"')) {
          return { rows: [{ currentCount: "0" }] as unknown as T[] };
        }
        if (text.includes("INSERT INTO booking.addon_definitions")) {
          return { rows: [{ addonItemId }] as unknown as T[] };
        }
        if (text.includes("WHERE addon_definitions.id = $1::uuid")) {
          return {
            rows: [
              {
                addonItemId,
                propertyId: "d3000000-0000-0000-0000-000000000682",
                name: "Spa ritual",
                description: "Private treatment.",
                category: "wellness",
                pricingModel: "per_guest",
                price: "125.50",
                currency: "EUR",
                publicVisible: true,
                status: "active",
                metadata: { imageUrl: null, duration: null, sortOrder: 3 },
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
      imageUrl: null,
      duration: null,
      pricingModel: "per_guest",
      publicVisible: true,
      status: "active",
      sortOrder: 3,
    });

    expect(result).toMatchObject({
      outcome: "created",
      addonItem: { addonItemId, name: "Spa ritual", sortOrder: 3 },
    });
    const insertIndex = queries.findIndex((query) =>
      query.text.includes("INSERT INTO booking.addon_definitions"),
    );
    const readIndex = queries.findIndex((query) =>
      query.text.includes("WHERE addon_definitions.id = $1::uuid"),
    );
    expect(insertIndex).toBeGreaterThan(-1);
    expect(readIndex).toBeGreaterThan(insertIndex);
    expect(queries[readIndex]?.values).toEqual([addonItemId]);
    expect(queries.at(-1)?.text).toBe("COMMIT");
  });

  it("serializes creation and preserves existing add-ons when the plan cap is reached", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    let released = false;
    const client: BookingAddonItemsPoolClient = {
      async query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
        queries.push({ text, values });
        if (text.includes("WITH direct_property AS")) {
          return {
            rows: [{ propertyId: "d3000000-0000-0000-0000-000000000682" }] as unknown as T[],
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
      imageUrl: null,
      duration: null,
      pricingModel: "per_guest",
      publicVisible: true,
      status: "active",
      sortOrder: 3,
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
          if (text.includes("WITH direct_property AS")) {
            return {
              rows: [{ propertyId: "d3000000-0000-0000-0000-000000000682" }] as unknown as T[],
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
