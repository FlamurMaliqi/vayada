import { describe, expect, it } from "vitest";

import { readProductionCatalogTargetState } from "./productionCatalogTargetReader.js";

const PROPERTY = "11111111-1111-4111-8111-111111111111";
const RUN = "vay1351-0123456789abcdef01234567";

describe("production catalog target reader", () => {
  it("scopes mutable catalog state and retains freshness, privacy, and ownership evidence", async () => {
    const fixture = new TargetFixture();
    const state = await readProductionCatalogTargetState(
      fixture as never,
      [PROPERTY, PROPERTY],
      RUN,
    );

    expect(
      fixture.calls
        .map((call) => call.values?.[0])
        .filter(Array.isArray)
        .every((ids) => ids.length === 1),
    ).toBe(true);
    expect(state.locations[0]).toMatchObject({ addressPublic: false, updatedAt: "2026-08-03" });
    expect(state.contacts[0]).toMatchObject({ isPublic: false });
    expect(state.domains[0]).toMatchObject({ verificationStatus: "verified" });
    expect(state.ownerRevisions[0]).toMatchObject({ revision: "2" });
    expect(state.ownerLinks[0]).toMatchObject({ status: "archived" });
    expect(state.mediaObjects[0]).toMatchObject({ lifecycleStatus: "active" });
    expect(
      fixture.calls.find((call) => call.sql.includes("platform.media_objects"))?.sql,
    ).toContain("source_row_id");
    const mediaObjectCall = fixture.calls.find((call) =>
      call.sql.includes("platform.media_objects"),
    );
    expect(mediaObjectCall?.sql).toContain("source_metadata ->> 'migrationRunId' = $1::text");
    expect(mediaObjectCall?.values).toEqual([RUN]);
    expect(fixture.calls.find((call) => call.sql.includes("property_source_links"))?.sql).toContain(
      "migrationRunId",
    );
    expect(fixture.calls.find((call) => call.sql.includes("property_source_links"))?.sql).toContain(
      "status",
    );
  });
});

class TargetFixture {
  calls: Array<{ sql: string; values?: unknown[] }> = [];
  async query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> {
    this.calls.push({ sql, values });
    const base = { propertyId: PROPERTY, updatedAt: "2026-08-03" };
    if (sql.includes("property_locations"))
      return { rows: [{ ...base, addressPublic: false }] as T[] };
    if (sql.includes("property_contact_channels"))
      return { rows: [{ ...base, isPublic: false }] as T[] };
    if (sql.includes("property_domains"))
      return { rows: [{ ...base, verificationStatus: "verified" }] as T[] };
    if (sql.includes("property_owner_revisions"))
      return {
        rows: [{ propertyId: PROPERTY, ownerKey: "hotel_catalog.location", revision: "2" }] as T[],
      };
    if (sql.includes("identity.organization_resource_links"))
      return {
        rows: [
          {
            organizationId: PROPERTY,
            product: "booking",
            resourceType: "booking_hotel",
            resourceId: PROPERTY,
            relationship: "owner",
            status: "archived",
          },
        ] as T[],
      };
    if (sql.includes("platform.media_objects"))
      return { rows: [{ id: PROPERTY, lifecycleStatus: "active" }] as T[] };
    return { rows: [] };
  }
}
