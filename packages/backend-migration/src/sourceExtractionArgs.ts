import { SourceExtractionError } from "./sourceExtraction.js";
import { SOURCE_DATABASES } from "./sourceInventory.js";

export function parseSourceExtractionArgs(argv: string[]) {
  const values = new Map<string, string>();
  const allowed = new Set([
    "--manifest",
    "--source-schema-revision",
    "--cutover-freeze-proof-sha256",
    ...SOURCE_DATABASES.map((sourceDatabase) => `--${sourceDatabase}-snapshot-arn`),
  ]);
  let dryRun = false;
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (!allowed.has(argument) || values.has(argument)) {
      throw new SourceExtractionError("INVALID_ARGUMENTS", "unknown or duplicate argument");
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new SourceExtractionError("INVALID_ARGUMENTS", `missing value for ${argument}`);
    }
    values.set(argument, value);
    index += 1;
  }
  const required = [
    "--manifest",
    "--source-schema-revision",
    ...SOURCE_DATABASES.map((sourceDatabase) => `--${sourceDatabase}-snapshot-arn`),
  ];
  for (const argument of required) {
    if (!values.has(argument)) {
      throw new SourceExtractionError("INVALID_ARGUMENTS", `${argument} is required`);
    }
  }
  return { values, dryRun };
}
