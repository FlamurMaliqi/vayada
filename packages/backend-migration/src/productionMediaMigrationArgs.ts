import type {
  ProductionMediaMigrationConfig,
  ProductionMediaMigrationMode,
} from "./productionMediaMigration.js";

export type ProductionMediaMigrationArgs = ProductionMediaMigrationConfig;

export function parseProductionMediaMigrationArgs(
  argv: string[],
  environment: Record<string, string | undefined> = process.env,
): ProductionMediaMigrationArgs {
  const args = argv.slice(2);
  let connectionString = environment["TARGET_DATABASE_URL"] ?? "";
  let sourceRunId = "";
  let confirm = "";
  let explicitMode: ProductionMediaMigrationMode | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--connection-string") connectionString = value(args, ++index, argument);
    else if (argument === "--source-run-id") sourceRunId = value(args, ++index, argument);
    else if (argument === "--confirm") confirm = value(args, ++index, argument);
    else if (argument === "--apply" || argument === "--dry-run") {
      const mode = argument === "--apply" ? "apply" : "dry-run";
      if (explicitMode && explicitMode !== mode)
        throw new Error("Use exactly one of --apply or --dry-run");
      explicitMode = mode;
    } else throw new Error("Unknown argument");
  }
  const mode = explicitMode ?? "dry-run";
  if (!connectionString) throw new Error("TARGET_DATABASE_URL or --connection-string is required");
  if (!/^vay1351-[0-9a-f]{24}$/.test(sourceRunId))
    throw new Error("--source-run-id must be an immutable VAY-1351 extraction run ID");
  const expected = `production-media:${sourceRunId}`;
  if (mode === "apply" && confirm !== expected)
    throw new Error(`--apply requires --confirm ${expected}`);
  const targetBucket = required(environment, "PLATFORM_MEDIA_BUCKET");
  const cdnBaseUrl = required(environment, "PLATFORM_MEDIA_CDN_BASE_URL");
  const legacyPmsBucket = required(environment, "LEGACY_PMS_MEDIA_BUCKET");
  const allowedLegacyBuckets = required(environment, "LEGACY_MEDIA_BUCKET_ALLOWLIST")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (allowedLegacyBuckets.length === 0) throw new Error("LEGACY_MEDIA_BUCKET_ALLOWLIST is empty");
  return {
    connectionString,
    sourceRunId,
    mode,
    targetBucket,
    cdnBaseUrl,
    legacyPmsBucket,
    allowedLegacyBuckets,
    region: environment["AWS_REGION"]?.trim() || undefined,
  };
}

function required(environment: Record<string, string | undefined>, name: string): string {
  const result = environment[name]?.trim();
  if (!result) throw new Error(`${name} is required`);
  return result;
}

function value(args: string[], index: number, argument: string): string {
  const result = args[index];
  if (!result || result.startsWith("--")) throw new Error(`${argument} requires a value`);
  return result;
}
