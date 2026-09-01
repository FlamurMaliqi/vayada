export const SOURCE_DATABASES = ["auth", "booking", "marketplace", "pms"] as const;

export type SourceDatabase = (typeof SOURCE_DATABASES)[number];
export type SourceObjectType =
  | "background_writer"
  | "extension"
  | "manual_writer"
  | "materialized_view"
  | "object_prefix"
  | "object_reference"
  | "object_store"
  | "provider_control"
  | "scheduler"
  | "sequence"
  | "table"
  | "view"
  | "webhook";
export type SourceLifecycle = "active" | "dev_only" | "dropped" | "manual_only";
export type SourceDisposition = "migrate" | "retire" | "snapshot_only" | "transform";
export type TargetOwner =
  | "booking"
  | "finance"
  | "hotel_catalog"
  | "identity"
  | "marketplace"
  | "none"
  | "platform"
  | "pms";

export const RETENTION_POLICIES = {
  "cutover-control": {
    owner: "VAY-1360",
    deleteRule: "Retain no source rows; target operational logs follow the target owner policy.",
  },
  "domain-record": {
    owner: "target-domain",
    deleteRule:
      "Retain target rows per domain policy; destroy source copies after the rollback window.",
  },
  "media-lifecycle": {
    owner: "VAY-1055",
    deleteRule:
      "Preserve old objects through media parity and rollback, then delete per visibility and rights policy.",
  },
  "migration-evidence": {
    owner: "VAY-1363",
    deleteRule:
      "Keep secret-free manifests; destroy row-bearing snapshots after the approved rollback window.",
  },
  "pii-lifecycle": {
    owner: "target-domain",
    deleteRule:
      "Apply data-subject and legal rules in target; destroy source copies after the rollback window.",
  },
  "rollback-window": {
    owner: "VAY-1363",
    deleteRule:
      "Never load into target; encrypt until rollback expiry, then destroy with recorded evidence.",
  },
} as const;
export type RetentionPolicy = keyof typeof RETENTION_POLICIES;

export interface SourceInventoryEntry {
  sourceDatabase: SourceDatabase;
  objectType: SourceObjectType;
  objectName: string;
  lifecycle: SourceLifecycle;
  disposition: SourceDisposition;
  targetOwner: TargetOwner;
  fixtureCase: string;
  parityCategory: string;
  piiClass: "conditional" | "none" | "pii" | "private" | "public" | "retired";
  retentionPolicy: RetentionPolicy;
  cutoverWriter: string;
  followUp: string;
}

export const SOURCE_INVENTORY_HEADERS = [
  "source_database",
  "object_type",
  "object_name",
  "lifecycle",
  "disposition",
  "target_owner",
  "fixture_case",
  "parity_category",
  "pii_class",
  "retention_policy",
  "cutover_writer",
  "follow_up",
] as const;

const OBJECT_TYPES: readonly SourceObjectType[] = [
  "background_writer",
  "extension",
  "manual_writer",
  "materialized_view",
  "object_prefix",
  "object_reference",
  "object_store",
  "provider_control",
  "scheduler",
  "sequence",
  "table",
  "view",
  "webhook",
];
const LIFECYCLES: readonly SourceLifecycle[] = ["active", "dev_only", "dropped", "manual_only"];
const DISPOSITIONS: readonly SourceDisposition[] = [
  "migrate",
  "retire",
  "snapshot_only",
  "transform",
];
const TARGET_OWNERS: readonly TargetOwner[] = [
  "booking",
  "finance",
  "hotel_catalog",
  "identity",
  "marketplace",
  "none",
  "platform",
  "pms",
];
const PII_CLASSES: readonly SourceInventoryEntry["piiClass"][] = [
  "conditional",
  "none",
  "pii",
  "private",
  "public",
  "retired",
];
const RETENTION_POLICY_NAMES = Object.keys(RETENTION_POLICIES) as RetentionPolicy[];

function assertAllowed<T extends string>(
  value: string,
  allowed: readonly T[],
  field: string,
  lineNumber: number,
): asserts value is T {
  if (!allowed.includes(value as T)) {
    throw new Error(`Invalid ${field} '${value}' on source inventory line ${lineNumber}`);
  }
}

export function parseSourceInventory(input: string): SourceInventoryEntry[] {
  const lines = input.trimEnd().split(/\r?\n/);
  const headers = lines.shift()?.split("\t") ?? [];
  if (headers.join("\t") !== SOURCE_INVENTORY_HEADERS.join("\t")) {
    throw new Error("Source inventory headers do not match the required contract");
  }

  const seen = new Set<string>();
  return lines.filter(Boolean).map((line, index) => {
    const lineNumber = index + 2;
    const cells = line.split("\t");
    if (cells.length !== SOURCE_INVENTORY_HEADERS.length) {
      throw new Error(`Expected ${SOURCE_INVENTORY_HEADERS.length} fields on line ${lineNumber}`);
    }

    const [
      sourceDatabase,
      objectType,
      objectName,
      lifecycle,
      disposition,
      targetOwner,
      fixtureCase,
      parityCategory,
      piiClass,
      retentionPolicy,
      cutoverWriter,
      followUp,
    ] = cells as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];

    assertAllowed(sourceDatabase, SOURCE_DATABASES, "source_database", lineNumber);
    assertAllowed(objectType, OBJECT_TYPES, "object_type", lineNumber);
    assertAllowed(lifecycle, LIFECYCLES, "lifecycle", lineNumber);
    assertAllowed(disposition, DISPOSITIONS, "disposition", lineNumber);
    assertAllowed(targetOwner, TARGET_OWNERS, "target_owner", lineNumber);
    assertAllowed(piiClass, PII_CLASSES, "pii_class", lineNumber);
    assertAllowed(retentionPolicy, RETENTION_POLICY_NAMES, "retention_policy", lineNumber);

    const key = `${sourceDatabase}:${objectType}:${objectName}`;
    if (seen.has(key)) throw new Error(`Duplicate source inventory object ${key}`);
    seen.add(key);

    const hasTarget = targetOwner !== "none";
    const carriesForward = disposition === "migrate" || disposition === "transform";
    if (hasTarget !== carriesForward) {
      throw new Error(`Source inventory object ${key} has an inconsistent target owner`);
    }
    if (!fixtureCase || !parityCategory || !cutoverWriter || !/^VAY-\d+$/.test(followUp)) {
      throw new Error(`Source inventory object ${key} has an incomplete migration contract`);
    }

    return {
      sourceDatabase,
      objectType,
      objectName,
      lifecycle,
      disposition,
      targetOwner,
      fixtureCase,
      parityCategory,
      piiClass,
      retentionPolicy,
      cutoverWriter,
      followUp,
    };
  });
}

