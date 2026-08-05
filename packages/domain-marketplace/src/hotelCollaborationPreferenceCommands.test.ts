import { describe, expect, it, vi } from "vitest";

import {
  MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_AUTHORIZATION,
  MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_CHANGED_EVENT_TYPE,
  MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_OUTBOX,
  MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_SOURCE_IDENTITY,
  type MarketplaceHotelCollaborationPreferencesChangedEvent,
  type MarketplaceHotelCollaborationPreferencesCommandPort,
  type MarketplaceHotelCollaborationPreferencesReadPort,
  type ReplaceMarketplaceHotelCollaborationPreferencesCommand,
  parseReplaceMarketplaceHotelCollaborationPreferencesResult,
  serializeMarketplaceHotelCollaborationPreferencesSourceRevision,
  serializeReplaceMarketplaceHotelCollaborationPreferencesFingerprint,
} from "./hotelCollaborationPreferenceCommands.js";
import {
  createMarketplaceHotelCollaborationPreferencesEvidence,
  parseReplaceMarketplaceHotelCollaborationPreferencesRequest,
} from "./hotelCollaborationPreferences.js";

const ORGANIZATION_ID = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const PROPERTY_ID = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";

function request() {
  return parseReplaceMarketplaceHotelCollaborationPreferencesRequest({
    expectedRevision: 0,
    compensationTypes: ["paid", "free_stay"],
    contentPlatforms: ["youtube", "instagram"],
    contentTypes: ["photography", "post"],
    availability: { mode: "selected_months", selectedMonths: [12, 1] },
  })!;
}

