import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  DATABASE_ATTESTATION_TABLE_STATE_SQL,
  DATABASE_ATTESTATION_VALUES_SQL,
} from "./databaseAttestation.js";
import {
  buildSourceExtractionPlan,
  parseSourceExtractionManifest,
  runSourceExtraction,
  SOURCE_EXTRACTION_LOCK_ID,
  SOURCE_PROVENANCE_SQL,
  SOURCE_SNAPSHOT_TIME_SQL,
  SOURCE_WRITABLE_PRIVILEGES_SQL,
  validateSourceExtractionConfig,
  VAY_1350_INVENTORY_REVISION,
  type SourceExtractionConfig,
  type SourceExtractionManifest,
} from "./sourceExtraction.js";
import { parseSourceExtractionArgs } from "./sourceExtractionArgs.js";
import {
  SOURCE_DATABASES,
  SOURCE_READ_ONLY_TRANSACTION_SQL,
  type SourceDatabase,
  type SourceInventoryEntry,
} from "./sourceInventory.js";
import { DEFAULT_REBUILD_SCHEMAS, SOURCE_EXTRACTION_SCHEMAS } from "./targetSchemas.js";
import { ADVISORY_LOCK_ID } from "./runner.js";

const fingerprints: Record<SourceDatabase, string> = {
  auth: "a".repeat(32),
  booking: "b".repeat(32),
  marketplace: "c".repeat(32),
  pms: "d".repeat(32),
};

function makeManifest(): SourceExtractionManifest {
  return {
    version: 1,
    environment: "local",
    sourceSchemaRevision: VAY_1350_INVENTORY_REVISION,
    sources: Object.fromEntries(
      SOURCE_DATABASES.map((sourceDatabase) => [
        sourceDatabase,
        {
          snapshotIdentifier: `fixture:${sourceDatabase}-snapshot`,
          expectedDatabaseName: `${sourceDatabase}_source`,
          expectedSchemaFingerprint: fingerprints[sourceDatabase],
        },
      ]),
    ) as SourceExtractionManifest["sources"],
  };
}

function table(sourceDatabase: SourceDatabase, objectName: string): SourceInventoryEntry {
  return {
    sourceDatabase,
    objectType: "table",
    objectName,
    lifecycle: "active",
    disposition: "migrate",
    targetOwner: sourceDatabase === "auth" ? "identity" : sourceDatabase,
    fixtureCase: "none",
    parityCategory: "test",
    piiClass: "private",
    retentionPolicy: "domain-record",
    cutoverWriter: "none",
    followUp: "VAY-1351",
  };
}

const inventory = [
  table("auth", "public.users"),
  table("auth", "public.login_audit_log"),
  table("booking", "public.booking_hotels"),
  table("marketplace", "public.offers"),
  table("pms", "public.rooms"),
];

function makeConfig(): SourceExtractionConfig {
  const manifest = makeManifest();
  return {
    manifest,
    sourceSchemaRevision: VAY_1350_INVENTORY_REVISION,
    snapshotIdentifiers: Object.fromEntries(
      SOURCE_DATABASES.map((sourceDatabase) => [
        sourceDatabase,
        manifest.sources[sourceDatabase].snapshotIdentifier,
      ]),
    ) as Record<SourceDatabase, string>,
    inventory,
    now: (() => {
      let tick = 0;
      return () => ++tick;
    })(),
  };
}

class FakeSource {
  readonly queries: string[] = [];
  writable = false;
  readOnly = true;
  fingerprint: string;
  attestedSnapshotIdentifier: string | null;
  attestedFreezeProof: string | null = null;
  attestationTable: Map<string, string> | null = null;
  attestationTableTrusted = true;
  failTableOnce: string | null = null;
  private failed = false;
  private currentTable = "";
  private fetched = false;

  constructor(
    readonly sourceDatabase: SourceDatabase,
    readonly rows: Record<string, string[]>,
  ) {
    this.fingerprint = fingerprints[sourceDatabase];
    this.attestedSnapshotIdentifier = `fixture:${sourceDatabase}-snapshot`;
  }

