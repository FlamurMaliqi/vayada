import { describe, expect, expectTypeOf, it } from "vitest";

import { PMS_INVENTORY_RESERVATION_MARKER_VERSION } from "./index.js";
import {
  PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION,
  PMS_INVENTORY_RESERVATION_LIFECYCLE_IDEMPOTENCY,
  parsePmsInventoryReservationReceipt,
  parsePmsInventoryReservationReleaseCommand,
  parsePmsInventoryReservationReleaseResult,
  parsePmsInventoryReservationReserveCommand,
  parsePmsInventoryReservationReserveResult,
  parsePmsInventoryReservationStatus,
  parsePmsInventoryReservationStatusRequest,
  serializePmsInventoryReservationReleaseFingerprint,
  serializePmsInventoryReservationReserveFingerprint,
  type PmsInventoryReservationLifecyclePort,
  type PmsInventoryReservationReceipt,
  type PmsInventoryReservationStatus,
  type PmsInventoryReservationStatusReadPort,
} from "./inventoryReservationLifecycle.js";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const PROPERTY_ID = "22222222-2222-4222-8222-222222222222";
const ROOM_TYPE_ID = "33333333-3333-4333-8333-333333333333";
const RECEIPT_ID = "44444444-4444-4444-8444-444444444444";
const USER_ID = "55555555-5555-4555-8555-555555555555";

const receipt = Object.freeze({
  contractVersion: PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION,
  owner: "pms" as const,
  receiptId: RECEIPT_ID,
}) satisfies PmsInventoryReservationReceipt;

const configurationSource = Object.freeze({
  ownerDomain: "pms" as const,
  entityType: "pms_operating_calendar.v1" as const,
  entityId: PROPERTY_ID,
  revision: "calendar:3",
});

const audit = Object.freeze({
  actor: Object.freeze({ kind: "user" as const, userId: USER_ID }),
  requestId: "request-1",
  correlationId: "correlation-1",
  requestedAt: "2026-08-03T20:00:00.000Z",
});

function watermark(stayDate: string, inventoryRevision: number) {
  return {
    propertyId: PROPERTY_ID,
    roomTypeId: ROOM_TYPE_ID,
    stayDate,
    calendarRevision: 3,
    inventoryRevision,
    sourceRevisions: { generated: 3, channel: 0, manual: 0, block: 2, booking: 4 },
  };
}

function reserveCommand(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION,
    organizationId: ORGANIZATION_ID,
    propertyId: PROPERTY_ID,
    roomTypeId: ROOM_TYPE_ID,
    checkIn: "2026-08-04",
    checkOut: "2026-08-06",
    roomCount: 2,
    offerCorrelation: {
      quoteSessionId: "quote-session-1",
      publicOfferKey: "public-offer-1",
    },
    configurationSource,
    expectedMaterializedRevision: 3,
    inventoryWatermarks: [watermark("2026-08-04", 8), watermark("2026-08-05", 9)],
    idempotencyKey: "reserve-key-1",
    audit,
    ...overrides,
  };
}

function reservedStatus(overrides: Record<string, unknown> = {}) {
  return {
    receipt,
    organizationId: ORGANIZATION_ID,
    propertyId: PROPERTY_ID,
    roomTypeId: ROOM_TYPE_ID,
    checkIn: "2026-08-04",
    checkOut: "2026-08-06",
    roomCount: 2,
    offerCorrelation: {
      quoteSessionId: "quote-session-1",
      publicOfferKey: "public-offer-1",
    },
    configurationSource,
    materializedRevision: 3,
    reservationWatermarks: [watermark("2026-08-04", 8), watermark("2026-08-05", 9)],
    lifecycleRevision: 1,
    reservedAt: "2026-08-03T20:00:00.000Z",
    state: "reserved",
    ...overrides,
  };
}

function refreshIntent(reason: "reservation_held" | "reservation_released", revision: number) {
  return {
    contractVersion: PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION,
    destination: "distribution.inventory-projection",
    eventType: "pms.inventory.projection_refresh_requested",
    organizationId: ORGANIZATION_ID,
    propertyId: PROPERTY_ID,
    roomTypeId: ROOM_TYPE_ID,
    coverageFrom: "2026-08-04",
    coverageThroughExclusive: "2026-08-06",
    reservationLifecycleRevision: revision,
    reason,
  };
}

