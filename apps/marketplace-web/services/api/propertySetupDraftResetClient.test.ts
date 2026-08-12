import {
  PROPERTY_SETUP_DRAFT_RESET_CONTRACT_VERSION,
  type ResetPropertySetupDraftRequest,
} from "@vayada/domain-hotels";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiErrorResponse } from "./client";
import {
  createPropertySetupDraftResetClient,
  PropertySetupDraftResetError,
  type PropertySetupDraftResetHttpClient,
} from "./propertySetupDraftResetClient";

const propertyId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const resetAt = "2026-08-04T12:00:00.000Z";

const calls = vi.hoisted(() => ({
  post: vi.fn<(endpoint: string, data?: unknown, options?: RequestInit) => Promise<unknown>>(),
}));
const http: PropertySetupDraftResetHttpClient = {
  post: calls.post as PropertySetupDraftResetHttpClient["post"],
};

describe("propertySetupDraftResetClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.post.mockResolvedValue(receipt());
  });

  it("normalizes the exact request and sends one deterministic idempotency header", async () => {
    const client = createPropertySetupDraftResetClient(http);
    const uppercaseRequest = { ...request(), sessionId: sessionId.toUpperCase() };

    await expect(client.reset(propertyId.toUpperCase(), uppercaseRequest)).resolves.toEqual(
      receipt(),
    );
    await client.reset(propertyId, request());

    expect(calls.post).toHaveBeenNthCalledWith(
      1,
      `/api/hotel-setup/properties/${propertyId}/setup-drafts/present_hotel/reset`,
      request(),
      { headers: { "Idempotency-Key": expect.stringMatching(/^setup-draft-reset:/) } },
    );
    const firstHeaders = calls.post.mock.calls[0]?.[2]?.headers as Record<string, string>;
    const secondHeaders = calls.post.mock.calls[1]?.[2]?.headers as Record<string, string>;
    expect(Object.keys(firstHeaders)).toEqual(["Idempotency-Key"]);
    expect(firstHeaders["Idempotency-Key"]).toBe(secondHeaders["Idempotency-Key"]);
    expect(firstHeaders["Idempotency-Key"]?.length).toBeLessThanOrEqual(200);
  });

  it.each([
    ["invalid property", "not-a-property", request()],
    ["extra request key", propertyId, { ...request(), payload: {} }],
    [
      "missing base revision",
      propertyId,
      {
        ...request(),
        expectedBaseRevisions: {
          "hotel_catalog.profile": "profile:7",
          "hotel_catalog.media": "profile:7",
        },
      },
    ],
  ])("rejects %s before network I/O", async (_name, property, value) => {
    const client = createPropertySetupDraftResetClient(http);

    await expect(
      client.reset(property, value as ResetPropertySetupDraftRequest),
    ).rejects.toMatchObject({ code: "invalid_request", requiresRefresh: false });
    expect(calls.post).not.toHaveBeenCalled();
  });

  it.each([
    ["extra key", { extra: true }],
    ["wrong session", { sessionId: "33333333-3333-4333-8333-333333333333" }],
    ["wrong step", { stepId: "calendar" }],
    ["wrong track revision", { trackRevision: 4 }],
    ["wrong session revision", { sessionRevision: 7 }],
    ["wrong draft revision", { discardedDraftRevision: 3 }],
    ["invalid date", { resetAt: "2026-99-99T12:00:00.000Z" }],
    ["wrong next method", { nextRead: { ...receipt().nextRead, method: "POST" } }],
    [
      "wrong next scope",
      {
        nextRead: {
          method: "GET",
          href: "/api/hotel-setup/properties/33333333-3333-4333-8333-333333333333/route",
        },
      },
    ],
  ])("fails closed for a success receipt with %s", async (_name, override) => {
    calls.post.mockResolvedValue({ ...receipt(), ...override });
    const client = createPropertySetupDraftResetClient(http);

    await expect(client.reset(propertyId, request())).rejects.toMatchObject({
      code: "owner_contract_violation",
      requiresRefresh: false,
    });
  });

  it.each([
    [404, { code: "setup_scope_unavailable" }, false],
    [409, { code: "inactive_setup_step", currentTrackRevision: 4 }, true],
    [409, { code: "track_revision_conflict", currentTrackRevision: 4 }, true],
    [409, { code: "session_revision_conflict", currentSessionRevision: 9 }, true],
    [409, { code: "draft_revision_conflict", currentDraftRevision: 6 }, true],
    [409, { code: "draft_base_revision_conflict" }, true],
    [409, { code: "setup_session_expired", currentSessionRevision: 9 }, true],
    [409, { code: "setup_draft_expired", currentDraftRevision: 6 }, true],
    [409, { code: "idempotency_key_conflict" }, false],
    [409, { code: "command_in_progress" }, false],
  ])("recognizes typed status %i error $code", async (status, errorBody, requiresRefresh) => {
    calls.post.mockRejectedValue(new ApiErrorResponse(status, errorBody));
    const client = createPropertySetupDraftResetClient(http);

    await expect(client.reset(propertyId, request())).rejects.toMatchObject({
      name: "PropertySetupDraftResetError",
      code: errorBody.code,
      details: errorBody,
      requiresRefresh,
    });
  });

  it.each([
    [404, { code: "setup_scope_unavailable", extra: true }],
    [404, { code: "command_in_progress" }],
    [409, { code: "draft_revision_conflict" }],
    [409, { code: "unknown_conflict" }],
  ])("fails closed for malformed status %i owner errors", async (status, errorBody) => {
    calls.post.mockRejectedValue(new ApiErrorResponse(status, errorBody));
    const client = createPropertySetupDraftResetClient(http);

    await expect(client.reset(propertyId, request())).rejects.toMatchObject({
      code: "owner_contract_violation",
      requiresRefresh: false,
    });
  });

  it("passes through non-contract transport failures", async () => {
    const transport = new ApiErrorResponse(503, { code: "service_unavailable" });
    calls.post.mockRejectedValue(transport);
    const client = createPropertySetupDraftResetClient(http);

    await expect(client.reset(propertyId, request())).rejects.toBe(transport);
  });

  it("exposes a stable typed client error", () => {
    const error = new PropertySetupDraftResetError("Conflict", "command_in_progress", null, false);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PropertySetupDraftResetError");
  });
});

function request(): Extract<ResetPropertySetupDraftRequest, { stepId: "present_hotel" }> {
  return {
    sessionId,
    stepId: "present_hotel",
    expectedTrackRevision: 3,
    expectedSessionRevision: 7,
    expectedDraftRevision: 4,
    expectedBaseRevisions: {
      "hotel_catalog.profile": "profile:7",
      "hotel_catalog.media": "profile:7",
      "hotel_catalog.amenities": "profile:7",
    },
  };
}

function receipt() {
  return {
    contractVersion: PROPERTY_SETUP_DRAFT_RESET_CONTRACT_VERSION,
    operation: "reset_step_draft",
    sessionId,
    stepId: "present_hotel",
    trackRevision: 3,
    sessionRevision: 8,
    discardedDraftRevision: 4,
    resetAt,
    nextRead: {
      method: "GET",
      href: `/api/hotel-setup/properties/${propertyId}/route`,
    },
  } as const;
}
