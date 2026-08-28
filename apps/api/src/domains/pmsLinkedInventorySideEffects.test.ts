import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { enqueuePmsLinkedInventorySideEffects } from "./pmsLinkedInventorySideEffects.js";

describe("PMS linked inventory side effects", () => {
  it("scopes event identity by operation", async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const client = {
      async query<T extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: readonly unknown[],
      ) {
        queries.push({ text, values });
        return {
          rows: (text.includes("platform.domain_events")
            ? [{ eventId: "13380000-0000-4000-8000-000000000001" }]
            : []) as unknown as T[],
          rowCount: 1,
        };
      },
    };
    const base = {
      propertyId: "13380000-0000-4000-8000-000000000002",
      commandId: "shared-request",
      keyHash: "shared-key",
      acceptedAt: "2026-09-01T00:00:00.000Z",
      audit: { requestId: "shared-request" },
    };
    const changes = [
      {
        roomTypeId: "13380000-0000-4000-8000-000000000003",
        stayDate: "2026-09-01",
      },
    ];

    await enqueuePmsLinkedInventorySideEffects(client, { ...base, operation: "reserve" }, changes);
    await enqueuePmsLinkedInventorySideEffects(client, { ...base, operation: "release" }, changes);

    const eventKeys = queries
      .filter(({ text }) => text.includes("platform.domain_events"))
      .map(({ values }) => values?.[0]);
    expect(eventKeys).toHaveLength(2);
    expect(eventKeys[0]).toContain(".operation.reserve.");
    expect(eventKeys[1]).toContain(".operation.release.");
    expect(eventKeys[0]).not.toBe(eventKeys[1]);
  });
});