export const REQUIRED_SOURCE_SNAPSHOT_ARGUMENTS = SOURCE_DATABASES.map(
  (sourceDatabase) => `--${sourceDatabase}-snapshot-arn` as const,
);
export const REQUIRED_SOURCE_REVISION_ARGUMENT = "--source-schema-revision" as const;
export const SOURCE_READ_ONLY_TRANSACTION_SQL =
  "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY";

export const SOURCE_SCHEMA_FINGERPRINT_SQL = `
WITH schema_items AS (
  SELECT format('relation|%s|%s|%s', n.nspname, c.relname, c.relkind) AS item
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname NOT IN ('information_schema', 'pg_catalog', 'vayada_migration_evidence')
    AND n.nspname !~ '^pg_toast'
  UNION ALL
  SELECT format('column|%s|%s|%s|%s|%s|%s', n.nspname, c.relname, a.attname,
                pg_catalog.format_type(a.atttypid, a.atttypmod), a.attnotnull,
                pg_catalog.pg_get_expr(d.adbin, d.adrelid))
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attnum > 0 AND NOT a.attisdropped
    AND n.nspname NOT IN ('information_schema', 'pg_catalog', 'vayada_migration_evidence')
    AND n.nspname !~ '^pg_toast'
  UNION ALL
  SELECT format('constraint|%s|%s|%s|%s', n.nspname, c.relname, x.conname,
                pg_catalog.pg_get_constraintdef(x.oid, true))
  FROM pg_catalog.pg_constraint x
  JOIN pg_catalog.pg_class c ON c.oid = x.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname NOT IN ('information_schema', 'pg_catalog', 'vayada_migration_evidence')
  UNION ALL
  SELECT format('index|%s|%s|%s', schemaname, indexname, indexdef)
  FROM pg_catalog.pg_indexes
  WHERE schemaname NOT IN ('information_schema', 'pg_catalog', 'vayada_migration_evidence')
  UNION ALL
  SELECT format('view|%s|%s|%s', n.nspname, c.relname,
                pg_catalog.pg_get_viewdef(c.oid, true))
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('v', 'm')
    AND n.nspname NOT IN ('information_schema', 'pg_catalog', 'vayada_migration_evidence')
  UNION ALL
  SELECT format('sequence|%s|%s|%s|%s|%s|%s|%s|%s|%s', n.nspname, c.relname,
                s.seqtypid::regtype, s.seqstart, s.seqincrement, s.seqmax,
                s.seqmin, s.seqcache, s.seqcycle)
  FROM pg_catalog.pg_sequence s
  JOIN pg_catalog.pg_class c ON c.oid = s.seqrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname NOT IN ('information_schema', 'pg_catalog', 'vayada_migration_evidence')
  UNION ALL
  SELECT format('enum|%s|%s|%s|%s', n.nspname, t.typname, e.enumlabel, e.enumsortorder)
  FROM pg_catalog.pg_type t
  JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
  JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
  WHERE n.nspname NOT IN ('information_schema', 'pg_catalog', 'vayada_migration_evidence')
    AND n.nspname !~ '^pg_toast'
  UNION ALL
  SELECT format('extension|%s|%s', extname, extversion) FROM pg_catalog.pg_extension
)
SELECT current_database() AS source_database,
       md5(string_agg(item, E'\n' ORDER BY item)) AS schema_fingerprint
FROM schema_items`;

export function buildSourceRowCountQueries(
  inventory: readonly SourceInventoryEntry[],
  sourceDatabase: SourceDatabase,
): Array<{ objectName: string; sql: string }> {
  return inventory
    .filter(
      (entry) =>
        entry.sourceDatabase === sourceDatabase &&
        entry.objectType === "table" &&
        entry.lifecycle === "active",
    )
    .map(({ objectName }) => {
      const match = /^(?<schema>[a-z_][a-z0-9_]*)\.(?<table>[a-z_][a-z0-9_]*)$/.exec(objectName);
      if (!match?.groups) throw new Error(`Unsafe source table name '${objectName}'`);
      const { schema, table } = match.groups;
      return {
        objectName,
        sql: `SELECT count(*)::bigint AS row_count FROM "${schema}"."${table}"`,
      };
    });
}
