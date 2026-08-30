import { describe, expect, it } from "vitest";

import { writeProductionCatalogContent } from "./productionCatalogContentWriter.js";

describe("production catalog content writer", () => {
  it("never overwrites target publication or owner-controlled fields", async () => {
    const fixture = new WriterFixture();
    await writeProductionCatalogContent(fixture as never, {
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

    const profiles = fixture.find("property_profiles");
    expect(profiles).not.toContain("public_notes =");
    const amenities = fixture.find("property_amenities");
    expect(amenities).not.toContain("public_safe = EXCLUDED");
    const contacts = fixture.find("property_contact_channels");
    expect(contacts).toContain("FALSE");
    expect(contacts).not.toContain("is_public = EXCLUDED");
    const policies = fixture.find("property_policy_summaries");
    expect(policies).toContain("property_owner_revisions");
    expect(policies).not.toMatch(/cancellation_terms_url\s*=|deposit_policy_summary\s*=/);
    expect(fixture.sql.every((sql) => sql.includes("updated_at < EXCLUDED.updated_at"))).toBe(true);
  });
});

class WriterFixture {
  sql: string[] = [];
  async query(sql: string): Promise<{ rowCount: number }> {
    this.sql.push(sql);
    return { rowCount: 0 };
  }
  find(table: string): string {
    return this.sql.find((sql) => sql.includes(table))!;
  }
}
