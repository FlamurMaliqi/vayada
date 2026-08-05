import { describe, expect, expectTypeOf, it } from "vitest";

import {
  PROPERTY_SETUP_DRAFT_RESET_CONTRACT_VERSION,
  parseResetPropertySetupDraftRequest,
  type ResetPropertySetupDraftReceipt,
} from "./propertySetupDraftReset.js";

const sessionId = "33333333-3333-4333-8333-333333333333";
const request = {
  sessionId,
  stepId: "rooms",
  expectedTrackRevision: 4,
  expectedSessionRevision: 7,
  expectedDraftRevision: 3,
  expectedBaseRevisions: {
    "pms.room_types": "room-types:9",
    "pms.room_units": "room-units:6",
    "pms.room_media": "room-media:4",
  },
};

describe("property setup draft reset contract", () => {
  it("normalizes exact CAS evidence without exposing draft data in the receipt", () => {
    expect(PROPERTY_SETUP_DRAFT_RESET_CONTRACT_VERSION).toBe("property-setup-draft-reset.v1");
    expect(
      parseResetPropertySetupDraftRequest({ ...request, sessionId: sessionId.toUpperCase() }),
    ).toEqual({ ok: true, value: request });
    expectTypeOf<ResetPropertySetupDraftReceipt>().not.toHaveProperty("baseRevisions");
    expectTypeOf<ResetPropertySetupDraftReceipt>().not.toHaveProperty("payload");
  });

  it.each([
    ["unknown field", { ...request, payload: {} }],
    ["invalid session", { ...request, sessionId: "not-a-session" }],
    ["zero session revision", { ...request, expectedSessionRevision: 0 }],
    ["unknown step", { ...request, stepId: "unknown" }],
    [
      "missing historical key",
      {
        ...request,
        expectedBaseRevisions: {
          "pms.room_types": "room-types:9",
          "pms.room_units": "room-units:6",
        },
      },
    ],
    [
      "extra historical key",
      {
        ...request,
        expectedBaseRevisions: { ...request.expectedBaseRevisions, "pms.inventory": "1" },
      },
    ],
    [
      "malformed historical value",
      {
        ...request,
        expectedBaseRevisions: { ...request.expectedBaseRevisions, "pms.room_media": "" },
      },
    ],
  ])("rejects %s", (_name, value) => {
    expect(parseResetPropertySetupDraftRequest(value)).toEqual({
      ok: false,
      error: {
        code: "invalid_request",
        message: "The property setup draft reset request is invalid.",
      },
    });
  });
});
