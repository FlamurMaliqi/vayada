import { describe, expect, it } from "vitest";
import { parseDraftRoomId } from "@vayada/domain-pms";

import {
  createPgPmsRoomFactsReadModel,
  pmsRoomFactsSnapshotFromRow,
  type PmsRoomFactsReadPool,
  type PmsRoomFactsRow,
} from "./domains/pmsRoomFactsReadModel.js";

const propertyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const otherPropertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const roomTypeId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const otherRoomTypeId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const draftRoomId = parseDraftRoomId("draft:room.ABC-1")!;
const capturedAt = new Date("2026-08-03T09:30:00.000Z");

type QueryCall = { readonly text: string; readonly values: readonly unknown[] };

function roomFactsRow(overrides: Partial<PmsRoomFactsRow> = {}): PmsRoomFactsRow {
  return {
    propertyId,
    roomTypeId,
    roomFactsRevision: "3",
    active: true,
    name: "Deluxe Double Room",
    description: "A quiet room with a garden view.",
    category: "deluxe",
    occupancyLimits: { total: 3, adults: 2, children: 1 },
    roomAttributes: {
      beds: [
        { type: "queen", quantity: 1 },
        { type: "sofa_bed", quantity: 1 },
      ],
      bedrooms: 1,
      bathrooms: 1,
      bathroomType: "private",
      size: { value: 32.5, unit: "sqm" },
      locationAddress: "PMS-owned but not a room fact",
    },
    createdAt: new Date("2026-08-02T18:30:00.000Z"),
    updatedAt: "2026-08-03T08:15:00.000Z",
    ...overrides,
  };
}

function targetPool(resultSets: readonly (readonly unknown[])[]) {
  const remaining = resultSets.map((rows) => [...rows]);
  const calls: QueryCall[] = [];
  let endCalls = 0;
  const pool: PmsRoomFactsReadPool = {
    async query(text, values = []) {
      calls.push({ text, values });
      const rows = remaining.shift();
      if (!rows) throw new Error("Unexpected PMS room-facts read query");
      return { rows: rows as never[], rowCount: rows.length };
    },
    async end() {
      endCalls += 1;
    },
  };
  return {
    pool,
    calls,
    get endCalls() {
      return endCalls;
    },
  };
}

function readModel(target: ReturnType<typeof targetPool>, now = () => capturedAt) {
  return createPgPmsRoomFactsReadModel({
    connectionString: "postgresql://target.test/vayada",
    pool: target.pool,
    now,
  });
}

