import type { ProductionIdentityMigrationMode } from "./productionIdentityMigration.js";

export type ProductionIdentityMigrationArgs = {
  connectionString: string;
  sourceRunId: string;
  mode: ProductionIdentityMigrationMode;
};

export function parseProductionIdentityMigrationArgs(
  argv: string[],
  environment: Record<string, string | undefined> = process.env,
): ProductionIdentityMigrationArgs {
  const args = argv.slice(2);
  let connectionString = environment["TARGET_DATABASE_URL"] ?? "";
  let sourceRunId = "";
  let confirm = "";
  let explicitMode: ProductionIdentityMigrationMode | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--connection-string") connectionString = value(args, ++index, arg);
    else if (arg === "--source-run-id") sourceRunId = value(args, ++index, arg);
    else if (arg === "--confirm") confirm = value(args, ++index, arg);
    else if (arg === "--apply" || arg === "--dry-run") {
      const mode = arg === "--apply" ? "apply" : "dry-run";
      if (explicitMode && explicitMode !== mode)
        throw new Error("Use exactly one of --apply or --dry-run");
      explicitMode = mode;
    } else throw new Error("Unknown argument");
  }

  const mode = explicitMode ?? "dry-run";
  if (!connectionString) throw new Error("TARGET_DATABASE_URL or --connection-string is required");
  if (!/^vay1351-[0-9a-f]{24}$/.test(sourceRunId))
    throw new Error("--source-run-id must be an immutable VAY-1351 extraction run ID");
  const expectedConfirm = `production-identity:${sourceRunId}`;
  if (mode === "apply" && confirm !== expectedConfirm)
    throw new Error(`--apply requires --confirm ${expectedConfirm}`);
  return { connectionString, sourceRunId, mode };
}

function value(args: string[], index: number, argument: string): string {
  const result = args[index];
  if (!result || result.startsWith("--")) throw new Error(`${argument} requires a value`);
  return result;
}