  async query(sql: string) {
    this.queries.push(sql);
    if (sql === SOURCE_WRITABLE_PRIVILEGES_SQL) return result([{ is_writable: this.writable }]);
    if (sql === "SHOW transaction_read_only") {
      return result([{ transaction_read_only: this.readOnly ? "on" : "off" }]);
    }
    if (sql === SOURCE_SNAPSHOT_TIME_SQL)
      return result([{ source_snapshot_at: "2026-08-30T00:00:00.000Z" }]);
    if (sql === SOURCE_PROVENANCE_SQL) {
      return result([
        {
          source_database: `${this.sourceDatabase}_source`,
          snapshot_identifier: this.attestedSnapshotIdentifier,
          cutover_freeze_proof_sha256: this.attestedFreezeProof,
        },
      ]);
    }
    if (sql === DATABASE_ATTESTATION_TABLE_STATE_SQL) {
      return result([
        {
          present: this.attestationTable !== null,
          trusted: this.attestationTable !== null && this.attestationTableTrusted,
        },
      ]);
    }
    if (sql === DATABASE_ATTESTATION_VALUES_SQL) {
      return result(
        [...(this.attestationTable ?? new Map()).entries()].map(
          ([attestation_key, attestation_value]) => ({ attestation_key, attestation_value }),
        ),
      );
    }
    if (sql.includes("WITH schema_items AS")) {
      return result([
        {
          source_database: `${this.sourceDatabase}_source`,
          schema_fingerprint: this.fingerprint,
        },
      ]);
    }
    const countTable = /FROM "[a-z_]+"\."([a-z_]+)"/.exec(sql)?.[1];
    if (sql.startsWith("SELECT count(*)") && countTable) {
      return result([{ row_count: String(this.rows[countTable]?.length ?? 0) }]);
    }
    const declaredTable = /FROM "[a-z_]+"\."([a-z_]+)" AS source_row/.exec(sql)?.[1];
    if (sql.startsWith("DECLARE") && declaredTable) {
      this.currentTable = declaredTable;
      this.fetched = false;
      return result([]);
    }
    if (sql.startsWith("FETCH")) {
      if (this.failTableOnce === this.currentTable && !this.failed) {
        this.failed = true;
        throw new Error("password_hash=never-log-this guest_email=private@example.com");
      }
      if (this.fetched) return result([]);
      this.fetched = true;
      return result((this.rows[this.currentTable] ?? []).map((row_json) => ({ row_json })));
    }
    return result([]);
  }
}

type TableLedger = {
  status: string;
  rowCount: number | null;
  checksum: string | null;
  lastFailureCode: string | null;
};

class FakeTarget {
  readonly queries: string[] = [];
  readonly staged = new Map<string, string>();
  readonly stagedChecksums = new Map<string, string>();
  readonly stagedSnapshots = new Map<string, string>();
  readonly tableLedger = new Map<string, TableLedger>();
  readonly failureCodes: string[] = [];

