import { describe, expect, it } from "vitest";

import {
  PMS_ROOM_FACTS_CONTRACT_VERSION,
  type DraftRoomTypeBindingReadPort,
  type PhysicalRoomUnitIdentityReadPort,
  type RoomCapacityReadPort,
  type RoomFactsCommandPort,
  type RoomFactsReadPort,
  type RoomFactsVocabularyValidationPort,
  type SafeDeleteRoomTypeError,
  parseCreateRoomTypeFactsCommand,
  parseCreateRoomTypeFactsResult,
  parseDraftRoomId,
  parseDraftRoomTypeBinding,
  parsePhysicalRoomUnitIdentity,
  parseRoomTypeFacts,
  parseRoomTypeFactsSnapshot,
  parseRoomTypeCapacitySnapshot,
  parseSafeDeleteRoomTypeCommand,
  parseSafeDeleteRoomTypeResult,
  parseUpdateRoomTypeFactsCommand,
  parseUpdateRoomTypeFactsResult,
  serializeCreateRoomTypeFactsFingerprint,
  serializeSafeDeleteRoomTypeFingerprint,
  serializeUpdateRoomTypeFactsFingerprint,
} from "./roomFacts.js";

const organizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const propertyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const roomTypeId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const mediaObjectId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const userId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const draftRoomId = "draft:room.ABC-1";
const now = "2026-08-02T18:30:00.000Z";

function facts() {
  return {
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
  };
}

function commandContext() {
  return {
    organizationId: organizationId.toUpperCase(),
    propertyId: propertyId.toUpperCase(),
    idempotencyKey: "room-facts-create-1",
    audit: {
      actor: { kind: "user", userId: userId.toUpperCase() },
      requestId: "req_room_facts_1",
      correlationId: "corr_room_facts_1",
      requestedAt: now,
    },
  };
}

function snapshot() {
  return {
    contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
    propertyId,
    roomTypeId,
    roomFactsRevision: 1,
    lifecycle: "active",
    facts: facts(),
    createdAt: now,
    updatedAt: now,
  };
}

function createSuccessResult() {
  return {
    ok: true,
    response: {
      contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
      outcome: "created",
      roomType: snapshot(),
      draftRoomBinding: { propertyId, draftRoomId, roomTypeId },
      acceptedAt: now,
    },
  };
}

function updateSuccessResult() {
  return {
    ok: true,
    response: {
      contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
      outcome: "updated",
      roomType: { ...snapshot(), roomFactsRevision: 2, updatedAt: now },
      acceptedAt: now,
    },
  };
}

function deleteSuccessResult() {
  return {
    ok: true,
    response: {
      contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
      outcome: "deleted",
      propertyId,
      roomTypeId,
      lifecycle: "inactive",
      deletedRevision: 2,
      acceptedAt: now,
    },
  };
}

