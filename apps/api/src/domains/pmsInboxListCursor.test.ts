import { describe, expect, it } from "vitest";

import {
  decodePmsInboxListCursor,
  encodePmsInboxListCursor,
  pmsInboxListFilterFingerprint,
} from "./pmsInboxListCursor.js";

const input = {
  propertyId: "11111111-1111-4111-8111-111111111111",
  actorMembershipId: "22222222-2222-4222-8222-222222222222",
  canReadGuestContact: false,
  assignee: "me",
  search: "Ada",
  limit: 25,
} as const;

describe("PMS Inbox list cursor", () => {
  it("preserves database precision and binds the property, actor, and private filters", () => {
    const fingerprint = pmsInboxListFilterFingerprint(input);
    const token = encodePmsInboxListCursor(fingerprint, {
      activityAt: "2026-09-02T08:00:00.000123Z",
      id: "33333333-3333-4333-8333-333333333333",
    });

    expect(decodePmsInboxListCursor(token, fingerprint)).toEqual({
      activityAt: "2026-09-02T08:00:00.000123Z",
      id: "33333333-3333-4333-8333-333333333333",
    });
    expect(Buffer.from(token, "base64url").toString("utf8")).not.toContain("Ada");
    expect(
      decodePmsInboxListCursor(token, pmsInboxListFilterFingerprint({ ...input, search: "Grace" })),
    ).toBeNull();
    expect(decodePmsInboxListCursor(`${token}=`, fingerprint)).toBeNull();
  });
});
