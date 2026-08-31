import { describe, expect, it } from "vitest";

import { readProductionMarketplacePrerequisites } from "./productionMarketplaceTargetReader.js";

describe("production Marketplace target reader", () => {
  it("loads only property and media evidence from the current extraction run", async () => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const client = {
      async query(sql: string, values?: unknown[]) {
        calls.push({ sql, values });
        return { rows: [] };
      },
    };

    await readProductionMarketplacePrerequisites(client as never, "vay1351-current");

    const propertyLinks = calls.find((call) => call.sql.includes("property_source_links"));
    const media = calls.find((call) => call.sql.includes("platform.media_objects"));
    expect(propertyLinks?.sql).toContain("metadata ->> 'migrationRunId' = $1");
    expect(propertyLinks?.values).toEqual(["vay1351-current"]);
    expect(media?.sql).toContain("source_metadata ->> 'migrationRunId' = $1");
    expect(media?.values).toEqual(["vay1351-current"]);
  });
});
