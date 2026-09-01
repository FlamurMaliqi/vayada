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
    expect(properties).not.toContain("profile_status = EXCLUDED");
    expect(properties).not.toContain("completeness_reasons = EXCLUDED");
    const links = fixture.sql.find((sql) => sql.includes("property_source_links"))!;
    expect(links).toContain("metadata = hotel_catalog.property_source_links.metadata");
    expect(links).toContain("migrationDisposition");
    expect(links).toContain("migrationDispositionReason");
    expect(links).toContain("property_id = EXCLUDED.property_id");
    expect(links).toContain("relationship = EXCLUDED.relationship");
    const ownerLinks = fixture.sql.find((sql) => sql.includes("organization_resource_links"))!;
    expect(ownerLinks).toContain("private_quarantine");
    expect(ownerLinks).toContain("status = 'archived'");
    const entitlements = fixture.sql.find((sql) => sql.includes("product_entitlements"))!;
    expect(entitlements).toContain("private_quarantine");
    expect(entitlements).toContain("status = 'suspended'");
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