describe("PMS room-facts commands", () => {
  it("accepts a facts-only create and freezes detached normalized command data", () => {
    const source = {
      ...commandContext(),
      draftRoomId,
      expectedRevision: 0,
      facts: facts(),
    };

    const parsed = parseCreateRoomTypeFactsCommand(source);

    expect(parsed).not.toBeNull();
    expect(parsed?.organizationId).toBe(organizationId);
    expect(parsed?.propertyId).toBe(propertyId);
    expect(parsed?.draftRoomId).toBe(draftRoomId);
    expect(parseDraftRoomId(draftRoomId)).toBe(draftRoomId);
    expect(parsed?.audit.actor).toEqual({ kind: "user", userId });
    expect(parsed?.facts.beds).toEqual([
      { type: "queen", quantity: 1 },
      { type: "sofa_bed", quantity: 1 },
    ]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed?.audit)).toBe(true);
    expect(Object.isFrozen(parsed?.audit.actor)).toBe(true);
    expect(Object.isFrozen(parsed?.facts)).toBe(true);
    expect(Object.isFrozen(parsed?.facts.occupancy)).toBe(true);
    expect(Object.isFrozen(parsed?.facts.beds)).toBe(true);
    expect(Object.isFrozen(parsed?.facts.beds[0])).toBe(true);

    source.facts.beds[0]!.quantity = 9;
    expect(parsed?.facts.beds[0]?.quantity).toBe(1);
  });

  it("rejects physical-unit, pricing, calendar, media, and amenity coupling", () => {
    const create = { ...commandContext(), draftRoomId, expectedRevision: 0, facts: facts() };

    for (const extra of [
      { unitCount: 3 },
      { units: [{ operationalLabel: "204" }] },
      { baseRate: { amountDecimal: "120.00", currency: "EUR" } },
      { initialAvailability: 3 },
      { mediaObjectIds: [mediaObjectId] },
      { amenityKeys: ["wifi"] },
    ]) {
      expect(parseCreateRoomTypeFactsCommand({ ...create, ...extra })).toBeNull();
    }

    expect(
      parseCreateRoomTypeFactsCommand({
        ...create,
        facts: { ...facts(), unitCount: 3 },
      }),
    ).toBeNull();
    expect(parseCreateRoomTypeFactsCommand({ ...create, draftRoomId: undefined })).toBeNull();
    expect(
      parseCreateRoomTypeFactsCommand({ ...create, draftRoomId: `x${"a".repeat(128)}` }),
    ).toBeNull();
    expect(parseCreateRoomTypeFactsCommand({ ...create, draftRoomId: ":room" })).toBeNull();
    expect(parseDraftRoomId("")).toBeNull();
    expect(parseDraftRoomId(`x${"a".repeat(128)}`)).toBeNull();
    expect(parseCreateRoomTypeFactsCommand({ ...create, expectedRevision: 1 })).toBeNull();
  });

  it("requires positive expected revisions for full-facts updates and safe deletes", () => {
    const update = parseUpdateRoomTypeFactsCommand({
      ...commandContext(),
      roomTypeId: roomTypeId.toUpperCase(),
      expectedRevision: 4,
      facts: facts(),
    });
    const deletion = parseSafeDeleteRoomTypeCommand({
      ...commandContext(),
      roomTypeId: roomTypeId.toUpperCase(),
      expectedRevision: 4,
    });

    expect(update?.roomTypeId).toBe(roomTypeId);
    expect(update?.expectedRevision).toBe(4);
    expect(deletion?.roomTypeId).toBe(roomTypeId);
    expect(deletion?.expectedRevision).toBe(4);
    expect(
      parseUpdateRoomTypeFactsCommand({
        ...commandContext(),
        roomTypeId,
        expectedRevision: 0,
        facts: facts(),
      }),
    ).toBeNull();
    expect(
      parseSafeDeleteRoomTypeCommand({
        ...commandContext(),
        roomTypeId,
        expectedRevision: 0,
      }),
    ).toBeNull();
  });

  it("validates stable key shape and fact invariants without inventing a closed catalog", () => {
    expect(parseRoomTypeFacts({ ...facts(), category: "custom-loft" })).not.toBeNull();
    expect(
      parseRoomTypeFacts({ ...facts(), beds: [{ type: "wall.bed", quantity: 1 }] }),
    ).not.toBeNull();

    for (const invalidFacts of [
      { ...facts(), name: " Deluxe Double Room" },
      { ...facts(), category: "Luxury Room" },
      { ...facts(), category: "suite__annex" },
      { ...facts(), occupancy: { maxGuests: 4, maxAdults: 2, maxChildren: 1 } },
      { ...facts(), occupancy: { maxGuests: 2, maxAdults: 3, maxChildren: 0 } },
      { ...facts(), beds: [] },
      { ...facts(), beds: [{ type: "Water Bed", quantity: 1 }] },
      {
        ...facts(),
        beds: [
          { type: "queen", quantity: 1 },
          { type: "queen", quantity: 1 },
        ],
      },
      { ...facts(), bathroomType: "shared", bathrooms: 1 },
      { ...facts(), size: { value: 0, unit: "sqm" } },
      { ...facts(), size: { value: 30, unit: "sqft" } },
    ]) {
      expect(parseRoomTypeFacts(invalidFacts)).toBeNull();
    }
  });

  it("requires strict idempotency and audit context", () => {
    const create = { ...commandContext(), draftRoomId, expectedRevision: 0, facts: facts() };

    expect(parseCreateRoomTypeFactsCommand({ ...create, idempotencyKey: "" })).toBeNull();
    expect(parseCreateRoomTypeFactsCommand({ ...create, idempotencyKey: " key " })).toBeNull();
    expect(
      parseCreateRoomTypeFactsCommand({
        ...create,
        audit: { ...create.audit, actor: { kind: "guest", userId } },
      }),
    ).toBeNull();
    expect(
      parseCreateRoomTypeFactsCommand({
        ...create,
        audit: { ...create.audit, requestedAt: "not-a-time" },
      }),
    ).toBeNull();
    for (const invalidCalendarTime of ["2026-02-31T12:00:00Z", "2026-08-02T24:00:00Z"]) {
      expect(
        parseCreateRoomTypeFactsCommand({
          ...create,
          audit: { ...create.audit, requestedAt: invalidCalendarTime },
        }),
      ).toBeNull();
    }
    expect(
      parseCreateRoomTypeFactsCommand({
        ...create,
        audit: { ...create.audit, requestedAt: "2026-08-02T18:30:00Z" },
      }),
    ).not.toBeNull();
  });

  it("serializes exact business fingerprints and excludes replay transport metadata", () => {
    const create = parseCreateRoomTypeFactsCommand({
      ...commandContext(),
      draftRoomId,
      expectedRevision: 0,
      facts: facts(),
    })!;
    const replayCreate = parseCreateRoomTypeFactsCommand({
      ...commandContext(),
      idempotencyKey: "a-different-transport-key",
      audit: {
        ...commandContext().audit,
        requestId: "a-different-request",
        requestedAt: "2026-08-02T18:31:00.000Z",
      },
      draftRoomId,
      expectedRevision: 0,
      facts: facts(),
    })!;
    const update = parseUpdateRoomTypeFactsCommand({
      ...commandContext(),
      roomTypeId,
      expectedRevision: 4,
      facts: facts(),
    })!;
    const deletion = parseSafeDeleteRoomTypeCommand({
      ...commandContext(),
      roomTypeId,
      expectedRevision: 4,
    })!;
    const reorderedCreate = parseCreateRoomTypeFactsCommand({
      ...commandContext(),
      draftRoomId,
      expectedRevision: 0,
      facts: { ...facts(), beds: [...facts().beds].reverse() },
    })!;
    const factsJson =
      '{"name":"Deluxe Double Room","description":"A quiet room with a garden view.","category":"deluxe","occupancy":{"maxGuests":3,"maxAdults":2,"maxChildren":1},"beds":[{"type":"queen","quantity":1},{"type":"sofa_bed","quantity":1}],"bedrooms":1,"bathrooms":1,"bathroomType":"private","size":{"value":32.5,"unit":"sqm"}}';
    const createFingerprint = serializeCreateRoomTypeFactsFingerprint(create);

    expect(createFingerprint).toBe(
      `{"organizationId":"${organizationId}","propertyId":"${propertyId}","draftRoomId":"${draftRoomId}","expectedRevision":0,"facts":${factsJson}}`,
    );
    expect(serializeCreateRoomTypeFactsFingerprint(replayCreate)).toBe(createFingerprint);
    const reorderedFingerprint = serializeCreateRoomTypeFactsFingerprint(reorderedCreate);
    expect(reorderedFingerprint).not.toBe(createFingerprint);
    expect(reorderedFingerprint.indexOf('"type":"sofa_bed"')).toBeLessThan(
      reorderedFingerprint.indexOf('"type":"queen"'),
    );
    expect(serializeUpdateRoomTypeFactsFingerprint(update)).toBe(
      `{"organizationId":"${organizationId}","propertyId":"${propertyId}","roomTypeId":"${roomTypeId}","expectedRevision":4,"facts":${factsJson}}`,
    );
    expect(serializeSafeDeleteRoomTypeFingerprint(deletion)).toBe(
      `{"organizationId":"${organizationId}","propertyId":"${propertyId}","roomTypeId":"${roomTypeId}","expectedRevision":4}`,
    );
  });

  it("requires a PMS-owned supported-vocabulary check after token-shape parsing", async () => {
    const parsedFacts = parseRoomTypeFacts({
      ...facts(),
      category: "custom-loft",
      beds: [{ type: "wall.bed", quantity: 1 }],
    })!;
    const vocabularyPort: RoomFactsVocabularyValidationPort = {
      async validateRoomFactsVocabulary(request) {
        return {
          ok: false,
          error: {
            code: "unsupported_room_fact_keys",
            unsupportedCategoryKeys: request.category ? [request.category] : [],
            unsupportedBedTypeKeys: request.bedTypeKeys,
          },
        };
      },
    };

    await expect(
      vocabularyPort.validateRoomFactsVocabulary({
        category: parsedFacts.category,
        bedTypeKeys: parsedFacts.beds.map(({ type }) => type),
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "unsupported_room_fact_keys",
        unsupportedCategoryKeys: ["custom-loft"],
        unsupportedBedTypeKeys: ["wall.bed"],
      },
    });
  });
});

