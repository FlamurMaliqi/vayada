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
                  countryCodeRaw: null,
                  countryCodeReviewRequired: false,
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
                  countryCodeRaw: null,
                  countryCodeReviewRequired: false,
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

function createProjectionFailurePool() {
  const queries: string[] = [];
  let released = false;
  const guest = {
    guestId: "f3000000-0000-0000-0000-000000000682",
    guestBookingId: "e3000000-0000-0000-0000-000000000682",
    role: "additional_guest",
    firstName: "Charles",
    lastName: "Babbage",
    email: "charles@example.com",
    phone: "+4954321",
    countryCode: "GB",
    countryCodeRaw: null,
    countryCodeReviewRequired: false,
    arrivalTime: null,
    specialRequests: null,
  };
  const pool: BookingGuestPiiPool = {
    async connect() {
      return {
        async query<T extends QueryResultRow = QueryResultRow>(text: string) {
          queries.push(text);
          const query = text.trimStart();
          if (query === "BEGIN" || query === "ROLLBACK") {
            return { rows: [] as T[], rowCount: 0 };
          }
          if (query.startsWith("SELECT 1")) {
            return { rows: [{}] as T[], rowCount: 1 };
          }
          if (query.includes("finance.billing_entitlements")) {
            throw new Error("projection failed");
          }
          if (query.includes("FOR UPDATE") || query.startsWith("UPDATE booking.booking_guests")) {
            return { rows: [guest] as unknown as T[], rowCount: 1 };
          }
          if (query.startsWith("DELETE FROM booking.booking_guests")) {
            return { rows: [{ guestId: guest.guestId }] as unknown as T[], rowCount: 1 };
          }
          if (query.startsWith("INSERT INTO platform.product_audit_events")) {
            return { rows: [] as T[], rowCount: 1 };
          }
          throw new Error(`Unexpected query: ${text}`);
        },
        release() {
          released = true;
        },
      };
    },
    async end() {},
  };
  return { pool, queries, wasReleased: () => released };
}

function createUpdatePool() {
  const updateValues: unknown[][] = [];
  const guestRow = {
    guestId: "f6855800-0000-0000-0000-000000000002",
    guestBookingId: "e3000000-0000-0000-0000-000000000682",
    role: "additional_guest",
    firstName: "Charles",
    lastName: "Babbage",
    email: "original@example.com",
    phone: "+4911111",
    countryCode: "GB",
    countryCodeRaw: null,
    countryCodeReviewRequired: false,
    arrivalTime: null,
    specialRequests: null,
  };
  const pool: BookingGuestPiiPool = {
    async connect() {
      return {
        async query<T extends QueryResultRow = QueryResultRow>(
          text: string,
          values: readonly unknown[] = [],
        ) {
          if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text)) {
            return { rows: [] as T[], rowCount: 0 };
          }
          if (text.trimStart().startsWith("SELECT 1")) {
            return { rows: [{}] as T[], rowCount: 1 };
          }
          if (text.includes("FOR UPDATE")) {
            return { rows: [guestRow] as unknown as T[], rowCount: 1 };
          }
          if (text.includes("finance.billing_entitlements")) {
            return { rows: [] as T[], rowCount: 0 };
          }
          if (
            text.includes('AS "guestContactAccepted"') &&
            !text.includes("booking_guests guest")
          ) {
            return {
              rows: [{ guestContactAccepted: false }] as unknown as T[],
              rowCount: 1,
            };
          }
          if (text.includes("UPDATE booking.booking_guests")) {
            updateValues.push([...values]);
            return {
              rows: [
                {
                  ...guestRow,
                  firstName: values[0],
                  email: values[2],
                  phone: values[3],
                },
              ] as unknown as T[],
              rowCount: 1,
            };
          }
          if (text.includes("INSERT INTO platform.product_audit_events")) {
            return { rows: [] as T[], rowCount: 1 };
          }
          if (text.includes("booking_guests guest")) {
            return {
              rows: [
                { ...guestRow, firstName: "Updated", guestContactAccepted: false },
              ] as unknown as T[],
              rowCount: 1,
            };
          }
          throw new Error(`Unexpected query: ${text}`);
        },
        release() {},
      };
    },
    async end() {},
  };
  return { pool, updateValues };
}

