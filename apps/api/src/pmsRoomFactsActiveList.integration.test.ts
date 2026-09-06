import { randomUUID } from "node:crypto";
import pg from "pg";
import { expect, it } from "vitest";
import { createPgPmsRoomFactsReadModel } from "./domains/pmsRoomFactsReadModel.js";

const databaseUrl = process.env["TEST_DATABASE_URL"];
it.skipIf(!databaseUrl)(
  "retired malformed rooms do not poison active setup inventory",
  async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query("BEGIN");
      const propertyId = randomUUID();
      const roomTypeId = randomUUID();
      await client.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name) VALUES ($1, $2, 'Room facts test')`,
        [propertyId, propertyId],
      );
      await client.query(
        `INSERT INTO pms.room_types (id, property_id, name, base_rate_amount, currency, occupancy_limits, room_attributes)
      VALUES ($1, $2, 'Test Room', 100, 'EUR', '{"total":2}', $3::jsonb)`,
        [
          roomTypeId,
          propertyId,
          JSON.stringify({
            beds: [{ type: "king", quantity: 1 }],
            bedrooms: 1,
            bathrooms: 1,
            bathroomType: "private",
            size: { value: 20, unit: "sqm" },
          }),
        ],
      );
      const read = createPgPmsRoomFactsReadModel({ connectionString: databaseUrl!, pool: client });
      expect(await read.listRoomTypeFacts(propertyId)).toHaveLength(1);
      await client.query(`UPDATE pms.room_types SET active = false WHERE id = $1`, [roomTypeId]);
      expect((await read.getRoomTypeFacts(propertyId, roomTypeId))?.lifecycle).toBe("inactive");
      await client.query(`UPDATE pms.room_types SET room_attributes = '{}'::jsonb WHERE id = $1`, [
        roomTypeId,
      ]);
      await expect(read.listRoomTypeFacts(propertyId)).resolves.toEqual([]);
      await client.query(`UPDATE pms.room_types SET active = true WHERE id = $1`, [roomTypeId]);
      await expect(read.listRoomTypeFacts(propertyId)).rejects.toThrow(
        "PMS room facts row failed contract validation",
      );
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  },
);