function command(): ReplaceMarketplaceHotelCollaborationPreferencesCommand {
  return {
    organizationId: ORGANIZATION_ID,
    propertyId: PROPERTY_ID,
    idempotencyKey: "replace-preferences-1",
    audit: {
      actor: { kind: "user", userId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
      requestId: "request-1",
      correlationId: null,
      requestedAt: "2026-08-03T15:00:00.000Z",
    },
    request: request(),
  };
}

function response(outcome: "updated" | "idempotent_replay" = "updated") {
  const { expectedRevision: _expectedRevision, ...preferences } = request();
  const propertyId = PROPERTY_ID.toLowerCase();
  return {
    contractVersion: "marketplace-hotel-collaboration-preferences.v1",
    propertyId,
    revision: 1,
    sourceRevision: "preferences:1",
    preferences,
    readiness: createMarketplaceHotelCollaborationPreferencesEvidence(propertyId, 1, preferences),
    outcome,
    acceptedAt: "2026-08-03T15:01:00.000Z",
  };
}

describe("Marketplace preference command contract", () => {
  it("freezes the exact active hotel-profile authorization policy", () => {
    expect(MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_AUTHORIZATION).toEqual({
      permission: "marketplace.profile.manage",
      entitlement: {
        product: "marketplace",
        key: "marketplace-hotel-profile",
        resourceType: "hotel_profile",
        status: "active",
      },
      resource: {
        product: "marketplace",
        resourceType: "hotel_profile",
        allowedRelationships: ["owner", "operator"],
      },
    });
    expect(Object.isFrozen(MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_AUTHORIZATION)).toBe(true);
    expect(
      Object.isFrozen(
        MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_AUTHORIZATION.resource.allowedRelationships,
      ),
    ).toBe(true);
  });

  it("exports one owner identity and exact source revision serializer", () => {
    expect(MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_SOURCE_IDENTITY).toEqual({
      ownerDomain: "marketplace",
      entityType: "hotel_collaboration_preferences",
    });
    expect(serializeMarketplaceHotelCollaborationPreferencesSourceRevision(0)).toBe(
      "preferences:0",
    );
    expect(serializeMarketplaceHotelCollaborationPreferencesSourceRevision(12)).toBe(
      "preferences:12",
    );
    expect(() => serializeMarketplaceHotelCollaborationPreferencesSourceRevision(-1)).toThrow(
      /non-negative integer/i,
    );
  });

  it("serializes the exact canonical business fingerprint and excludes attempt metadata", () => {
    expect(serializeReplaceMarketplaceHotelCollaborationPreferencesFingerprint(command())).toBe(
      JSON.stringify({
        organizationId: ORGANIZATION_ID.toLowerCase(),
        propertyId: PROPERTY_ID.toLowerCase(),
        request: {
          expectedRevision: 0,
          compensationTypes: ["free_stay", "paid"],
          contentPlatforms: ["instagram", "youtube"],
          contentTypes: ["post", "photography"],
          availability: { mode: "selected_months", selectedMonths: [1, 12] },
        },
      }),
    );
    expect(
      serializeReplaceMarketplaceHotelCollaborationPreferencesFingerprint({
        ...command(),
        idempotencyKey: "another-key",
        audit: { ...command().audit, requestId: "another-request" },
      }),
    ).toBe(serializeReplaceMarketplaceHotelCollaborationPreferencesFingerprint(command()));
    expect(
      serializeReplaceMarketplaceHotelCollaborationPreferencesFingerprint({
        ...command(),
        request: parseReplaceMarketplaceHotelCollaborationPreferencesRequest({
          ...request(),
          expectedRevision: 1,
        })!,
      }),
    ).not.toBe(serializeReplaceMarketplaceHotelCollaborationPreferencesFingerprint(command()));
  });

  it("strictly parses immutable updated and replay results", () => {
    for (const outcome of ["updated", "idempotent_replay"] as const) {
      const parsed = parseReplaceMarketplaceHotelCollaborationPreferencesResult({
        ok: true,
        response: response(outcome),
      });
      expect(parsed).toMatchObject({ ok: true, response: { outcome, revision: 1 } });
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(Object.isFrozen(parsed?.ok ? parsed.response.preferences : null)).toBe(true);
    }
  });

  it.each([
    { ok: false, error: { code: "preferences_revision_conflict", currentRevision: 0 } },
    { ok: false, error: { code: "idempotency_key_conflict" } },
    { ok: false, error: { code: "command_in_progress" } },
    { ok: false, error: { code: "setup_scope_unavailable" } },
  ])("strictly parses a typed failure %#", (result) => {
    expect(parseReplaceMarketplaceHotelCollaborationPreferencesResult(result)).toEqual(result);
  });

  it.each([
    ["unknown result field", { ok: true, response: response(), extra: true }],
    ["zero-revision success", { ok: true, response: { ...response(), revision: 0 } }],
    [
      "mismatched source revision",
      { ok: true, response: { ...response(), sourceRevision: "preferences:2" } },
    ],
    ["invalid outcome", { ok: true, response: { ...response(), outcome: "created" } }],
    [
      "extra error metadata",
      { ok: false, error: { code: "command_in_progress", currentRevision: 1 } },
    ],
    ["unknown error", { ok: false, error: { code: "internal_error" } }],
  ])("rejects %s", (_name, value) => {
    expect(parseReplaceMarketplaceHotelCollaborationPreferencesResult(value)).toBeNull();
  });

  it("does not invoke result accessors and snapshots changing proxies once", () => {
    const getter = vi.fn(() => response());
    const accessor = { ok: true };
    Object.defineProperty(accessor, "response", { enumerable: true, get: getter });
    expect(parseReplaceMarketplaceHotelCollaborationPreferencesResult(accessor)).toBeNull();
    expect(getter).not.toHaveBeenCalled();

    const changing = new Proxy(
      { ok: true, response: response() },
      {
        get(target, key, receiver) {
          if (key === "ok") return false;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    expect(parseReplaceMarketplaceHotelCollaborationPreferencesResult(changing)).toMatchObject({
      ok: true,
    });
  });

  it("keeps missing owner state separate from source failures in the read port", async () => {
    const propertyId = PROPERTY_ID.toLowerCase();
    const missingReadiness = createMarketplaceHotelCollaborationPreferencesEvidence(
      propertyId,
      0,
      null,
    );
    if (missingReadiness.status !== "blocked") throw new Error("Expected missing readiness");
    const reads: MarketplaceHotelCollaborationPreferencesReadPort = {
      async getHotelCollaborationPreferences(scope) {
        if (scope.propertyId === "unavailable") {
          return {
            outcome: "unavailable",
            error: {
              code: "preference_source_unavailable",
              errorSource: "system",
              retryable: true,
            },
          };
        }
        if (scope.propertyId === "malformed") {
          return {
            outcome: "malformed",
            error: {
              code: "preference_source_malformed",
              errorSource: "system",
              retryable: false,
            },
          };
        }
        return {
          outcome: "available",
          readModel: {
            contractVersion: "marketplace-hotel-collaboration-preferences.v1",
            propertyId,
            revision: 0,
            sourceRevision: "preferences:0",
            preferences: null,
            readiness: missingReadiness,
          },
        };
      },
    };
    await expect(
      reads.getHotelCollaborationPreferences({ organizationId: ORGANIZATION_ID, propertyId }),
    ).resolves.toMatchObject({
      outcome: "available",
      readModel: { revision: 0, readiness: { status: "blocked" } },
    });
    await expect(
      reads.getHotelCollaborationPreferences({
        organizationId: ORGANIZATION_ID,
        propertyId: "unavailable",
      }),
    ).resolves.toMatchObject({ outcome: "unavailable" });
    await expect(
      reads.getHotelCollaborationPreferences({
        organizationId: ORGANIZATION_ID,
        propertyId: "malformed",
      }),
    ).resolves.toMatchObject({ outcome: "malformed" });
  });

  it("defines a secret-safe changed event and required source-read outbox", async () => {
    const parsed = parseReplaceMarketplaceHotelCollaborationPreferencesResult({
      ok: true,
      response: response(),
    });
    if (!parsed?.ok) throw new Error("Expected parsed command result");
    const event: MarketplaceHotelCollaborationPreferencesChangedEvent = {
      contractVersion: "marketplace-hotel-collaboration-preferences.v1",
      eventType: MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_CHANGED_EVENT_TYPE,
      eventId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      organizationId: ORGANIZATION_ID.toLowerCase(),
      propertyId: PROPERTY_ID.toLowerCase(),
      preferenceRevision: parsed.response.revision,
      outcome: "updated",
    };
    expect(Object.keys(event)).toEqual([
      "contractVersion",
      "eventType",
      "eventId",
      "organizationId",
      "propertyId",
      "preferenceRevision",
      "outcome",
    ]);
    expect(MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_OUTBOX).toEqual({
      destination: "marketplace.submission-source",
      metadata: { sourceReadRequired: true },
    });

    const commands: MarketplaceHotelCollaborationPreferencesCommandPort = {
      async replaceHotelCollaborationPreferences() {
        return parsed;
      },
    };
    await expect(commands.replaceHotelCollaborationPreferences(command())).resolves.toBe(parsed);
  });
});