  async query(sql: string, values: unknown[] = []) {
    this.queries.push(sql);
    if (sql.includes("pg_try_advisory_lock")) return result([{ acquired: true }]);
    if (sql.startsWith("SELECT status, row_count::text")) {
      const key = ledgerKey(values);
      const ledger = this.tableLedger.get(key);
      return result(
        ledger
          ? [
              {
                status: ledger.status,
                row_count: ledger.rowCount === null ? null : String(ledger.rowCount),
                checksum_sha256: ledger.checksum,
                last_failure_code: ledger.lastFailureCode,
              },
            ]
          : [],
      );
    }
    if (sql.startsWith("SELECT snapshot_identifier, row_ordinal::text")) {
      const [runId, sourceSchema, sourceTable, lastOrdinal] = values as string[];
      const prefix = `${runId}:${sourceSchema}:${sourceTable}:`;
      const rows = [...this.staged.entries()]
        .filter(
          ([key]) =>
            key.startsWith(prefix) && Number(key.slice(prefix.length)) > Number(lastOrdinal),
        )
        .sort(
          ([left], [right]) =>
            Number(left.slice(prefix.length)) - Number(right.slice(prefix.length)),
        )
        .slice(0, 500)
        .map(([key, row_data]) => ({
          snapshot_identifier: this.stagedSnapshots.get(key),
          row_ordinal: key.slice(prefix.length),
          row_checksum_sha256: this.stagedChecksums.get(key),
          row_data,
        }));
      return result(rows);
    }
    if (sql.startsWith("INSERT INTO platform.source_extraction_tables")) {
      const key = ledgerKey(values);
      this.tableLedger.set(key, {
        status: "running",
        rowCount: null,
        checksum: null,
        lastFailureCode: this.tableLedger.get(key)?.lastFailureCode ?? null,
      });
      return result([], 1);
    }
    if (sql.startsWith('DELETE FROM "migration_source_')) {
      const [runId, sourceSchema, sourceTable] = values as string[];
      for (const key of this.staged.keys()) {
        if (key.startsWith(`${runId}:${sourceSchema}:${sourceTable}:`)) {
          this.staged.delete(key);
          this.stagedChecksums.delete(key);
          this.stagedSnapshots.delete(key);
        }
      }
      return result([], 1);
    }
    if (sql.startsWith('INSERT INTO "migration_source_')) {
      const [runId, snapshotIdentifier, sourceSchema, sourceTable, ordinals, checksums, rows] =
        values as [string, string, string, string, string[], string[], string[]];
      let inserted = 0;
      for (let index = 0; index < ordinals.length; index += 1) {
        const key = `${runId}:${sourceSchema}:${sourceTable}:${ordinals[index]}`;
        if (!this.staged.has(key)) {
          this.staged.set(key, rows[index]);
          this.stagedChecksums.set(key, checksums[index]);
          this.stagedSnapshots.set(key, snapshotIdentifier);
          inserted += 1;
        }
      }
      return result([], inserted);
    }
    if (sql.startsWith("UPDATE platform.source_extraction_tables")) {
      const key = ledgerKey(values);
      if (sql.includes("status = 'completed'")) {
        this.tableLedger.set(key, {
          status: "completed",
          rowCount: Number(values[4]),
          checksum: String(values[5]),
          lastFailureCode: this.tableLedger.get(key)?.lastFailureCode ?? null,
        });
      } else if (sql.includes("status = 'failed'")) {
        const code = String(values[4]);
        const prior = this.tableLedger.get(key);
        this.tableLedger.set(key, {
          status: "failed",
          rowCount: prior?.rowCount ?? null,
          checksum: prior?.checksum ?? null,
          lastFailureCode: code,
        });
        this.failureCodes.push(code);
      }
      return result([], 1);
    }
    if (sql.includes("status = 'failed'")) {
      this.failureCodes.push(String(values.at(-1)));
    }
    return result([], 1);
  }
}

function ledgerKey(values: unknown[]): string {
  return `${values[1]}:${values[2]}:${values[3]}`;
}

function result(rows: unknown[], rowCount = rows.length) {
  return { command: "", fields: [], oid: 0, rowCount, rows };
}

function makeSources() {
  return {
    auth: new FakeSource("auth", {
      users: [
        '{"id":"user-1","password_hash":"never-log-this"}',
        '{"id":"user-2","guest_email":"private@example.com"}',
      ],
      login_audit_log: ['{"id":"audit-1"}'],
    }),
    booking: new FakeSource("booking", { booking_hotels: ['{"id":"hotel-1"}'] }),
    marketplace: new FakeSource("marketplace", { offers: ['{"id":"offer-1"}'] }),
    pms: new FakeSource("pms", { rooms: ['{"id":"room-1"}'] }),
  };
}

