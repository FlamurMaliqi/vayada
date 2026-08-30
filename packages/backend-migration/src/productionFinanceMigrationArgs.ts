import type { ProductionFinanceMigrationMode } from "./productionFinanceMigration.js";

export type ProductionFinanceMigrationArgs = {
  connectionString: string;
  sourceRunId: string;
  mode: ProductionFinanceMigrationMode;
  applyConfirmation?: string;
};

export function parseProductionFinanceMigrationArgs(
  argv: string[],
  environment: Record<string, string | undefined> = process.env,
): ProductionFinanceMigrationArgs {
  const args = argv.slice(2);
  let connectionString = environment["TARGET_DATABASE_URL"] ?? "";
  let sourceRunId = "";
  let confirm = "";
  let explicitMode: ProductionFinanceMigrationMode | undefined;
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
  const expected = `production-finance:${sourceRunId}`;
  if (mode === "apply" && confirm !== expected)
    throw new Error(`--apply requires --confirm ${expected}`);
  return {
    connectionString,
    sourceRunId,
    mode,
    ...(mode === "apply" ? { applyConfirmation: confirm } : {}),
  };
}

function value(args: string[], index: number, argument: string): string {
  const result = args[index];
  if (!result || result.startsWith("--")) throw new Error(`${argument} requires a value`);
  return result;
}