describe("PMS room-facts read model", () => {
  it("maps strict room facts without leaking adjacent PMS fields", async () => {
    const target = targetPool([[roomFactsRow()]]);
    const repository = readModel(target);

    const snapshot = await repository.getRoomTypeFacts(
      propertyId.toUpperCase(),
      roomTypeId.toUpperCase(),
    );

    expect(snapshot).toEqual({
      contractVersion: "pms-room-facts.v1",
      propertyId,
      roomTypeId,
      roomFactsRevision: 3,
      lifecycle: "active",
      facts: {
        name: "Deluxe Double Room",
        description: "A quiet room with a garden view.",
        category: "deluxe",
        occupancy: { maxGuests: 3, maxAdults: 2, maxChildren: 1 },
        beds: [
          { type: "queen", quantity: 1 },
          { type: "sofa_bed", quantity: 1 },
        ],
        bedrooms: 1,
        bathrooms: 1,
        bathroomType: "private",
        size: { value: 32.5, unit: "sqm" },
      },
      createdAt: "2026-08-02T18:30:00.000Z",
      updatedAt: "2026-08-03T08:15:00.000Z",
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.facts)).toBe(true);
    expect(Object.isFrozen(snapshot?.facts.beds)).toBe(true);
    expect(target.calls[0]?.values).toEqual([propertyId, roomTypeId]);
    expect(target.calls[0]?.text).toMatch(/room_type\.property_id = \$1::uuid/);
    expect(target.calls[0]?.text).toMatch(/room_type\.id = \$2::uuid/);
    expect(target.calls[0]?.text).not.toMatch(
      /base_rate|currency|amenities_snapshot|media_snapshot/,
    );
  });

  it("maps the active PMS form's explicit legacy room facts", () => {
    const snapshot = pmsRoomFactsSnapshotFromRow(
      roomFactsRow({
        roomAttributes: {
          bedType: "1 King Bed, 2 Single Beds",
          bedrooms: 1,
          bathrooms: 1,
          bathroomType: "private",
          size: 32.5,
        },
      }),
    );

    expect(snapshot.facts).toMatchObject({
      beds: [
        { type: "king_bed", quantity: 1 },
        { type: "single_beds", quantity: 2 },
      ],
      bedrooms: 1,
      bathrooms: 1,
      bathroomType: "private",
      size: { value: 32.5, unit: "sqm" },
    });
    expect(() =>
      pmsRoomFactsSnapshotFromRow(
        roomFactsRow({
          roomAttributes: {
            bedType: "1 King Bed",
            bedrooms: 1,
            bathrooms: 1,
            size: 32.5,
          },
        }),
      ),
    ).toThrow("row failed contract validation");
  });

  it("maps omitted optional guest limits to total occupancy", () => {
    const snapshot = pmsRoomFactsSnapshotFromRow(roomFactsRow({ occupancyLimits: { total: 2 } }));

    expect(snapshot.facts.occupancy).toEqual({
      maxGuests: 2,
      maxAdults: 2,
      maxChildren: 2,
    });
  });

  it("lists active and inactive facts in creation order within one property", async () => {
    const target = targetPool([
      [roomFactsRow(), roomFactsRow({ roomTypeId: otherRoomTypeId, active: false })],
    ]);
    const repository = readModel(target);

    const snapshots = await repository.listRoomTypeFacts(propertyId);

    expect(snapshots.map(({ roomTypeId: id, lifecycle }) => [id, lifecycle])).toEqual([
      [roomTypeId, "active"],
      [otherRoomTypeId, "inactive"],
    ]);
    expect(Object.isFrozen(snapshots)).toBe(true);
    expect(target.calls[0]?.values).toEqual([propertyId]);
    expect(target.calls[0]?.text).toMatch(/ORDER BY room_type\.created_at ASC, room_type\.id ASC/);
  });

  it("fails closed for malformed facts and rows outside the requested property", async () => {
    expect(() =>
      pmsRoomFactsSnapshotFromRow(roomFactsRow({ active: "false" as unknown as boolean })),
    ).toThrow("lifecycle failed contract validation");
    expect(() => pmsRoomFactsSnapshotFromRow(roomFactsRow({ roomFactsRevision: "1e2" }))).toThrow(
      "row failed contract validation",
    );
    expect(() =>
      pmsRoomFactsSnapshotFromRow(roomFactsRow({ createdAt: "2026-02-31T18:30:00.000Z" })),
    ).toThrow("row failed contract validation");

    const target = targetPool([[roomFactsRow({ propertyId: otherPropertyId })]]);
    await expect(readModel(target).getRoomTypeFacts(propertyId, roomTypeId)).rejects.toThrow(
      "escaped its requested scope",
    );
  });

  it("returns null for a missing room type and rejects malformed read scope before SQL", async () => {
    const target = targetPool([[]]);
    const repository = readModel(target);

    await expect(repository.getRoomTypeFacts(propertyId, roomTypeId)).resolves.toBeNull();
    await expect(repository.listRoomTypeFacts("not-a-property-id")).rejects.toThrow(
      "read scope is malformed",
    );
    expect(target.calls).toHaveLength(1);
  });

  it("reads a durable draft binding without excluding inactive tombstones", async () => {
    const target = targetPool([[{ propertyId, draftRoomId, roomTypeId }]]);
    const repository = readModel(target);

    const binding = await repository.getDraftRoomTypeBinding(propertyId, draftRoomId);

    expect(binding).toEqual({ propertyId, draftRoomId, roomTypeId });
    expect(Object.isFrozen(binding)).toBe(true);
    expect(target.calls[0]?.values).toEqual([propertyId, draftRoomId]);
    expect(target.calls[0]?.text).toMatch(/setup_draft_room_id = \$2/);
    expect(target.calls[0]?.text).not.toMatch(/\bactive\b/i);
  });

  it("fails closed when a draft binding does not match the requested durable identity", async () => {
    const wrongProperty = targetPool([[{ propertyId: otherPropertyId, draftRoomId, roomTypeId }]]);
    await expect(
      readModel(wrongProperty).getDraftRoomTypeBinding(propertyId, draftRoomId),
    ).rejects.toThrow("escaped its requested scope");

    const wrongDraft = targetPool([[{ propertyId, draftRoomId: "draft:room.other", roomTypeId }]]);
    await expect(
      readModel(wrongDraft).getDraftRoomTypeBinding(propertyId, draftRoomId),
    ).rejects.toThrow("escaped its requested scope");
  });

  it("maps every valid physical-room status while preserving nullable unverified labels", async () => {
    const rows = [
      {
        propertyId,
        roomTypeId,
        roomUnitId: "10000000-0000-4000-8000-000000000001",
        status: "available",
        operationalLabel: null,
        operationalLabelStatus: "unverified",
      },
      {
        propertyId,
        roomTypeId,
        roomUnitId: "10000000-0000-4000-8000-000000000002",
        status: "maintenance",
        operationalLabel: "M-2",
        operationalLabelStatus: "unverified",
      },
      {
        propertyId,
        roomTypeId,
        roomUnitId: "10000000-0000-4000-8000-000000000003",
        status: "out_of_order",
        operationalLabel: "204",
        operationalLabelStatus: "verified",
      },
      {
        propertyId,
        roomTypeId,
        roomUnitId: "10000000-0000-4000-8000-000000000004",
        status: "retired",
        operationalLabel: null,
        operationalLabelStatus: "unverified",
      },
    ];
    const target = targetPool([rows]);

    const identities = await readModel(target).listPhysicalRoomUnitIdentities(
      propertyId,
      roomTypeId,
    );

    expect(
      identities.map(({ lifecycle, operationalLabel, operationalLabelStatus }) => ({
        lifecycle,
        operationalLabel,
        operationalLabelStatus,
      })),
    ).toEqual([
      { lifecycle: "active", operationalLabel: null, operationalLabelStatus: "unverified" },
      { lifecycle: "active", operationalLabel: "M-2", operationalLabelStatus: "unverified" },
      { lifecycle: "active", operationalLabel: "204", operationalLabelStatus: "verified" },
      { lifecycle: "retired", operationalLabel: null, operationalLabelStatus: "unverified" },
    ]);
    expect(Object.isFrozen(identities)).toBe(true);
    expect(identities.every(Object.isFrozen)).toBe(true);
    expect(target.calls[0]?.values).toEqual([propertyId, roomTypeId]);
    expect(target.calls[0]?.text).toMatch(/room\.property_id = \$1::uuid/);
    expect(target.calls[0]?.text).toMatch(/room\.room_type_id = \$2::uuid/);
  });

  it("rejects unknown physical-room statuses, invalid verified labels, and cross-property rows", async () => {
    const base = {
      propertyId,
      roomTypeId,
      roomUnitId: "10000000-0000-4000-8000-000000000001",
      status: "available",
      operationalLabel: null,
      operationalLabelStatus: "unverified",
    };
    const invalidStatus = targetPool([[{ ...base, status: "occupied" }]]);
    await expect(
      readModel(invalidStatus).listPhysicalRoomUnitIdentities(propertyId, roomTypeId),
    ).rejects.toThrow("invalid status");

    const invalidLabel = targetPool([[{ ...base, operationalLabelStatus: "verified" }]]);
    await expect(
      readModel(invalidLabel).listPhysicalRoomUnitIdentities(propertyId, roomTypeId),
    ).rejects.toThrow("failed contract validation");

    const wrongProperty = targetPool([[{ ...base, propertyId: otherPropertyId }]]);
    await expect(
      readModel(wrongProperty).listPhysicalRoomUnitIdentities(propertyId, roomTypeId),
    ).rejects.toThrow("escaped its requested scope");
  });

  it("counts every non-retired unit independently of operational usability", async () => {
    const target = targetPool([
      [
        {
          propertyId,
          roomTypeId,
          roomUnitsRevision: "7",
          activeUnitCount: 3,
          invalidStatusCount: 0,
        },
      ],
    ]);

    const capacity = await readModel(target).getRoomTypeCapacity(propertyId, roomTypeId);

    expect(capacity).toEqual({
      contractVersion: "pms-room-facts.v1",
      propertyId,
      roomTypeId,
      roomUnitsRevision: 7,
      activeUnitCount: 3,
      capturedAt: "2026-08-03T09:30:00.000Z",
    });
    expect(Object.isFrozen(capacity)).toBe(true);
    expect(target.calls[0]?.values).toEqual([propertyId, roomTypeId]);
    expect(target.calls[0]?.text).toMatch(
      /count\(room\.id\) FILTER \(WHERE room\.status <> 'retired'\)/,
    );
    expect(target.calls[0]?.text).not.toMatch(/operational_label_status/);
  });

  it("fails capacity closed for invalid statuses, malformed counts, and wrong-property rows", async () => {
    const capacityRow = {
      propertyId,
      roomTypeId,
      roomUnitsRevision: 1,
      activeUnitCount: 0,
      invalidStatusCount: 0,
    };
    const invalidStatus = targetPool([[{ ...capacityRow, invalidStatusCount: 1 }]]);
    await expect(
      readModel(invalidStatus).getRoomTypeCapacity(propertyId, roomTypeId),
    ).rejects.toThrow("invalid physical-room status");

    const malformedCount = targetPool([[{ ...capacityRow, activeUnitCount: "1e2" }]]);
    await expect(
      readModel(malformedCount).getRoomTypeCapacity(propertyId, roomTypeId),
    ).rejects.toThrow("failed contract validation");

    const wrongProperty = targetPool([[{ ...capacityRow, propertyId: otherPropertyId }]]);
    await expect(
      readModel(wrongProperty).getRoomTypeCapacity(propertyId, roomTypeId),
    ).rejects.toThrow("escaped its requested scope");
  });

  it("returns null for missing capacity and fails closed for an invalid capture clock", async () => {
    const missing = targetPool([[]]);
    await expect(
      readModel(missing).getRoomTypeCapacity(propertyId, roomTypeId),
    ).resolves.toBeNull();

    const invalidClock = targetPool([
      [
        {
          propertyId,
          roomTypeId,
          roomUnitsRevision: 1,
          activeUnitCount: 0,
          invalidStatusCount: 0,
        },
      ],
    ]);
    await expect(
      readModel(invalidClock, () => new Date(Number.NaN)).getRoomTypeCapacity(
        propertyId,
        roomTypeId,
      ),
    ).rejects.toThrow("failed contract validation");
  });

  it("never closes an injected pool and validates configuration", async () => {
    expect(() => createPgPmsRoomFactsReadModel({ connectionString: " \n" })).toThrow(
      "connectionString must not be empty",
    );

    const target = targetPool([]);
    const repository = readModel(target);
    await repository.close();
    await repository.close();
    expect(target.endCalls).toBe(0);
  });
});