describe("immutable source extraction", () => {
  it("requires the reviewed revision and exact source snapshot tags", () => {
    const config = makeConfig();
    expect(() => validateSourceExtractionConfig(config)).not.toThrow();

    config.snapshotIdentifiers.auth = "fixture:wrong";
    expect(() => validateSourceExtractionConfig(config)).toThrowError(
      expect.objectContaining({ code: "SOURCE_TAG_MISMATCH" }),
    );

    const missing = makeConfig();
    delete (missing.snapshotIdentifiers as Partial<Record<SourceDatabase, string>>).pms;
    expect(() => validateSourceExtractionConfig(missing)).toThrowError(
      expect.objectContaining({ code: "SOURCE_TAG_MISMATCH" }),
    );

    const mutable = makeConfig();
    mutable.manifest.sources.auth.snapshotIdentifier = "database:live-auth";
    mutable.snapshotIdentifiers.auth = "database:live-auth";
    expect(() => validateSourceExtractionConfig(mutable)).toThrowError(
      expect.objectContaining({ code: "MUTABLE_SOURCE_REJECTED" }),
    );

    const frozen = makeConfig();
    frozen.manifest.sources.auth.snapshotIdentifier = "database:frozen-auth";
    frozen.snapshotIdentifiers.auth = "database:frozen-auth";
    frozen.manifest.cutoverFreezeProofSha256 = "e".repeat(64);
    frozen.cutoverFreezeProofSha256 = "e".repeat(64);
    expect(() => validateSourceExtractionConfig(frozen)).not.toThrow();
    expect(buildSourceExtractionPlan(frozen).runId).not.toBe(
      buildSourceExtractionPlan(makeConfig()).runId,
    );

    frozen.cutoverFreezeProofSha256 = "f".repeat(64);
    expect(() => validateSourceExtractionConfig(frozen)).toThrowError(
      expect.objectContaining({ code: "FREEZE_PROOF_MISMATCH" }),
    );

    const stale = makeConfig();
    stale.sourceSchemaRevision = "0".repeat(40);
    expect(() => validateSourceExtractionConfig(stale)).toThrowError(
      expect.objectContaining({ code: "SOURCE_REVISION_MISMATCH" }),
    );
  });

  it("validates the manifest and produces a credential-free dry-run inventory", () => {
    const parsed = parseSourceExtractionManifest(JSON.parse(JSON.stringify(makeManifest())));
    const plan = buildSourceExtractionPlan({ ...makeConfig(), manifest: parsed });
    expect(
      plan.sources.map(({ sourceDatabase, activeTableCount }) => [
        sourceDatabase,
        activeTableCount,
      ]),
    ).toEqual([
      ["auth", 2],
      ["booking", 1],
      ["marketplace", 1],
      ["pms", 1],
    ]);
    expect(JSON.stringify(plan)).not.toMatch(/DATABASE_URL|password_hash|guest_email/);

    const extraSource = JSON.parse(JSON.stringify(makeManifest())) as Record<string, unknown>;
    (extraSource["sources"] as Record<string, unknown>)["unknown"] = {};
    expect(() => parseSourceExtractionManifest(extraSource)).toThrowError(
      expect.objectContaining({ code: "INVALID_MANIFEST" }),
    );

    const secretUrl = "postgres://reviewer:fake-secret@example.test/source";
    const argumentError = (() => {
      try {
        parseSourceExtractionArgs(["node", "sourceExtract", secretUrl]);
      } catch (error) {
        return error as Error;
      }
      throw new Error("expected argument parsing to fail");
    })();
    expect(argumentError.message).toBe("unknown or duplicate argument");
    expect(argumentError.message).not.toContain(secretUrl);
  });

  it("rejects writable, unattested, and schema-drifted sources before reading rows", async () => {
    const writableSources = makeSources();
    writableSources.auth.writable = true;
    await expect(
      runSourceExtraction(makeConfig(), new FakeTarget() as never, writableSources as never),
    ).rejects.toMatchObject({ code: "WRITABLE_SOURCE_REJECTED" });
    expect(writableSources.auth.queries).not.toContain(SOURCE_READ_ONLY_TRANSACTION_SQL);

    const unattestedSources = makeSources();
    unattestedSources.auth.attestedSnapshotIdentifier = "fixture:other-snapshot";
    await expect(
      runSourceExtraction(makeConfig(), new FakeTarget() as never, unattestedSources as never),
    ).rejects.toMatchObject({ code: "SOURCE_PROVENANCE_MISMATCH" });
    expect(unattestedSources.auth.queries.some((query) => query.startsWith("DECLARE"))).toBe(false);

    const driftedSources = makeSources();
    driftedSources.auth.fingerprint = "f".repeat(32);
    await expect(
      runSourceExtraction(makeConfig(), new FakeTarget() as never, driftedSources as never),
    ).rejects.toMatchObject({ code: "SOURCE_SCHEMA_DRIFT" });
    expect(driftedSources.auth.queries.some((query) => query.startsWith("DECLARE"))).toBe(false);
  });

  it("accepts trusted RDS table evidence and rejects conflicting or writable evidence", async () => {
    const tableSources = makeSources();
    tableSources.auth.attestedSnapshotIdentifier = null;
    tableSources.auth.attestationTable = new Map([
      ["vayada.source_snapshot_identifier", "fixture:auth-snapshot"],
    ]);
    await expect(
      runSourceExtraction(makeConfig(), new FakeTarget() as never, tableSources as never),
    ).resolves.toMatchObject({ status: "completed" });

    const conflictingSources = makeSources();
    conflictingSources.auth.attestationTable = new Map([
      ["vayada.source_snapshot_identifier", "fixture:other-snapshot"],
    ]);
    await expect(
      runSourceExtraction(makeConfig(), new FakeTarget() as never, conflictingSources as never),
    ).rejects.toMatchObject({ code: "SOURCE_ATTESTATION_DISAGREEMENT" });

    const untrustedSources = makeSources();
    untrustedSources.auth.attestationTable = new Map([
      ["vayada.source_snapshot_identifier", "fixture:auth-snapshot"],
    ]);
    untrustedSources.auth.attestationTableTrusted = false;
    await expect(
      runSourceExtraction(makeConfig(), new FakeTarget() as never, untrustedSources as never),
    ).rejects.toMatchObject({ code: "UNTRUSTED_SOURCE_ATTESTATION" });
  });

  it("enforces a read-only transaction and redacts unexpected failures", async () => {
    const sources = makeSources();
    sources.auth.readOnly = false;
    const target = new FakeTarget();
    const error = await runSourceExtraction(makeConfig(), target as never, sources as never).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "READ_ONLY_ENFORCEMENT_FAILED" });
    expect((error as Error).message).not.toMatch(/never-log-this|private@example\.com/);
    expect(sources.auth.queries).toContain("SET LOCAL TIME ZONE 'UTC'");
    expect(SOURCE_WRITABLE_PRIVILEGES_SQL).toContain("session_user <> current_user");
  });

  it("resumes a partial run and repeats with identical counts and no duplicates", async () => {
    const sources = makeSources();
    const target = new FakeTarget();
    sources.auth.failTableOnce = "login_audit_log";

    const firstError = await runSourceExtraction(
      makeConfig(),
      target as never,
      sources as never,
    ).catch((caught: unknown) => caught);
    expect(firstError).toMatchObject({ code: "EXTRACTION_FAILED" });
    expect((firstError as Error).message).not.toMatch(/never-log-this|private@example\.com/);
    expect(target.failureCodes).toContain("EXTRACTION_FAILED");

    const second = await runSourceExtraction(makeConfig(), target as never, sources as never);
    const stagedAfterSecondRun = target.staged.size;
    const third = await runSourceExtraction(makeConfig(), target as never, sources as never);

    expect(sources.auth.queries).toContain(SOURCE_SNAPSHOT_TIME_SQL);
    expect(stagedAfterSecondRun).toBe(6);
    expect(target.staged.size).toBe(stagedAfterSecondRun);
    expect(
      third.sources.map(({ sourceDatabase, rowCount, checksumSha256 }) => ({
        sourceDatabase,
        rowCount,
        checksumSha256,
      })),
    ).toEqual(
      second.sources.map(({ sourceDatabase, rowCount, checksumSha256 }) => ({
        sourceDatabase,
        rowCount,
        checksumSha256,
      })),
    );
    expect(
      sources.auth.queries.filter((query) => query.includes('FROM "public"."users" AS')),
    ).toHaveLength(3);
    expect(JSON.stringify(third)).not.toMatch(/never-log-this|private@example\.com/);
  });

  it("detects corrupted staging rows and repairs them on the next retry", async () => {
    const sources = makeSources();
    const target = new FakeTarget();
    await runSourceExtraction(makeConfig(), target as never, sources as never);
    const stagedUser = [...target.staged.keys()].find((key) => key.includes(":public:users:1"));
    expect(stagedUser).toBeDefined();
    target.staged.set(stagedUser!, '{"tampered":true}');

    await expect(
      runSourceExtraction(makeConfig(), target as never, sources as never),
    ).rejects.toMatchObject({ code: "STAGING_CHECKSUM_MISMATCH" });
    const repaired = await runSourceExtraction(makeConfig(), target as never, sources as never);
    expect(repaired.status).toBe("completed");
    expect(target.staged.get(stagedUser!)).not.toBe('{"tampered":true}');
  });

  it("halts retries when source rows change under the same attested snapshot", async () => {
    const sources = makeSources();
    const target = new FakeTarget();
    await runSourceExtraction(makeConfig(), target as never, sources as never);
    sources.auth.rows["users"][0] = '{"id":"changed"}';

    await expect(
      runSourceExtraction(makeConfig(), target as never, sources as never),
    ).rejects.toMatchObject({ code: "SOURCE_IMMUTABILITY_VIOLATION" });
    await expect(
      runSourceExtraction(makeConfig(), target as never, sources as never),
    ).rejects.toMatchObject({ code: "SOURCE_IMMUTABILITY_VIOLATION" });
  });

  it("preserves the source baseline when staging and source change together", async () => {
    const sources = makeSources();
    const target = new FakeTarget();
    await runSourceExtraction(makeConfig(), target as never, sources as never);
    const stagedUser = [...target.staged.keys()].find((key) => key.includes(":public:users:1"));
    target.staged.set(stagedUser!, '{"tampered":true}');
    sources.auth.rows["users"]![0] = '{"id":"changed"}';

    await expect(
      runSourceExtraction(makeConfig(), target as never, sources as never),
    ).rejects.toMatchObject({ code: "SOURCE_IMMUTABILITY_VIOLATION" });
    await expect(
      runSourceExtraction(makeConfig(), target as never, sources as never),
    ).rejects.toMatchObject({ code: "SOURCE_IMMUTABILITY_VIOLATION" });
  });

  it("adds the restart ledger and four raw staging contracts in reviewed SQL", () => {
    const migration = readFileSync(
      new URL("../migrations/0120_immutable_source_extraction.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("platform.source_extraction_runs");
    expect(migration).toContain("platform.source_extraction_tables");
    for (const sourceDatabase of SOURCE_DATABASES) {
      expect(migration).toContain(`'${sourceDatabase}'`);
    }
    expect(migration).toContain("row_data                JSONB");
    expect(DEFAULT_REBUILD_SCHEMAS).toEqual(expect.arrayContaining([...SOURCE_EXTRACTION_SCHEMAS]));
    expect(SOURCE_EXTRACTION_LOCK_ID).toBe(ADVISORY_LOCK_ID);
    expect(SOURCE_WRITABLE_PRIVILEGES_SQL).toContain("has_sequence_privilege");
    expect(SOURCE_WRITABLE_PRIVILEGES_SQL).toContain("has_any_column_privilege");
    expect(SOURCE_WRITABLE_PRIVILEGES_SQL).toContain("pg_auth_members");
    expect(SOURCE_WRITABLE_PRIVILEGES_SQL).toContain("routine.prosecdef");
  });
});
