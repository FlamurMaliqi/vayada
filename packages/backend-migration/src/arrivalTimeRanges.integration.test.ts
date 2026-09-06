import pg from "pg";
import { writeProductionCatalogContent } from "./productionCatalogContentWriter.js";
import { describe, expect, it } from "vitest";
import { assertSafeTestDatabase } from "./testUtils.js";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("Catalog arrival range migration", () => {
  it("preserves single times, versions range changes and rejects invalid windows", async () => {
    assertSafeTestDatabase(url!);
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query("BEGIN");
      const id = "12830000-0000-4000-8000-000000000001";
      await client.query(
        "INSERT INTO hotel_catalog.properties (id, public_id, display_name) VALUES ($1, 'vay1283-test', 'Arrival policy test')",
        [id],
      );
      await client.query(
        "INSERT INTO hotel_catalog.property_policy_summaries (property_id, check_in_time, check_out_time, policy_source_owner, updated_at) VALUES ($1, '15:00', '11:00', 'booking', '2026-01-01T00:00:00Z')",
        [id],
      );
      const revision = async () =>
        (
          await client.query(
            "SELECT revision FROM hotel_catalog.property_owner_revisions WHERE property_id=$1 AND owner_key='hotel_catalog.policy'",
            [id],
          )
        ).rows[0].revision;
      const before = await revision();
      const stamp = (
        await client.query(
          "SELECT updated_at FROM hotel_catalog.property_policy_summaries WHERE property_id=$1",
          [id],
        )
      ).rows[0].updated_at.toISOString();
      const writes = {
        properties: [],
        slugs: [],
        domains: [],
        locations: [],
        profiles: [],
        amenities: [],
        contacts: [],
        media: [],
        policies: [
          {
            propertyId: id,
            checkInTime: "15:00",
            checkOutTime: "11:00",
            checkInUntil: "23:00",
            checkOutFrom: "07:00",
            cancellationSummary: null,
            paymentPolicySummary: null,
            updatedAt: stamp,
          },
        ],
      };
      expect((await writeProductionCatalogContent(client, writes)).policies).toBe(1);
      expect((await writeProductionCatalogContent(client, writes)).policies).toBe(0);
      expect(Number(await revision())).toBe(Number(before) + 1);
      const row = (
        await client.query(
          "SELECT to_char(check_in_time,'HH24:MI') AS arrival, to_char(check_out_time,'HH24:MI') AS departure FROM hotel_catalog.property_policy_summaries WHERE property_id=$1",
          [id],
        )
      ).rows[0];
      expect(row).toEqual({ arrival: "15:00", departure: "11:00" });
      await client.query("SAVEPOINT invalid_window");
      await expect(
        client.query(
          "UPDATE hotel_catalog.property_policy_summaries SET check_in_until='14:00' WHERE property_id=$1",
          [id],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await client.query("ROLLBACK TO SAVEPOINT invalid_window");
      expect(Number(await revision())).toBe(Number(before) + 1);
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  });
});
