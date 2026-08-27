import type { PmsManualBookingCreateCommand } from "@vayada/domain-pms";
import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { lockManualBookingRooms } from "./pmsManualBookingPersistence.js";
import type { PmsManualBookingTransaction } from "./pmsManualBookingTransactionPorts.js";

const propertyId = "10000000-0000-4000-8000-000000000001";
const roomTypeIds = [
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
];
const roomIds = ["10000000-0000-4000-8000-000000000004", "10000000-0000-4000-8000-000000000005"];

describe("PMS manual-booking room locks", () => {
  it("takes room-type advisory locks in stable order before room rows", async () => {
    const calls: Array<{ text: string; values: readonly unknown[] }> = [];
    const transaction = {
      async query<T extends QueryResultRow = QueryResultRow>(
        text: string,
        values: readonly unknown[] = [],
      ) {
        calls.push({ text, values });
        if (text.includes("SELECT DISTINCT room_type_id")) {
          return {
            rows: roomTypeIds.map((roomTypeId) => ({ roomTypeId })) as unknown as T[],
            rowCount: 2,
          };
        }
        if (text.includes("pg_advisory_xact_lock")) return { rows: [] as T[], rowCount: 1 };
        if (text.includes('id::text AS "roomId"')) {
          return {
            rows: roomIds.map((roomId, index) => ({
              roomId,
              roomTypeId: roomTypeIds[index],
            })) as unknown as T[],
            rowCount: 2,
          };
        }
        throw new Error(`Unexpected query: ${text}`);
      },
    } as PmsManualBookingTransaction;
    const command = {
      propertyId,
      stays: roomIds.map((roomId, index) => ({ roomId, position: index + 1 })),
    } as unknown as PmsManualBookingCreateCommand;

    await expect(lockManualBookingRooms(transaction, command)).resolves.toHaveLength(2);

    const advisoryCalls = calls.filter(({ text }) => text.includes("pg_advisory_xact_lock"));
    expect(advisoryCalls.map(({ values }) => values[1])).toEqual(roomTypeIds);
    expect(calls.indexOf(advisoryCalls[1]!)).toBeLessThan(
      calls.findIndex(({ text }) => text.includes('id::text AS "roomId"')),
    );
  });
});
