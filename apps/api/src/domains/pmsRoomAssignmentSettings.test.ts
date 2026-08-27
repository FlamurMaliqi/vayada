import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { createPgPmsRoomAssignmentSettingsPort } from "./pmsRoomAssignmentSettings.js";

const propertyId = "10000000-0000-4000-8000-000000000001";

function harness(rows: QueryResultRow[]) {
  const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  const port = createPgPmsRoomAssignmentSettingsPort({
    pool: {
      async query<T extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: readonly unknown[],
      ): Promise<{ rows: T[] }> {
        calls.push({ text, values });
        return { rows: rows as T[] };
      },
      async end() {},
    },
  });
  return { calls, port };
}

describe("PMS room-assignment settings port", () => {
  it("reads the effective enabled-by-default property setting", async () => {
    const test = harness([
      {
        propertyId,
        autoRearrangeEnabled: true,
        updatedAt: null,
      },
    ]);

    await expect(test.port.find(propertyId)).resolves.toEqual({
      propertyId,
      autoRearrangeEnabled: true,
      updatedAt: null,
    });
    expect(test.calls[0]?.text).toContain(
      "FROM pms.effective_room_assignment_optimization_settings",
    );
    expect(test.calls[0]?.values).toEqual([propertyId]);
  });

  it("upserts an override only for an existing property", async () => {
    const updatedAt = new Date("2026-08-17T12:00:00.000Z");
    const test = harness([{ propertyId, autoRearrangeEnabled: false, updatedAt }]);

    await expect(test.port.update(propertyId, false)).resolves.toEqual({
      propertyId,
      autoRearrangeEnabled: false,
      updatedAt: updatedAt.toISOString(),
    });
    expect(test.calls[0]?.text).toContain("FROM hotel_catalog.properties");
    expect(test.calls[0]?.text).toContain("ON CONFLICT (property_id) DO UPDATE");
    expect(test.calls[0]?.values).toEqual([propertyId, false]);
  });

  it("returns null when the property does not exist", async () => {
    const test = harness([]);
    await expect(test.port.find(propertyId)).resolves.toBeNull();
    await expect(test.port.update(propertyId, true)).resolves.toBeNull();
  });
});
