import { describe, expect, it } from "vitest";

import { writeProductionCatalogCore } from "./productionCatalogCoreWriter.js";

describe("production catalog core writer", () => {
  it("guards freshness and target-owned publication fields", async () => {
    const fixture = new WriterFixture();
    const counts = await writeProductionCatalogCore(
      fixture as never,
      {
        properties: [],
        slugs: [],
        domains: [],
        locations: [],
        profiles: [],
        amenities: [],
        contacts: [],
        policies: [],
        media: [],
      },
      [],
      "vay1351-run",
    );

    expect(counts).toEqual({ properties: 0, sourceLinks: 0, slugs: 0, locations: 0 });
    const properties = fixture.sql.find((sql) =>
      sql.includes("INSERT INTO hotel_catalog.properties"),
    )!;
    expect(properties).toContain("properties.updated_at < EXCLUDED.updated_at");
    const links = fixture.sql.find((sql) => sql.includes("property_source_links"))!;
    expect(links).toContain("DO NOTHING");
    expect(links).not.toContain("property_id = EXCLUDED.property_id");
    const locations = fixture.sql.find((sql) => sql.includes("property_locations"))!;
    expect(locations).toContain("property_owner_revisions");
    expect(locations).not.toMatch(/address_public\s*=|geo_public\s*=|map_display_mode\s*=/);
  });
});

class WriterFixture {
  sql: string[] = [];
  async query(sql: string): Promise<{ rowCount: number }> {
    this.sql.push(sql);
    return { rowCount: 0 };
  }
}
