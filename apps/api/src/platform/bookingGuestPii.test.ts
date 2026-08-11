import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { createTargetBookingGuestPiiPort, type BookingGuestPiiPool } from "./bookingGuestPii.js";

function createPool(input: { plan?: "fixed"; guestContactAccepted: boolean }) {
  const queries: string[] = [];
  const pool: BookingGuestPiiPool = {
    async connect() {
      return {
        async query<T extends QueryResultRow = QueryResultRow>(text: string) {
          queries.push(text);
          if (text.trimStart().startsWith("SELECT 1")) {
            return { rows: [{}] as T[], rowCount: 1 };
          }
          if (text.includes("finance.billing_entitlements")) {
            return {
              rows: (input.plan ? [{ plan: input.plan }] : []) as unknown as T[],
              rowCount: input.plan ? 1 : 0,
            };
          }
          if (text.includes('AS "guestContactAccepted"')) {
            return {
              rows: [
                {
                  guestId: "guest-1",
                  guestBookingId: "booking-1",
                  role: "booker",
                  firstName: "Ada",
                  lastName: "Lovelace",
                  email: "ada@example.com",
                  phone: "+4912345",
                  countryCode: "GB",
                  arrivalTime: null,
                  specialRequests: null,
                  guestContactAccepted: input.guestContactAccepted,
                },
                {
                  guestId: "guest-2",
                  guestBookingId: "booking-1",
                  role: "additional_guest",
                  firstName: "Charles",
                  lastName: "Babbage",
                  email: "charles@example.com",
                  phone: "+4954321",
                  countryCode: "GB",
                  arrivalTime: null,
                  specialRequests: null,
                  guestContactAccepted: input.guestContactAccepted,
                },
              ] as unknown as T[],
              rowCount: 2,
            };
          }
          throw new Error(`Unexpected query: ${text}`);
        },
        release() {},
      };
    },
    async end() {},
  };
  return { pool, queries };
}

describe("target booking guest PII contact access", () => {
  it("hides primary and additional guest contact for an unaccepted commission booking", async () => {
    const { pool, queries } = createPool({ guestContactAccepted: false });
    const port = createTargetBookingGuestPiiPort({
      connectionString: "postgresql://target-db",
      pool,
    });

    const projection = await port.listGuestPiiForPmsOperations({
      propertyId: "d3000000-0000-0000-0000-000000000682",
      guestBookingId: "e3000000-0000-0000-0000-000000000682",
    });

    expect(projection?.primaryGuest).toMatchObject({
      displayName: "Ada Lovelace",
      email: "Hidden until you accept",
      phone: "Hidden until you accept",
      countryCode: "GB",
    });
    expect(projection?.additionalGuests[0]).toMatchObject({
      displayName: "Charles Babbage",
      email: "Hidden until you accept",
      phone: "Hidden until you accept",
      countryCode: "GB",
    });
    expect(queries.join("\n")).toContain("contact_event.actor_type = 'property_user'");
  });

  it.each([
    { name: "accepted commission", plan: undefined, guestContactAccepted: true },
    { name: "fixed", plan: "fixed" as const, guestContactAccepted: false },
  ])("returns contact for a $name booking", async ({ plan, guestContactAccepted }) => {
    const { pool } = createPool({ plan, guestContactAccepted });
    const port = createTargetBookingGuestPiiPort({
      connectionString: "postgresql://target-db",
      pool,
    });

    const projection = await port.listGuestPiiForPmsOperations({
      propertyId: "d3000000-0000-0000-0000-000000000682",
      guestBookingId: "e3000000-0000-0000-0000-000000000682",
    });

    expect(projection?.primaryGuest?.email).toBe("ada@example.com");
    expect(projection?.additionalGuests[0]?.phone).toBe("+4954321");
  });
});
