#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { normalizePgConnectionString } from "../pgConnection.js";
import {
  buildSourceExtractionPlan,
  parseSourceExtractionManifest,
  runSourceExtraction,
  SourceExtractionError,
} from "../sourceExtraction.js";
import { parseSourceExtractionArgs } from "../sourceExtractionArgs.js";
import { parseSourceInventory, SOURCE_DATABASES, type SourceDatabase } from "../sourceInventory.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../../");
const sourceUrlEnvironment: Record<SourceDatabase, string> = {
  auth: "AUTH_SOURCE_DATABASE_URL",
  booking: "BOOKING_SOURCE_DATABASE_URL",
  marketplace: "MARKETPLACE_SOURCE_DATABASE_URL",
  pms: "PMS_SOURCE_DATABASE_URL",
};

const clients: pg.Client[] = [];
try {
  const { values, dryRun } = parseSourceExtractionArgs(process.argv);
  const manifest = parseSourceExtractionManifest(
    JSON.parse(await readFile(values.get("--manifest")!, "utf8")),
  );
  const inventory = parseSourceInventory(
    await readFile(join(packageRoot, "source-inventory.tsv"), "utf8"),
  );
  const snapshotIdentifiers = Object.fromEntries(
    SOURCE_DATABASES.map((sourceDatabase) => [
      sourceDatabase,
      values.get(`--${sourceDatabase}-snapshot-arn`),
    ]),
  ) as Record<SourceDatabase, string>;
  const config = {
    manifest,
    inventory,
    sourceSchemaRevision: values.get("--source-schema-revision")!,
    snapshotIdentifiers,
    cutoverFreezeProofSha256: values.get("--cutover-freeze-proof-sha256"),
  };

  if (dryRun) {
    console.log(JSON.stringify(buildSourceExtractionPlan(config), null, 2));
  } else {
    const targetUrl = process.env["TARGET_DATABASE_URL"];
    if (!targetUrl) {
      throw new SourceExtractionError("MISSING_CONNECTION", "TARGET_DATABASE_URL is required");
    }
    const sourceUrls = {} as Record<SourceDatabase, string>;
    for (const sourceDatabase of SOURCE_DATABASES) {
      const environmentName = sourceUrlEnvironment[sourceDatabase];
      const value = process.env[environmentName];
      if (!value) {
        throw new SourceExtractionError("MISSING_CONNECTION", `${environmentName} is required`);
      }
      sourceUrls[sourceDatabase] = value;
    }

    const target = new pg.Client({ connectionString: normalizePgConnectionString(targetUrl) });
    clients.push(target);
    await target.connect();
    const sources = {} as Record<SourceDatabase, pg.Client>;
    for (const sourceDatabase of SOURCE_DATABASES) {
      const source = new pg.Client({
        connectionString: normalizePgConnectionString(sourceUrls[sourceDatabase]),
      });
      clients.push(source);
      await source.connect();
      sources[sourceDatabase] = source;
    }
    console.log(JSON.stringify(await runSourceExtraction(config, target, sources), null, 2));
  }
} catch (error) {
  const safe =
    error instanceof SourceExtractionError
      ? error
      : new SourceExtractionError("EXTRACTION_FAILED", "source extraction failed");
  console.error(`${safe.code}: ${safe.message}`);
  process.exitCode = 1;
} finally {
  await Promise.all(clients.map((client) => client.end().catch(() => undefined)));
}
