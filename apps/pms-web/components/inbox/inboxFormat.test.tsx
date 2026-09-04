import { describe, expect, it } from "vitest";

import {
  formatInboxTime,
  formatPropertyDateTimeInput,
  heldRouteReason,
  inboxContextLabel,
  inboxGuestName,
  inboxPreview,
  inboxRouteLabel,
  inboxSourceLabel,
  propertyLocalDateTimeToIso,
} from "./inboxFormat";

describe("Inbox presentation helpers", () => {
  it("keeps source, context, and route meaning explicit", () => {
    expect(inboxSourceLabel({ channel: "ota", providerChannel: "booking_com" })).toBe(
      "Booking.com",
    );
    expect(
      inboxContextLabel({
        conversationContext: {
          state: "inquiry",
          bookingId: null,
          sourceReference: "INQ-7",
          arrivalDate: null,
          departureDate: null,
          adults: null,
          children: null,
        },
      }),
    ).toBe("Inquiry · INQ-7");
    expect(
      inboxRouteLabel({
        state: "ready",
        channel: "ota",
        providerChannel: "airbnb",
        reasonCode: null,
      }),
    ).toBe("Replying through Airbnb");
    expect(heldRouteReason("guest_email_unavailable")).toBe("guest email is unavailable");
  });

  it("uses truthful fallbacks for missing guest and message data", () => {
    expect(inboxGuestName({ guest: { displayName: null } })).toBe("Unknown guest");
    expect(inboxPreview({ lastMessage: { preview: null, at: null, hasAttachments: false } })).toBe(
      "No messages yet",
    );
    expect(
      inboxPreview({
        lastMessage: {
          preview: null,
          at: "2026-09-04T00:00:00.000Z",
          hasAttachments: true,
        },
      }),
    ).toBe("Attachment");
  });

  it("formats recent queue activity compactly", () => {
    const now = new Date("2026-09-04T12:00:00.000Z");
    expect(formatInboxTime("2026-09-04T11:48:00.000Z", now)).toBe("12m");
    expect(formatInboxTime("2026-09-04T09:00:00.000Z", now)).toBe("3h");
  });

  it("converts follow-up wall time through the property timezone", () => {
    expect(propertyLocalDateTimeToIso("2026-09-05T09:00", "Europe/Berlin")).toBe(
      "2026-09-05T07:00:00.000Z",
    );
    expect(formatPropertyDateTimeInput(new Date("2026-09-05T07:00:00.000Z"), "Europe/Berlin")).toBe(
      "2026-09-05T09:00",
    );
    expect(propertyLocalDateTimeToIso("2026-03-29T02:30", "Europe/Berlin")).toBeNull();
  });
});