describe("PMS room-facts result wire parsers", () => {
  it("parses and deeply freezes each operation-specific success response", () => {
    const createSource = createSuccessResult();
    const created = parseCreateRoomTypeFactsResult(createSource);
    const updated = parseUpdateRoomTypeFactsResult(updateSuccessResult());
    const deleted = parseSafeDeleteRoomTypeResult(deleteSuccessResult());

    expect(created).toEqual(createSource);
    expect(updated).toEqual(updateSuccessResult());
    expect(deleted).toEqual(deleteSuccessResult());
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created && created.ok ? created.response : null)).toBe(true);
    expect(Object.isFrozen(created && created.ok ? created.response.draftRoomBinding : null)).toBe(
      true,
    );
    expect(Object.isFrozen(created && created.ok ? created.response.roomType : null)).toBe(true);
    expect(Object.isFrozen(created && created.ok ? created.response.roomType.facts : null)).toBe(
      true,
    );
    expect(Object.isFrozen(updated)).toBe(true);
    expect(Object.isFrozen(updated && updated.ok ? updated.response : null)).toBe(true);
    expect(Object.isFrozen(deleted)).toBe(true);
    expect(Object.isFrozen(deleted && deleted.ok ? deleted.response : null)).toBe(true);
    expect(deleted && deleted.ok ? deleted.response.lifecycle : null).toBe("inactive");
    expect(deleted && deleted.ok ? deleted.response.deletedRevision : null).toBe(2);

    createSource.response.draftRoomBinding.roomTypeId = mediaObjectId;
    expect(created && created.ok ? created.response.draftRoomBinding.roomTypeId : null).toBe(
      roomTypeId,
    );
  });

  it("parses only the conflicts and coordination errors valid for each operation", () => {
    const bindingConflict = parseCreateRoomTypeFactsResult({
      ok: false,
      error: {
        code: "draft_room_binding_conflict",
        roomTypeId: roomTypeId.toUpperCase(),
        currentRevision: 3,
      },
    });
    const updateConflict = parseUpdateRoomTypeFactsResult({
      ok: false,
      error: { code: "room_facts_revision_conflict", currentRevision: 4 },
    });
    const unsupportedCreate = parseCreateRoomTypeFactsResult({
      ok: false,
      error: {
        code: "unsupported_room_fact_keys",
        unsupportedCategoryKeys: ["custom-loft"],
        unsupportedBedTypeKeys: ["wall.bed"],
      },
    });
    const deleteBlocked = parseSafeDeleteRoomTypeResult({
      ok: false,
      error: {
        code: "room_type_delete_blocked",
        currentRevision: 4,
        blockers: [
          { code: "booking_reference", affectedCount: 2 },
          { code: "assigned_physical_unit", affectedCount: 1 },
          { code: "reference_check_unavailable" },
        ],
      },
    });

    expect(bindingConflict).toEqual({
      ok: false,
      error: { code: "draft_room_binding_conflict", roomTypeId, currentRevision: 3 },
    });
    expect(updateConflict).toEqual({
      ok: false,
      error: { code: "room_facts_revision_conflict", currentRevision: 4 },
    });
    expect(unsupportedCreate).toEqual({
      ok: false,
      error: {
        code: "unsupported_room_fact_keys",
        unsupportedCategoryKeys: ["custom-loft"],
        unsupportedBedTypeKeys: ["wall.bed"],
      },
    });
    expect(deleteBlocked).not.toBeNull();
    expect(Object.isFrozen(bindingConflict)).toBe(true);
    expect(
      Object.isFrozen(bindingConflict && !bindingConflict.ok ? bindingConflict.error : null),
    ).toBe(true);
    expect(
      Object.isFrozen(updateConflict && !updateConflict.ok ? updateConflict.error : null),
    ).toBe(true);
    const unsupportedError =
      unsupportedCreate &&
      !unsupportedCreate.ok &&
      unsupportedCreate.error.code === "unsupported_room_fact_keys"
        ? unsupportedCreate.error
        : null;
    expect(Object.isFrozen(unsupportedError)).toBe(true);
    expect(Object.isFrozen(unsupportedError?.unsupportedCategoryKeys)).toBe(true);
    expect(Object.isFrozen(unsupportedError?.unsupportedBedTypeKeys)).toBe(true);
    const blockedError =
      deleteBlocked && !deleteBlocked.ok && deleteBlocked.error.code === "room_type_delete_blocked"
        ? deleteBlocked.error
        : null;
    expect(Object.isFrozen(blockedError)).toBe(true);
    expect(Object.isFrozen(blockedError?.blockers)).toBe(true);
    expect(Object.isFrozen(blockedError?.blockers[0])).toBe(true);

    for (const parser of [
      parseCreateRoomTypeFactsResult,
      parseUpdateRoomTypeFactsResult,
      parseSafeDeleteRoomTypeResult,
    ]) {
      const unavailableScope = parser({
        ok: false,
        error: { code: "setup_scope_unavailable" },
      });
      expect(unavailableScope).toEqual({
        ok: false,
        error: { code: "setup_scope_unavailable" },
      });
      expect(Object.isFrozen(unavailableScope)).toBe(true);
      expect(
        Object.isFrozen(unavailableScope && !unavailableScope.ok ? unavailableScope.error : null),
      ).toBe(true);
      expect(
        parser({
          ok: false,
          error: { code: "setup_scope_unavailable", reason: "membership_revoked" },
        }),
      ).toBeNull();

      const coordination = parser({ ok: false, error: { code: "command_in_progress" } });
      expect(coordination).toEqual({ ok: false, error: { code: "command_in_progress" } });
      expect(Object.isFrozen(coordination)).toBe(true);
      expect(Object.isFrozen(coordination && !coordination.ok ? coordination.error : null)).toBe(
        true,
      );
    }

    // Precedence contract: changed input under the original scoped key is an
    // idempotency conflict; any new key for the existing draft binding is a
    // binding conflict even when its facts happen to match.
    expect(
      parseCreateRoomTypeFactsResult({
        ok: false,
        error: { code: "idempotency_key_conflict" },
      }),
    ).toEqual({ ok: false, error: { code: "idempotency_key_conflict" } });
    expect(bindingConflict).toMatchObject({
      ok: false,
      error: { code: "draft_room_binding_conflict" },
    });
  });

  it("rejects cross-operation results, inconsistent bindings, and extra replay metadata", () => {
    const created = createSuccessResult();

    expect(parseUpdateRoomTypeFactsResult(created)).toBeNull();
    expect(parseSafeDeleteRoomTypeResult(created)).toBeNull();
    expect(
      parseCreateRoomTypeFactsResult({
        ...created,
        response: { ...created.response, replayed: true },
      }),
    ).toBeNull();
    expect(
      parseCreateRoomTypeFactsResult({
        ...created,
        response: {
          ...created.response,
          draftRoomBinding: { ...created.response.draftRoomBinding, roomTypeId: mediaObjectId },
        },
      }),
    ).toBeNull();
    expect(
      parseCreateRoomTypeFactsResult({
        ...created,
        response: {
          ...created.response,
          roomType: { ...created.response.roomType, lifecycle: "inactive" },
        },
      }),
    ).toBeNull();
    expect(
      parseUpdateRoomTypeFactsResult({
        ...updateSuccessResult(),
        response: {
          ...updateSuccessResult().response,
          roomType: { ...updateSuccessResult().response.roomType, roomFactsRevision: 1 },
        },
      }),
    ).toBeNull();
    expect(
      parseUpdateRoomTypeFactsResult({
        ...updateSuccessResult(),
        response: {
          ...updateSuccessResult().response,
          roomType: { ...updateSuccessResult().response.roomType, lifecycle: "inactive" },
        },
      }),
    ).toBeNull();
    expect(
      parseCreateRoomTypeFactsResult({
        ...created,
        response: {
          ...created.response,
          roomType: { ...created.response.roomType, roomFactsRevision: 2 },
        },
      }),
    ).toBeNull();
    expect(
      parseCreateRoomTypeFactsResult({
        ok: false,
        error: { code: "room_facts_revision_conflict", currentRevision: 2 },
      }),
    ).toBeNull();
    expect(
      parseUpdateRoomTypeFactsResult({
        ok: false,
        error: { code: "draft_room_binding_conflict", roomTypeId, currentRevision: 1 },
      }),
    ).toBeNull();
    expect(
      parseSafeDeleteRoomTypeResult({
        ...deleteSuccessResult(),
        response: { ...deleteSuccessResult().response, responseHash: "not-needed" },
      }),
    ).toBeNull();
    expect(
      parseSafeDeleteRoomTypeResult({
        ...deleteSuccessResult(),
        response: { ...deleteSuccessResult().response, lifecycle: "active" },
      }),
    ).toBeNull();
    expect(
      parseSafeDeleteRoomTypeResult({
        ...deleteSuccessResult(),
        response: { ...deleteSuccessResult().response, deletedRevision: 1 },
      }),
    ).toBeNull();
    expect(parseCreateRoomTypeFactsResult({ ...created, requestHash: "not-needed" })).toBeNull();
    expect(
      parseSafeDeleteRoomTypeResult({
        ok: false,
        error: {
          code: "unsupported_room_fact_keys",
          unsupportedCategoryKeys: ["custom-loft"],
          unsupportedBedTypeKeys: [],
        },
      }),
    ).toBeNull();
  });

  it("rejects malformed unsupported-vocabulary errors", () => {
    const unsupported = (unsupportedCategoryKeys: unknown, unsupportedBedTypeKeys: unknown) => ({
      ok: false,
      error: {
        code: "unsupported_room_fact_keys",
        unsupportedCategoryKeys,
        unsupportedBedTypeKeys,
      },
    });

    expect(parseCreateRoomTypeFactsResult(unsupported([], []))).toBeNull();
    expect(parseCreateRoomTypeFactsResult(unsupported(["suite", "villa"], []))).toBeNull();
    expect(parseCreateRoomTypeFactsResult(unsupported(["Luxury Room"], []))).toBeNull();
    expect(parseUpdateRoomTypeFactsResult(unsupported([], ["queen", "queen"]))).toBeNull();
    expect(
      parseUpdateRoomTypeFactsResult({
        ...unsupported([], ["wall.bed"]),
        error: { ...unsupported([], ["wall.bed"]).error, displayLabels: ["Wall bed"] },
      }),
    ).toBeNull();
  });

  it("rejects empty, duplicate, unknown, malformed, and detail-leaking delete blockers", () => {
    const blocked = (blockers: unknown) => ({
      ok: false,
      error: { code: "room_type_delete_blocked", currentRevision: 4, blockers },
    });

    expect(parseSafeDeleteRoomTypeResult(blocked([]))).toBeNull();
    expect(
      parseSafeDeleteRoomTypeResult(
        blocked([
          { code: "booking_reference", affectedCount: 1 },
          { code: "booking_reference", affectedCount: 2 },
        ]),
      ),
    ).toBeNull();
    expect(
      parseSafeDeleteRoomTypeResult(blocked([{ code: "distribution_row", affectedCount: 1 }])),
    ).toBeNull();
    expect(
      parseSafeDeleteRoomTypeResult(blocked([{ code: "booking_reference", affectedCount: 0 }])),
    ).toBeNull();
    expect(
      parseSafeDeleteRoomTypeResult(
        blocked([{ code: "reference_check_unavailable", affectedCount: 1 }]),
      ),
    ).toBeNull();
    expect(
      parseSafeDeleteRoomTypeResult(
        blocked([
          {
            code: "booking_reference",
            affectedCount: 1,
            bookingIds: ["private-booking-id"],
          },
        ]),
      ),
    ).toBeNull();
    expect(parseSafeDeleteRoomTypeResult(blocked(new Array(1)))).toBeNull();
  });
});

