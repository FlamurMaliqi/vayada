import { describe, expect, it } from "vitest";

import { rebuildProductionCatalogPublicProjection } from "./productionCatalogPublicProjection.js";

const PROPERTY = "11111111-1111-4111-8111-111111111111";

describe("production catalog public projection", () => {
  it("publishes only explicitly safe target-owned fields and Platform Media variants", async () => {
    const fixture = new ProjectionFixture(1);
    expect(
      await rebuildProductionCatalogPublicProjection(fixture as never, [PROPERTY], "run"),
    ).toBe(1);
    expect(fixture.sql).not.toContain("raw_marketplace_location");
    expect(fixture.sql).not.toContain("source_url");
    expect(fixture.sql).toContain("location.address_public");
    expect(fixture.sql).toContain("location.geo_public");
    expect(fixture.sql).toContain("variant.public_cdn_url");
    expect(fixture.sql).toContain("media_object.lifecycle_status = 'active'");
    expect(fixture.sql).toContain("assignment.public_approved");
    expect(fixture.sql).toContain("property.profile_status = 'complete'");
  });

  it("fails closed when a property has no canonical projection row", async () => {
    await expect(
      rebuildProductionCatalogPublicProjection(
        new ProjectionFixture(0) as never,
        [PROPERTY],
        "run",
      ),
    ).rejects.toThrow("wrote 0 of 1");
  });
});

class ProjectionFixture {
  sql = "";
  constructor(private readonly rowCount: number) {}
  async query(sql: string): Promise<{ rowCount: number }> {
    this.sql = sql;
    return { rowCount: this.rowCount };
  }
}
