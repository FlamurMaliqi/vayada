import { SOURCE_DATABASES } from "./sourceInventory.js";

export const PRODUCTION_CUTOVER_COMMANDS = [
  "rehearse-staging",
  "dry-run",
  "cutover",
  "status",
  "abort",
] as const;
export type ProductionCutoverCommand = (typeof PRODUCTION_CUTOVER_COMMANDS)[number];

export type ParsedProductionCutoverArgs = {
  command: ProductionCutoverCommand;
  values: Map<string, string>;
  resume: boolean;
  report: "json" | "text";
};

export class ProductionCutoverArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionCutoverArgsError";
  }
}

const VALUE_ARGUMENTS = new Set([
  "--run-id",
  "--source-run-id",
  "--source-env",
  "--env",
  "--manifest",
  "--source-schema-revision",
  "--application-release",
  "--operator",
  "--target-clean-proof-sha256",
  "--freeze-proof-sha256",
  "--smoke-report",
  "--backup-proof-sha256",
  "--approved-run-id",
  "--approved-run-report",
  "--approved-report-checksum-sha256",
  "--approved-decision",
  "--approval-proof-sha256",
  "--approval-report",
  "--confirmation",
  "--report",
  ...SOURCE_DATABASES.map((database) => `--${database}-source-tag`),
]);

export function parseProductionCutoverArgs(argv: string[]): ParsedProductionCutoverArgs {
  const command = argv[2];
  if (!PRODUCTION_CUTOVER_COMMANDS.includes(command as ProductionCutoverCommand))
    throw new ProductionCutoverArgsError("A valid cutover command is required");
  const parsedCommand = command as ProductionCutoverCommand;
  const values = new Map<string, string>();
  let resume = false;
  for (let index = 3; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--resume") {
      if (resume) throw new ProductionCutoverArgsError("Duplicate --resume argument");
      resume = true;
      continue;
    }
    if (!VALUE_ARGUMENTS.has(argument) || values.has(argument))
      throw new ProductionCutoverArgsError(`Unknown or duplicate argument: ${argument}`);
    const value = argv[++index];
    if (!value || value.startsWith("--"))
      throw new ProductionCutoverArgsError(`${argument} requires a value`);
    values.set(argument, value);
  }
  const report = values.get("--report") ?? "text";
  if (report !== "json" && report !== "text")
    throw new ProductionCutoverArgsError("--report must be json or text");
  if (parsedCommand === "status") return { command: parsedCommand, values, resume, report };
  for (const argument of ["--run-id", "--operator", "--confirmation"])
    if (!values.has(argument)) throw new ProductionCutoverArgsError(`${argument} is required`);
  if (parsedCommand === "abort") return { command: parsedCommand, values, resume, report };
  for (const argument of [
    "--source-run-id",
    "--source-env",
    "--env",
    "--manifest",
    "--source-schema-revision",
    "--application-release",
    "--target-clean-proof-sha256",
    "--freeze-proof-sha256",
    ...SOURCE_DATABASES.map((database) => `--${database}-source-tag`),
  ])
    if (!values.has(argument)) throw new ProductionCutoverArgsError(`${argument} is required`);
  if (parsedCommand === "cutover") {
    for (const argument of [
      "--backup-proof-sha256",
      "--approved-run-id",
      "--approved-run-report",
      "--approved-report-checksum-sha256",
      "--approved-decision",
      "--approval-proof-sha256",
      "--approval-report",
    ])
      if (!values.has(argument)) throw new ProductionCutoverArgsError(`${argument} is required`);
    if (values.get("--approved-decision") !== "go")
      throw new ProductionCutoverArgsError("--approved-decision must be go");
  }
  return { command: parsedCommand, values, resume, report };
}