describe("PMS room-facts reads and ports", () => {
  it("resolves a durable draft binding even when its canonical room is an inactive tombstone", async () => {
    const binding = parseDraftRoomTypeBinding({
      propertyId: propertyId.toUpperCase(),
      draftRoomId,
      roomTypeId: roomTypeId.toUpperCase(),
    });
    const inactiveTombstone = parseRoomTypeFactsSnapshot({
      ...snapshot(),
      lifecycle: "inactive",
      roomFactsRevision: 2,
    });
    const bindingReadPort: DraftRoomTypeBindingReadPort = {
      async getDraftRoomTypeBinding(requestPropertyId, requestDraftRoomId) {
        return requestPropertyId === propertyId && requestDraftRoomId === draftRoomId
          ? binding
          : null;
      },
    };

    expect(binding).toEqual({ propertyId, draftRoomId, roomTypeId });
    expect(Object.isFrozen(binding)).toBe(true);
    expect(inactiveTombstone?.lifecycle).toBe("inactive");
    await expect(
      bindingReadPort.getDraftRoomTypeBinding(propertyId, parseDraftRoomId(draftRoomId)!),
    ).resolves.toEqual(binding);
    expect(binding?.roomTypeId).toBe(inactiveTombstone?.roomTypeId);

    for (const invalid of [
      { propertyId: "not-a-property-id", draftRoomId, roomTypeId },
      { propertyId, draftRoomId: "invalid draft id", roomTypeId },
      { propertyId, draftRoomId, roomTypeId: "not-a-room-type-id" },
      { propertyId, draftRoomId, roomTypeId, lifecycle: "inactive" },
    ]) {
      expect(parseDraftRoomTypeBinding(invalid)).toBeNull();
    }
  });

  it("parses an independently versioned room-facts snapshot", () => {
    const parsed = parseRoomTypeFactsSnapshot({
      ...snapshot(),
      propertyId: propertyId.toUpperCase(),
      roomTypeId: roomTypeId.toUpperCase(),
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.roomFactsRevision).toBe(1);
    expect(parsed?.propertyId).toBe(propertyId);
    expect(parsed?.roomTypeId).toBe(roomTypeId);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parseRoomTypeFactsSnapshot({ ...snapshot(), roomFactsRevision: 0 })).toBeNull();
  });

  it("keeps command and read ports implementation-neutral with structured safe-delete blockers", async () => {
    const roomSnapshot = parseRoomTypeFactsSnapshot(snapshot())!;
    const create = parseCreateRoomTypeFactsCommand({
      ...commandContext(),
      draftRoomId,
      expectedRevision: 0,
      facts: facts(),
    })!;
    const safeDeleteError: SafeDeleteRoomTypeError = {
      code: "room_type_delete_blocked",
      currentRevision: 1,
      blockers: [
        { code: "booking_reference", affectedCount: 1 },
        { code: "assigned_physical_unit", affectedCount: 1 },
        { code: "reference_check_unavailable" },
      ],
    };
    const commandPort: RoomFactsCommandPort = {
      async createRoomTypeFacts() {
        return {
          ok: true,
          response: {
            contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
            outcome: "created",
            roomType: roomSnapshot,
            draftRoomBinding: { propertyId, draftRoomId: create.draftRoomId, roomTypeId },
            acceptedAt: now,
          },
        };
      },
      async updateRoomTypeFacts() {
        return { ok: false, error: { code: "room_facts_revision_conflict", currentRevision: 2 } };
      },
      async safeDeleteRoomType() {
        return { ok: false, error: safeDeleteError };
      },
    };
    const readPort: RoomFactsReadPort = {
      async getRoomTypeFacts() {
        return roomSnapshot;
      },
      async listRoomTypeFacts() {
        return Object.freeze([roomSnapshot]);
      },
    };

    await expect(commandPort.createRoomTypeFacts(create)).resolves.toMatchObject({
      ok: true,
      response: {
        outcome: "created",
        draftRoomBinding: { propertyId, draftRoomId, roomTypeId },
      },
    });
    await expect(
      commandPort.safeDeleteRoomType(
        parseSafeDeleteRoomTypeCommand({
          ...commandContext(),
          roomTypeId,
          expectedRevision: 1,
        })!,
      ),
    ).resolves.toEqual({ ok: false, error: safeDeleteError });
    await expect(readPort.listRoomTypeFacts(propertyId)).resolves.toEqual([roomSnapshot]);
  });

  it("parses stable units and counts every non-retired unit regardless of label verification", async () => {
    const unlabeled = parsePhysicalRoomUnitIdentity({
      contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
      propertyId: propertyId.toUpperCase(),
      roomTypeId: roomTypeId.toUpperCase(),
      roomUnitId: mediaObjectId.toUpperCase(),
      lifecycle: "active",
      operationalLabel: null,
      operationalLabelStatus: "unverified",
    })!;
    const verified = parsePhysicalRoomUnitIdentity({
      contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
      propertyId,
      roomTypeId,
      roomUnitId: userId,
      lifecycle: "active",
      operationalLabel: "204",
      operationalLabelStatus: "verified",
    })!;
    const retired = parsePhysicalRoomUnitIdentity({
      contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
      propertyId,
      roomTypeId,
      roomUnitId: organizationId,
      lifecycle: "retired",
      operationalLabel: null,
      operationalLabelStatus: "unverified",
    })!;
    const capacity = parseRoomTypeCapacitySnapshot({
      contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
      propertyId: propertyId.toUpperCase(),
      roomTypeId: roomTypeId.toUpperCase(),
      roomUnitsRevision: 2,
      activeUnitCount: 2,
      capturedAt: now,
    })!;
    const unitReadPort: PhysicalRoomUnitIdentityReadPort = {
      async listPhysicalRoomUnitIdentities() {
        return Object.freeze([unlabeled, verified, retired]);
      },
    };
    const capacityReadPort: RoomCapacityReadPort = {
      async getRoomTypeCapacity() {
        return capacity;
      },
    };

    expect(unlabeled.operationalLabel).toBeNull();
    expect(unlabeled.roomUnitId).toBe(mediaObjectId);
    expect(verified.operationalLabel).toBe("204");
    if (verified.operationalLabelStatus === "verified") {
      expect(verified.operationalLabel.toUpperCase()).toBe("204");
    }
    expect(capacity.activeUnitCount).toBe(
      [unlabeled, verified, retired].filter(({ lifecycle }) => lifecycle !== "retired").length,
    );
    expect(Object.isFrozen(unlabeled)).toBe(true);
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(capacity)).toBe(true);
    await expect(
      unitReadPort.listPhysicalRoomUnitIdentities(propertyId, roomTypeId),
    ).resolves.toEqual([unlabeled, verified, retired]);
    await expect(capacityReadPort.getRoomTypeCapacity(propertyId, roomTypeId)).resolves.toEqual(
      capacity,
    );

    expect(
      parsePhysicalRoomUnitIdentity({
        contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
        propertyId,
        roomTypeId,
        roomUnitId: mediaObjectId,
        lifecycle: "active",
        operationalLabel: null,
        operationalLabelStatus: "verified",
      }),
    ).toBeNull();
    expect(
      parsePhysicalRoomUnitIdentity({
        contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
        propertyId,
        roomTypeId,
        roomUnitId: mediaObjectId,
        lifecycle: "active",
        operationalLabel: null,
        operationalLabelStatus: "unverified",
        operationalAvailability: "available",
      }),
    ).toBeNull();
    expect(
      parseRoomTypeCapacitySnapshot({
        contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
        propertyId,
        roomTypeId,
        roomUnitsRevision: 0,
        activeUnitCount: 2,
        capturedAt: now,
      }),
    ).toBeNull();
    expect(
      parseRoomTypeCapacitySnapshot({
        contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
        propertyId,
        roomTypeId,
        roomUnitsRevision: 2,
        activeUnitCount: 2,
        capturedAt: "2026-02-31T12:00:00Z",
      }),
    ).toBeNull();
  });
});

