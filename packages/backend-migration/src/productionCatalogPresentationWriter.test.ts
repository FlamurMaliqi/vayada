import { describe, expect, it } from "vitest";

import { writeProductionCatalogPresentation } from "./productionCatalogPresentationWriter.js";

describe("production catalog presentation writer", () => {
  it("stores only validated Platform Media references and preserves target approvals", async () => {
    const fixture = new WriterFixture();
    await writeProductionCatalogPresentation(fixture as never, {
      properties: [],
      slugs: [],
      domains: [],
      locations: [],
      profiles: [],
      amenities: [],
      contacts: [],
      policies: [],
      media: [],
    });

    const domains = fixture.sql[0]!;
    expect(domains).toContain("ON CONFLICT DO NOTHING");
    expect(domains).not.toContain("verification_status = EXCLUDED");
    const media = fixture.sql[1]!;
    expect(media).toContain("JOIN platform.media_objects");
    expect(media).toContain("'platform-media:' || media_object.id::text");
    expect(media).not.toContain("source_url");
    expect(media).not.toContain("public_approved = EXCLUDED");
    expect(media).toContain("property_media.updated_at < EXCLUDED.updated_at");
  });

  it("fails when a target race prevents a planned assignment", async () => {
    const fixture = new WriterFixture();
    fixture.rowCounts = [0, 0];
    await expect(
      writeProductionCatalogPresentation(fixture as never, {
        properties: [],
        slugs: [],
        domains: [{ updatedAt: "now" }] as never,
        locations: [],
        profiles: [],
        amenities: [],
        contacts: [],
        policies: [],
        media: [],
      }),
    ).rejects.toThrow("lost its ownership or freshness race");
  });
});

class WriterFixture {
  sql: string[] = [];
  rowCounts = [0, 0];
  async query(sql: string): Promise<{ rowCount: number }> {
    this.sql.push(sql);
    return { rowCount: this.rowCounts[this.sql.length - 1]! };
  }
}
