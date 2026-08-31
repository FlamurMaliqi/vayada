import { MIGRATION_ENVIRONMENTS, type MigrationEnvironment } from "./runner.js";
import {
  SOURCE_EXTRACTION_ENVIRONMENTS,
  type ProductionParityConfig,
  type SourceExtractionEnvironment,
} from "./productionParity.js";
import { SOURCE_DATABASES, type SourceDatabase } from "./sourceInventory.js";

export type ProductionParityArgs = ProductionParityConfig & { report: "json" | "text" };

export function isProductionParityCommand(argv: string[]): boolean {
  return argv.slice(2).includes("--source-run-id");
}

export function parseProductionParityArgs(
  argv: string[],
  defaultMigrationsDir: string,
  environment: Record<string, string | undefined> = process.env,
): ProductionParityArgs {
  const args = argv.slice(2);
  let connectionString = environment["TARGET_DATABASE_URL"] ?? "";
  let sourceRunId = "";
  let sourceEnvironment: SourceExtractionEnvironment | null = null;
  let targetEnvironment: MigrationEnvironment | null = null;
  const runtimeApplicationRelease =
    environment["APPLICATION_RELEASE"] ?? environment["GIT_SHA"] ?? "";
  let applicationRelease = runtimeApplicationRelease;
  let operator = environment["CUTOVER_OPERATOR"] ?? environment["USER"] ?? "";
  let warningBudget = 0;
  const migrationsDir = defaultMigrationsDir;
  const targetMediaBucket = environment["PLATFORM_MEDIA_BUCKET"] ?? "";
  const mediaCdnBaseUrl = environment["PLATFORM_MEDIA_CDN_BASE_URL"] ?? "";
  let report: "json" | "text" = "text";
  const sourceTags = {} as Record<SourceDatabase, string>;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--connection-string") connectionString = value(args, ++index, argument);
    else if (argument === "--source-run-id") sourceRunId = value(args, ++index, argument);
    else if (argument === "--source-env") {
      const selected = value(args, ++index, argument);
      if (!SOURCE_EXTRACTION_ENVIRONMENTS.includes(selected as SourceExtractionEnvironment))
        throw new Error(`Invalid source extraction environment: ${selected}`);
      sourceEnvironment = selected as SourceExtractionEnvironment;
    } else if (argument === "--env") {
      const selected = value(args, ++index, argument);
      if (!MIGRATION_ENVIRONMENTS.includes(selected as MigrationEnvironment))
        throw new Error(`Invalid migration environment: ${selected}`);
      targetEnvironment = selected as MigrationEnvironment;
    } else if (argument === "--application-release")
      applicationRelease = value(args, ++index, argument);
    else if (argument === "--operator") operator = value(args, ++index, argument);
    else if (argument === "--warning-budget") {
      const raw = value(args, ++index, argument);
      if (!/^\d+$/.test(raw)) throw new Error("--warning-budget must be a non-negative integer");
      warningBudget = Number(raw);
    } else if (argument === "--report") {
      const selected = value(args, ++index, argument);
      if (selected !== "json" && selected !== "text")
        throw new Error('--report must be "json" or "text"');
      report = selected;
    } else {
      const database = SOURCE_DATABASES.find(
        (candidate) => argument === `--${candidate}-source-tag`,
      );
      if (!database) throw new Error(`Unknown argument: ${argument}`);
      sourceTags[database] = value(args, ++index, argument);
    }
  }

  if (!connectionString) throw new Error("TARGET_DATABASE_URL or --connection-string is required");
  if (!sourceEnvironment) throw new Error("--source-env is required for production parity");
  if (!targetEnvironment) throw new Error("--env is required for production parity");
  if (!/^vay1351-[0-9a-f]{24}$/.test(sourceRunId))
    throw new Error("--source-run-id must be an immutable VAY-1351 extraction run ID");
  for (const database of SOURCE_DATABASES)
    if (!sourceTags[database]) throw new Error(`--${database}-source-tag is required`);
  if (!applicationRelease)
    throw new Error("APPLICATION_RELEASE, GIT_SHA, or --application-release is required");
  if (targetEnvironment !== "local" && !/^[0-9a-f]{40}$/.test(applicationRelease))
    throw new Error("Non-local --application-release must be an exact 40-character Git SHA");
  if (
    targetEnvironment !== "local" &&
    (!/^[0-9a-f]{40}$/.test(runtimeApplicationRelease) ||
      runtimeApplicationRelease !== applicationRelease)
  )
    throw new Error(
      "Non-local application release must match APPLICATION_RELEASE or GIT_SHA deployment metadata",
    );
  if (!operator) throw new Error("CUTOVER_OPERATOR, USER, or --operator is required");
  if (!targetMediaBucket || !mediaCdnBaseUrl)
    throw new Error("PLATFORM_MEDIA_BUCKET and PLATFORM_MEDIA_CDN_BASE_URL are required");

  return {
    connectionString,
    sourceRunId,
    sourceTags,
    sourceEnvironment,
    environment: targetEnvironment,
    applicationRelease,
    runtimeApplicationRelease: runtimeApplicationRelease || null,
    operator,
    warningBudget,
    migrationsDir,
    targetMediaBucket,
    mediaCdnBaseUrl,
    report,
  };
}

function value(args: string[], index: number, argument: string): string {
  const result = args[index];
  if (!result || result.startsWith("--")) throw new Error(`${argument} requires a value`);
  return result;
}
