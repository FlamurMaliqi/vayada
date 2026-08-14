#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";

import { runManualBookingReadiness } from "../manualBookingReadiness.js";
import { normalizePgConnectionString } from "../pgConnection.js";

// prettier-ignore
const args = process.argv.slice(2);
let connectionString = process.env["TARGET_DATABASE_URL"] ?? "",
  manifestPath = "",
  reviewedSha256 = "",
  pretty = false;
// prettier-ignore
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--connection-string" && args[index + 1]) connectionString = args[++index]!;
  else if (args[index] === "--evidence-manifest" && args[index + 1]) manifestPath = args[++index]!;
  else if (args[index] === "--reviewed-sha256" && args[index + 1]) reviewedSha256 = args[++index]!;
  else if (args[index] === "--pretty") pretty = true;
  else { console.error(`Error: unknown argument "${args[index]}".`); process.exit(1); }
}
if (!connectionString || !manifestPath || !/^[a-f0-9]{64}$/.test(reviewedSha256)) {
  console.error("Error: target database, --evidence-manifest, and --reviewed-sha256 are required.");
  process.exit(1);
}
const source = await readFile(
  resolve(process.env["INIT_CWD"] ?? process.cwd(), manifestPath),
  "utf8",
);
const client = new pg.Client({ connectionString: normalizePgConnectionString(connectionString) });
try {
  await client.connect();
  await client.query("BEGIN TRANSACTION READ ONLY");
  const report = await runManualBookingReadiness(client, {
    manifest: JSON.parse(source) as unknown,
    manifestSha256: createHash("sha256").update(source).digest("hex"),
    reviewedSha256,
  });
  await client.query("COMMIT");
  console.log(JSON.stringify(report, null, pretty ? 2 : 0));
  if (report.status === "blocked") process.exitCode = 1;
} finally {
  await client.query("ROLLBACK").catch(() => undefined);
  await client.end();
}
