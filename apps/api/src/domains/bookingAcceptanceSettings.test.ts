import type { QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";

import { createTargetBookingAcceptanceSettingsPort } from "./bookingAcceptanceSettings.js";

describe("target booking acceptance settings", () => {
  it("reads and updates the Booking-owned property setting", async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
    const pool = {
      async query<T extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: readonly unknown[],
      ): Promise<{ rows: T[] }> {
        calls.push({ text, values });
        return {
          rows: [
            { acceptanceMode: text.startsWith("UPDATE") ? "request" : "instant" } as unknown as T,
          ],
        };
      },
      end: vi.fn(async () => undefined),
    };
    const port = createTargetBookingAcceptanceSettingsPort({
      connectionString: "postgresql://unused",
      pool,
    });

    await expect(port.findAcceptanceMode("property-1")).resolves.toBe("instant");
    await expect(port.updateAcceptanceMode("property-1", "request")).resolves.toBe("request");
    expect(calls[0]?.text).toContain("FROM booking.booking_settings");
    expect(calls[1]?.text).toContain("SET acceptance_mode = $2");
    expect(calls[1]?.values).toEqual(["property-1", "request"]);
  });
});
