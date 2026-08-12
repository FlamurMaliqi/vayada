import { describe, expect, it, vi } from "vitest";

import { createPgPropertySetupPmsOwnerRepository } from "./domains/propertySetupPmsOwnerRepository.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const roomTypeId = "33333333-3333-4333-8333-333333333333";

describe("property setup PMS owner repository", () => {
  it("reads exact canonical room and inventory revisions in the authorized scope", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [roomRow()],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [
          {
            authorized: true,
            organizationId,
            propertyId,
            calendarRevision: "4",
            materializedRevision: "4",
          },
        ],
        rowCount: 1,
      });
    const repository = createPgPropertySetupPmsOwnerRepository({
      connectionString: "postgresql://test",
      pool: { query: query as never, end: vi.fn(async () => undefined) },
    });

    await expect(repository.getRoomOwnerSnapshot({ organizationId, propertyId })).resolves.toEqual({
      organizationId,
      propertyId,
      rooms: [
        expect.objectContaining({
          roomTypeId,
          roomFactsRevision: 2,
          roomUnitsRevision: 3,
          activeUnitCount: 2,
          roomMediaRevision: 4,
          mediaAssignmentCount: 1,
          roomAmenitiesRevision: 2,
          amenitiesReviewed: true,
        }),
      ],
    });
    await expect(
      repository.getInventoryOwnerSnapshot({ organizationId, propertyId }),
    ).resolves.toEqual({
      organizationId,
      propertyId,
      calendarRevision: 4,
      materializedRevision: 4,
    });
    for (const [, parameters] of query.mock.calls) {
      expect(parameters).toEqual([organizationId, propertyId]);
    }
  });

  it("represents truthful empty state and fails closed on unavailable or malformed scope", async () => {
    const empty = createPgPropertySetupPmsOwnerRepository({
      connectionString: "postgresql://test",
      pool: {
        query: vi.fn(async () => ({ rows: [emptyRoomSentinel()], rowCount: 1 })) as never,
        end: vi.fn(async () => undefined),
      },
    });
    await expect(empty.getRoomOwnerSnapshot({ organizationId, propertyId })).resolves.toEqual({
      organizationId,
      propertyId,
      rooms: [],
    });

    for (const { rows, message } of [
      {
        rows: [{ ...roomRow(), authorized: false }],
        message: "room scope is unavailable",
      },
      { rows: [{ ...roomRow(), roomFactsRevision: 0 }], message: "room owner result is malformed" },
      {
        rows: [{ ...emptyRoomSentinel(), name: "unexpected" }],
        message: "invalid or mixed sentinel",
      },
      { rows: [roomRow(), roomRow()], message: "room facts are duplicated" },
    ]) {
      const repository = createPgPropertySetupPmsOwnerRepository({
        connectionString: "postgresql://test",
        pool: {
          query: vi.fn(async () => ({ rows, rowCount: rows.length })) as never,
          end: vi.fn(async () => undefined),
        },
      });
      await expect(repository.getRoomOwnerSnapshot({ organizationId, propertyId })).rejects.toThrow(
        message,
      );
    }

    const malformedInventory = createPgPropertySetupPmsOwnerRepository({
      connectionString: "postgresql://test",
      pool: {
        query: vi.fn(async () => ({
          rows: [
            {
              authorized: true,
              organizationId,
              propertyId: null,
              calendarRevision: null,
              materializedRevision: null,
            },
          ],
          rowCount: 1,
        })) as never,
        end: vi.fn(async () => undefined),
      },
    });
    await expect(
      malformedInventory.getInventoryOwnerSnapshot({ organizationId, propertyId }),
    ).rejects.toThrow("inventory owner result is malformed");
  });
});

function emptyRoomSentinel() {
  return {
    authorized: true,
    propertyId: null,
    roomTypeId: null,
    roomFactsRevision: null,
    roomUnitsRevision: null,
    roomMediaRevision: null,
    roomAmenitiesRevision: null,
    activeUnitCount: "0",
    mediaAssignmentCount: "0",
    name: null,
    description: null,
    category: null,
    occupancyLimits: null,
    roomAttributes: null,
    amenitiesReviewedAt: null,
    active: null,
    createdAt: null,
    updatedAt: null,
  };
}

function roomRow() {
  return {
    authorized: true,
    propertyId,
    roomTypeId,
    roomFactsRevision: "2",
    roomUnitsRevision: "3",
    roomMediaRevision: "4",
    roomAmenitiesRevision: "2",
    activeUnitCount: "2",
    mediaAssignmentCount: "1",
    name: "Deluxe Double Room",
    description: "A quiet room with a garden view.",
    category: "deluxe",
    occupancyLimits: { total: 3, adults: 2, children: 1 },
    roomAttributes: {
      beds: [{ type: "queen", quantity: 1 }],
      bedrooms: 1,
      bathrooms: 1,
      bathroomType: "private",
      size: { value: 32.5, unit: "sqm" },
    },
    amenitiesReviewedAt: "2026-08-04T12:00:00.000Z",
    active: true,
    createdAt: "2026-08-04T12:00:00.000Z",
    updatedAt: "2026-08-04T12:00:00.000Z",
  };
}