describe("PMS room-facts parser hardening", () => {
  it("rejects inherited, accessor, hidden, sparse, and subclassed command data", () => {
    const create = { ...commandContext(), draftRoomId, expectedRevision: 0, facts: facts() };
    expect(parseCreateRoomTypeFactsCommand(Object.create(create))).toBeNull();

    const accessor = { ...create } as Record<string, unknown>;
    Object.defineProperty(accessor, "expectedRevision", {
      enumerable: true,
      get: () => 0,
    });
    expect(parseCreateRoomTypeFactsCommand(accessor)).toBeNull();

    const hidden = { ...create };
    Object.defineProperty(hidden, "legacyBaseRate", { enumerable: false, value: "120.00" });
    expect(parseCreateRoomTypeFactsCommand(hidden)).toBeNull();

    expect(
      parseCreateRoomTypeFactsCommand({
        ...create,
        facts: { ...facts(), beds: new Array(1) },
      }),
    ).toBeNull();

    class Beds extends Array<unknown> {}
    expect(
      parseCreateRoomTypeFactsCommand({
        ...create,
        facts: { ...facts(), beds: new Beds({ type: "queen", quantity: 1 }) },
      }),
    ).toBeNull();
  });

  it("rejects inherited, accessor, hidden, and symbolic result metadata", () => {
    const result = createSuccessResult();
    expect(parseCreateRoomTypeFactsResult(Object.create(result))).toBeNull();

    const accessor = { ...result } as Record<string, unknown>;
    Object.defineProperty(accessor, "ok", { enumerable: true, get: () => true });
    expect(parseCreateRoomTypeFactsResult(accessor)).toBeNull();

    const hidden = { ...result };
    Object.defineProperty(hidden, "responseHash", { enumerable: false, value: "not-needed" });
    expect(parseCreateRoomTypeFactsResult(hidden)).toBeNull();

    const symbolic = { ...result, [Symbol("replayed")]: true };
    expect(parseCreateRoomTypeFactsResult(symbolic)).toBeNull();
  });
});