describe("PMS inventory reservation lifecycle contract", () => {
  it("freezes independent reserve and release replay semantics", () => {
    expect(PMS_INVENTORY_RESERVATION_LIFECYCLE_IDEMPOTENCY).toEqual({
      operationScope: "pms",
      reserve: {
        operation: "pms.inventory.reserve",
        keyScope: "property",
        authorization: "before_replay",
        exactReplay: "same_receipt_current_state",
        replaySideEffects: "none",
        changedFingerprint: "idempotency_key_conflict",
        inProgress: "command_in_progress",
      },
      release: {
        operation: "pms.inventory.release",
        keyScope: "property",
        authorization: "before_replay",
        exactReplay: "current_terminal_outcome",
        replaySideEffects: "none",
        changedFingerprint: "idempotency_key_conflict",
        inProgress: "command_in_progress",
      },
    });
  });

  it("keeps the new durable receipt opaque and incompatible with the legacy marker", () => {
    expect(parsePmsInventoryReservationReceipt(receipt)).toEqual(receipt);
    expect(
      parsePmsInventoryReservationReceipt({
        contractVersion: PMS_INVENTORY_RESERVATION_MARKER_VERSION,
        owner: "pms",
        source: "booking_engine",
        quoteSessionId: "quote-session-1",
        propertyId: PROPERTY_ID,
        roomTypeId: ROOM_TYPE_ID,
        publicOfferKey: "public-offer-1",
        checkIn: "2026-08-04",
        checkOut: "2026-08-06",
        roomCount: 2,
      }),
    ).toBeNull();
    expect(Object.keys(receipt)).not.toContain("provider");
    expect(Object.keys(receipt)).not.toContain("quoteSessionId");
  });

  it("parses exact full-stay watermarks and serializes a canonical reserve fingerprint", () => {
    const parsed = parsePmsInventoryReservationReserveCommand(
      reserveCommand({
        organizationId: ORGANIZATION_ID.toUpperCase(),
        propertyId: PROPERTY_ID.toUpperCase(),
        roomTypeId: ROOM_TYPE_ID.toUpperCase(),
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      organizationId: ORGANIZATION_ID,
      propertyId: PROPERTY_ID,
      roomTypeId: ROOM_TYPE_ID,
      checkIn: "2026-08-04",
      checkOut: "2026-08-06",
      expectedMaterializedRevision: 3,
    });
    const fingerprint = serializePmsInventoryReservationReserveFingerprint(parsed!);
    const replay = parsePmsInventoryReservationReserveCommand(
      reserveCommand({
        idempotencyKey: "reserve-key-replay",
        audit: { ...audit, requestId: "request-replay" },
      }),
    );
    expect(serializePmsInventoryReservationReserveFingerprint(replay!)).toBe(fingerprint);
    expect(fingerprint).not.toContain("reserve-key");
    expect(fingerprint).not.toContain("request-1");
  });

  it("rejects stale, incomplete, reordered, malformed, and unsafe reserve scope", () => {
    for (const source of [
      reserveCommand({ propertyId: "not-a-uuid" }),
      reserveCommand({ checkOut: "2026-02-29" }),
      reserveCommand({ checkOut: "2026-08-04" }),
      reserveCommand({ checkOut: "2026-08-03" }),
      reserveCommand({ checkIn: "2026-01-01", checkOut: "2027-01-03" }),
      reserveCommand({ roomCount: 501 }),
      reserveCommand({ expectedMaterializedRevision: 4 }),
      reserveCommand({ inventoryWatermarks: [watermark("2026-08-04", 8)] }),
      reserveCommand({
        inventoryWatermarks: [watermark("2026-08-04", 8), watermark("2026-08-04", 9)],
      }),
      reserveCommand({
        inventoryWatermarks: [watermark("2026-08-05", 9), watermark("2026-08-04", 8)],
      }),
      reserveCommand({
        inventoryWatermarks: [
          watermark("2026-08-04", 8),
          { ...watermark("2026-08-05", 9), inventoryRevision: 0 },
        ],
      }),
      reserveCommand({ extra: true }),
    ]) {
      expect(parsePmsInventoryReservationReserveCommand(source)).toBeNull();
    }

    const sparse = reserveCommand().inventoryWatermarks as unknown[];
    delete sparse[1];
    expect(
      parsePmsInventoryReservationReserveCommand(reserveCommand({ inventoryWatermarks: sparse })),
    ).toBeNull();

    expect(parsePmsInventoryReservationReserveCommand(Object.create(reserveCommand()))).toBeNull();
    const accessor = reserveCommand();
    Object.defineProperty(accessor, "roomCount", { enumerable: true, get: () => 2 });
    expect(parsePmsInventoryReservationReserveCommand(accessor)).toBeNull();
  });

  it("binds release fingerprinting to tenant scope and receipt only", () => {
    const parsed = parsePmsInventoryReservationReleaseCommand({
      contractVersion: PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION,
      organizationId: ORGANIZATION_ID,
      propertyId: PROPERTY_ID,
      receipt,
      idempotencyKey: "release-key-1",
      audit,
    });
    expect(parsed).not.toBeNull();
    expect(serializePmsInventoryReservationReleaseFingerprint(parsed!)).toBe(
      JSON.stringify({
        organizationId: ORGANIZATION_ID,
        propertyId: PROPERTY_ID,
        receipt,
      }),
    );
    expect(parsed).not.toHaveProperty("checkIn");
    expect(parsed).not.toHaveProperty("roomCount");
  });

  it("requires tenant scope together with the opaque receipt on status reads", () => {
    expect(
      parsePmsInventoryReservationStatusRequest({
        organizationId: ORGANIZATION_ID,
        propertyId: PROPERTY_ID,
        receipt,
      }),
    ).toEqual({ organizationId: ORGANIZATION_ID, propertyId: PROPERTY_ID, receipt });
    expect(parsePmsInventoryReservationStatusRequest({ receipt })).toBeNull();
    expect(
      parsePmsInventoryReservationStatusRequest({
        organizationId: ORGANIZATION_ID,
        propertyId: PROPERTY_ID,
        receipt,
        receiptIdOnlyLookup: true,
      }),
    ).toBeNull();
  });

  it("parses separate mutable status and disjoint terminal transitions", () => {
    const reserved = parsePmsInventoryReservationStatus(reservedStatus());
    const released = parsePmsInventoryReservationStatus(
      reservedStatus({
        state: "released",
        lifecycleRevision: 2,
        releasedAt: "2026-08-03T20:01:00.000Z",
      }),
    );
    const handedOff = parsePmsInventoryReservationStatus(
      reservedStatus({
        state: "handed_off",
        lifecycleRevision: 2,
        handedOffAt: "2026-08-03T20:01:00.000Z",
      }),
    );
    expect(reserved?.state).toBe("reserved");
    expect(released).toMatchObject({ state: "released", receipt });
    expect(handedOff).toMatchObject({ state: "handed_off", receipt });
    expect(released).not.toHaveProperty("handedOffAt");
    expect(handedOff).not.toHaveProperty("releasedAt");
    expect(
      parsePmsInventoryReservationStatus(
        reservedStatus({
          state: "handed_off",
          lifecycleRevision: 2,
          handedOffAt: "2026-08-03T19:59:59.000Z",
        }),
      ),
    ).toBeNull();
    expect(parsePmsInventoryReservationStatus(reservedStatus({ lifecycleRevision: 2 }))).toBeNull();
    expect(
      parsePmsInventoryReservationStatus(
        reservedStatus({
          state: "released",
          lifecycleRevision: 1,
          releasedAt: "2026-08-03T20:01:00.000Z",
        }),
      ),
    ).toBeNull();
  });

  it("parses accepted reserve and terminal reserve replays without duplicate intents", () => {
    const accepted = parsePmsInventoryReservationReserveResult({
      ok: true,
      outcome: "reserved",
      status: reservedStatus(),
      projectionRefreshIntent: refreshIntent("reservation_held", 1),
    });
    expect(accepted).toMatchObject({ ok: true, outcome: "reserved", status: { receipt } });
    if (!accepted?.ok || accepted.outcome !== "reserved")
      throw new Error("expected reserve success");
    expect(Object.keys(accepted.projectionRefreshIntent)).not.toEqual(
      expect.arrayContaining(["quoteSessionId", "publicOfferKey", "guest", "offerCorrelation"]),
    );
    expect(
      parsePmsInventoryReservationReserveResult({
        ok: true,
        outcome: "already_reserved",
        status: reservedStatus(),
        projectionRefreshIntent: null,
      }),
    ).toMatchObject({
      ok: true,
      outcome: "already_reserved",
      projectionRefreshIntent: null,
    });
    expect(
      parsePmsInventoryReservationReserveResult({
        ok: true,
        outcome: "already_released",
        status: reservedStatus({
          state: "released",
          lifecycleRevision: 2,
          releasedAt: "2026-08-03T20:01:00.000Z",
        }),
        projectionRefreshIntent: null,
      }),
    ).toMatchObject({
      ok: true,
      outcome: "already_released",
      projectionRefreshIntent: null,
    });
    expect(
      parsePmsInventoryReservationReserveResult({
        ok: true,
        outcome: "already_handed_off",
        status: reservedStatus({
          state: "handed_off",
          lifecycleRevision: 2,
          handedOffAt: "2026-08-03T20:01:00.000Z",
        }),
        projectionRefreshIntent: null,
      }),
    ).toMatchObject({
      ok: true,
      outcome: "already_handed_off",
      status: { state: "handed_off", receipt },
      projectionRefreshIntent: null,
    });
  });

  it("parses one release mutation and handed-off release as a typed no-op", () => {
    const releasedStatus = reservedStatus({
      state: "released",
      lifecycleRevision: 2,
      releasedAt: "2026-08-03T20:01:00.000Z",
    });
    expect(
      parsePmsInventoryReservationReleaseResult({
        ok: true,
        outcome: "already_released",
        status: releasedStatus,
        projectionRefreshIntent: null,
      }),
    ).toMatchObject({
      ok: true,
      outcome: "already_released",
      projectionRefreshIntent: null,
    });
    expect(
      parsePmsInventoryReservationReleaseResult({
        ok: true,
        outcome: "released",
        status: releasedStatus,
        projectionRefreshIntent: refreshIntent("reservation_released", 2),
      }),
    ).toMatchObject({ ok: true, outcome: "released", status: { state: "released", receipt } });
    expect(
      parsePmsInventoryReservationReleaseResult({
        ok: true,
        outcome: "already_handed_off",
        status: reservedStatus({
          state: "handed_off",
          lifecycleRevision: 2,
          handedOffAt: "2026-08-03T20:01:00.000Z",
        }),
        projectionRefreshIntent: null,
      }),
    ).toMatchObject({
      ok: true,
      outcome: "already_handed_off",
      projectionRefreshIntent: null,
    });
    expect(
      parsePmsInventoryReservationReleaseResult({
        ok: true,
        outcome: "already_handed_off",
        status: releasedStatus,
        projectionRefreshIntent: null,
      }),
    ).toBeNull();
  });

  it("forbids refresh intents on conflicts, in-progress commands, and failures", () => {
    for (const code of [
      "idempotency_key_conflict",
      "command_in_progress",
      "inventory_unavailable",
    ]) {
      expect(parsePmsInventoryReservationReserveResult({ ok: false, error: { code } })).toEqual({
        ok: false,
        error: { code },
      });
      expect(
        parsePmsInventoryReservationReserveResult({
          ok: false,
          error: { code },
          projectionRefreshIntent: refreshIntent("reservation_held", 1),
        }),
      ).toBeNull();
    }
    for (const code of ["idempotency_key_conflict", "command_in_progress", "receipt_not_found"]) {
      expect(parsePmsInventoryReservationReleaseResult({ ok: false, error: { code } })).toEqual({
        ok: false,
        error: { code },
      });
      expect(
        parsePmsInventoryReservationReleaseResult({
          ok: false,
          error: { code },
          projectionRefreshIntent: refreshIntent("reservation_released", 2),
        }),
      ).toBeNull();
    }
  });

  it("rejects extra, inherited, and accessor data across receipt, status, and results", () => {
    expect(parsePmsInventoryReservationReceipt({ ...receipt, extra: true })).toBeNull();
    expect(parsePmsInventoryReservationStatus({ ...reservedStatus(), extra: true })).toBeNull();
    expect(
      parsePmsInventoryReservationReserveResult({
        ok: false,
        error: { code: "inventory_unavailable", extra: true },
      }),
    ).toBeNull();
    expect(
      parsePmsInventoryReservationReleaseResult(
        Object.create({ ok: false, error: { code: "receipt_not_found" } }),
      ),
    ).toBeNull();
    const accessor = { ...receipt };
    Object.defineProperty(accessor, "receiptId", {
      enumerable: true,
      get: () => RECEIPT_ID,
    });
    expect(parsePmsInventoryReservationReceipt(accessor)).toBeNull();
  });

  it("exposes reserve/release/status only and no transaction surface", () => {
    expectTypeOf<PmsInventoryReservationLifecyclePort>().toHaveProperty("reserveInventory");
    expectTypeOf<PmsInventoryReservationLifecyclePort>().toHaveProperty("releaseInventory");
    expectTypeOf<PmsInventoryReservationLifecyclePort>().not.toHaveProperty("confirmInventory");
    expectTypeOf<PmsInventoryReservationLifecyclePort>().not.toHaveProperty("adoptInventory");
    expectTypeOf<PmsInventoryReservationLifecyclePort>().not.toHaveProperty("transaction");
    expectTypeOf<PmsInventoryReservationStatusReadPort>().toHaveProperty(
      "getInventoryReservationStatus",
    );
    expectTypeOf<PmsInventoryReservationStatus>().toHaveProperty("lifecycleRevision");
  });
});