function createNationalityCorrectionPool(idempotency: "new" | "replay" | "conflict" = "new") {
  const updateValues: unknown[][] = [];
  const auditCalls: { text: string; values: readonly unknown[] }[] = [];
  const booker = {
    guestId: "f6855800-0000-0000-0000-000000000001",
    guestBookingId: "e3000000-0000-0000-0000-000000000682",
    role: "booker",
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.com",
    phone: "+4912345",
    countryCode: null,
    countryCodeRaw: "Holland",
    countryCodeReviewRequired: true,
  };
  const pool: BookingGuestPiiPool = {
    async connect() {
      return {
        async query<T extends QueryResultRow = QueryResultRow>(
          text: string,
          values: readonly unknown[] = [],
        ) {
          if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text)) {
            return { rows: [] as T[], rowCount: 0 };
          }
          if (text.trimStart().startsWith("SELECT 1")) {
            return { rows: [{}] as T[], rowCount: 1 };
          }
          if (text.includes("INSERT INTO platform.idempotency_keys")) {
            return {
              rows: [
                {
                  id: "c6855800-0000-0000-0000-000000000001",
                  requestFingerprintHash: idempotency === "conflict" ? "other" : values[1],
                  status: idempotency === "new" ? "in_progress" : "completed",
                  inserted: idempotency === "new",
                },
              ] as unknown as T[],
              rowCount: 1,
            };
          }
          if (text.trimStart().startsWith("UPDATE platform.idempotency_keys")) {
            return { rows: [] as T[], rowCount: 1 };
          }
          if (text.trimStart().startsWith("UPDATE booking.booking_guests")) {
            updateValues.push([...values]);
            return { rows: [{ guestId: booker.guestId }] as unknown as T[], rowCount: 1 };
          }
          if (text.includes("INSERT INTO platform.product_audit_events")) {
            auditCalls.push({ text, values });
            return { rows: [] as T[], rowCount: 1 };
          }
          if (text.includes("finance.billing_entitlements")) {
            return { rows: [] as T[], rowCount: 0 };
          }
          if (text.includes("booking_guests guest")) {
            return {
              rows: [
                {
                  ...booker,
                  countryCode: "NL",
                  countryCodeRaw: null,
                  countryCodeReviewRequired: false,
                  guestContactAccepted: false,
                },
              ] as unknown as T[],
              rowCount: 1,
            };
          }
          throw new Error(`Unexpected query: ${text}`);
        },
        release() {},
      };
    },
    async end() {},
  };
  return { pool, updateValues, auditCalls };
}

function nationalityCommand(countryCode = "Holland") {
  return {
    propertyId: "d3000000-0000-0000-0000-000000000682",
    guestBookingId: "e3000000-0000-0000-0000-000000000682",
    commandId: "command-nationality-1",
    idempotencyKey: "idempotency-nationality-1",
    countryCode,
    audit: {
      actorUserId: "a6855800-0000-0000-0000-000000000002",
      actorOrganizationId: "b6855800-0000-0000-0000-000000000002",
      requestId: "request-nationality-1",
      source: "pms_operations" as const,
      reason: "Correct primary guest nationality",
    },
  };
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
      canReadGuestContact: false,
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
    expect(queries.join("\n")).toContain("'guest_booking.accepted'");
    expect(queries.join("\n")).not.toContain("contact_event.actor_type = 'property_user'");
    expect(queries.join("\n")).not.toContain("guest.email");
    expect(queries.join("\n")).not.toContain("guest.phone");
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
      canReadGuestContact: true,
    });

    expect(projection?.primaryGuest?.email).toBe("ada@example.com");
    expect(projection?.additionalGuests[0]?.phone).toBe("+4954321");
  });

  it("ignores hidden contact mutations while allowing non-contact guest updates", async () => {
    const { pool, updateValues } = createUpdatePool();
    const port = createTargetBookingGuestPiiPort({
      connectionString: "postgresql://target-db",
      pool,
    });

    const result = await port.updateAdditionalGuestForPmsOperations({
      propertyId: "d3000000-0000-0000-0000-000000000682",
      guestBookingId: "e3000000-0000-0000-0000-000000000682",
      guestId: "f6855800-0000-0000-0000-000000000002",
      commandId: "command-1",
      idempotencyKey: "idempotency-1",
      guest: {
        firstName: "Updated",
        email: "replacement@example.com",
        phone: "+4922222",
        countryCode: "Holland",
      },
      audit: {
        actorUserId: "a6855800-0000-0000-0000-000000000002",
        actorOrganizationId: "b6855800-0000-0000-0000-000000000002",
        requestId: "request-1",
        source: "pms_operations",
        reason: "Update additional guest",
      },
    });

    expect(result.ok).toBe(true);
    expect(updateValues[0]?.slice(0, 5)).toEqual([
      "Updated",
      "Babbage",
      "original@example.com",
      "+4911111",
      "NL",
    ]);
    expect(updateValues[0]?.[10]).toBe(true);
  });
});

