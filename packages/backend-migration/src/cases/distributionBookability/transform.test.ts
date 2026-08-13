import type pg from "pg";
import { expect, it } from "vitest";

import { transformDistributionBookability } from "./transform.js";

it("carries room amenities into cached public quote offers", async () => {
  const queries: string[] = [];
  await transformDistributionBookability({
    async query(text: string) {
      queries.push(text);
      return { rows: [] };
    },
  } as unknown as pg.Client);

  expect(
    queries.find((query) => query.includes("INSERT INTO distribution.public_quote_read_models")),
  ).toContain("'amenities', source.room_amenities_snapshot");
});