describe("target Booking-owned primary guest nationality correction", () => {
  it("normalizes the selected value and atomically clears raw review evidence", async () => {
    const { pool, updateValues, auditCalls } = createNationalityCorrectionPool();
    const port = createTargetBookingGuestPiiPort({
      connectionString: "postgresql://target-db",
      pool,
    });

    const result = await port.correctPrimaryGuestNationalityForPmsOperations(nationalityCommand());

    expect(result).toMatchObject({
      ok: true,
      primaryGuest: {
        countryCode: "NL",
      },
    });
    expect(updateValues[0]?.[0]).toBe("NL");
    expect(result.ok && result.primaryGuest.email).not.toBe("ada@example.com");
    expect(auditCalls[0]?.text).toMatch(/'property',\s+NULL,\s+\$4::uuid/);
    expect(auditCalls[0]?.values[9]).toBe("c6855800-0000-0000-0000-000000000001");
  });

  it.each([
    ["replay", true],
    ["conflict", false],
  ] as const)("does not mutate an idempotency %s", async (state, succeeds) => {
    const { pool, updateValues } = createNationalityCorrectionPool(state);
    const result = await createTargetBookingGuestPiiPort({
      connectionString: "postgresql://target-db",
      pool,
    }).correctPrimaryGuestNationalityForPmsOperations(nationalityCommand());
    expect(result.ok ? result.replayed : result.code).toBe(
      succeeds ? true : "idempotency_conflict",
    );
    expect(updateValues).toEqual([]);
  });
});

describe("target booking guest PII transaction handling", () => {
  it.each(["update", "delete"] as const)(
    "rolls back and releases when the %s projection read fails",
    async (operation) => {
      const { pool, queries, wasReleased } = createProjectionFailurePool();
      const port = createTargetBookingGuestPiiPort({
        connectionString: "postgresql://target-db",
        pool,
      });
      const command = {
        propertyId: "d3000000-0000-0000-0000-000000000682",
        guestBookingId: "e3000000-0000-0000-0000-000000000682",
        guestId: "f3000000-0000-0000-0000-000000000682",
        commandId: "command-1",
        idempotencyKey: "idempotency-1",
        audit: {
          actorUserId: "a3000000-0000-0000-0000-000000000682",
          actorOrganizationId: "b3000000-0000-0000-0000-000000000682",
          requestId: "request-1",
          source: "pms_operations" as const,
          reason: "test",
        },
      };

      const result =
        operation === "update"
          ? port.updateAdditionalGuestForPmsOperations({
              ...command,
              guest: { email: "new@example.com" },
            })
          : port.deleteAdditionalGuestForPmsOperations(command);

      await expect(result).rejects.toThrow("projection failed");
      expect(queries.at(-1)).toBe("ROLLBACK");
      expect(queries).not.toContain("COMMIT");
      expect(wasReleased()).toBe(true);
    },
  );
});
