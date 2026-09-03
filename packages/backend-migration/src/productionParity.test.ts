import { describe, expect, it } from "vitest";

import type { ProductionBookingMigrationReport } from "./productionBookingMigration.js";
import type { ProductionCatalogMigrationReport } from "./productionCatalogMigration.js";
import type { ProductionFinanceMigrationReport } from "./productionFinanceMigration.js";
import type { ProductionIdentityMigrationReport } from "./productionIdentityMigration.js";
import type { ProductionMarketplaceMigrationReport } from "./productionMarketplaceMigration.js";
import {
  formatProductionParityText,
  runProductionParity,
  type ProductionParityConfig,
  type ProductionParityEvidence,
  type ProductionParityServices,
} from "./productionParity.js";
import type { ProductionPmsMigrationReport } from "./productionPmsMigration.js";

const RUN_ID = `vay1351-${"a".repeat(24)}`;
const RELEASE = "b".repeat(40);
const SHA = "c".repeat(64);
const FINGERPRINT = "d".repeat(32);

describe("production migration parity", () => {
  it("returns GO only when extraction, ledger, exposure, and every domain pass", async () => {
    const report = await runProductionParity(config(), services());

    expect(report.decision).toBe("go");
    expect(report.status).toBe("pass");
    expect(report.summary.checkedDomains).toEqual([
      "identity",
      "catalog",
      "booking",
      "pms",
      "marketplace",
      "finance",
    ]);
    expect(report.reportChecksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(formatProductionParityText(report)).toContain("Decision: GO");
  });

  it("requires human review for preserved newer target state even within the warning budget", async () => {
    const reports = domainReports();
    reports.booking.counts.preservedNewerTarget = 1;
    const report = await runProductionParity(
      { ...config(), warningBudget: 1 },
      services({ reports }),
    );

    expect(report.status).toBe("warn");
    expect(report.decision).toBe("review");
    expect(report.findings).toContainEqual(
      expect.objectContaining({ severity: "warn", code: "PRESERVED_NEWER_TARGET_STATE" }),
    );
  });

  it("hard-fails unresolved financial, PII, and raw-media evidence", async () => {
    const reports = domainReports();
    reports.finance.blockers.push({
      code: "UNRESOLVED_PROVIDER_OWNER",
      source: "pms.payments",
      sourceId: "owner@example.com",
      message: "Provider evidence at https://legacy.example/private belongs to owner@example.com",
    });
    const evidence = baseEvidence();
    evidence.piiExposureCount = 2;
    evidence.rawLegacyMediaReferenceCount = 3;

    const report = await runProductionParity(config(), services({ reports, evidence }));
    const serialized = JSON.stringify(report);

    expect(report.decision).toBe("no-go");
    expect(report.findings.map((row) => row.code)).toEqual(
      expect.arrayContaining([
        "UNRESOLVED_PROVIDER_OWNER",
        "PUBLIC_PII_EXPOSURE",
        "RAW_LEGACY_MEDIA_REFERENCE",
      ]),
    );
    expect(serialized).not.toContain("owner@example.com");
    expect(serialized).not.toContain("legacy.example");
    expect(serialized).toContain("sensitive evidence is hash-addressed");
    expect(serialized).toMatch(/sha256:[0-9a-f]{64}/);
  });

  it("hashes arbitrary provider references and names in domain output", async () => {
    const reports = domainReports();
    reports.finance.blockers.push({
      code: "DUPLICATE_BILLING_PROVIDER_REFERENCE",
      source: "finance.billing_entitlements",
      sourceId: "Jane Example / cus_private_123",
      message: "checkoutSessionRef cs_private_456 belongs to Jane Example",
    });
    reports.finance.parity.sourcePaymentAmountsByCurrencyStatusOwner = {
      "EUR:paid:cus_private_123": "10.00",
    };

    const report = await runProductionParity(config(), services({ reports }));
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain("Jane Example");
    expect(serialized).not.toContain("cus_private_123");
    expect(serialized).not.toContain("cs_private_456");
    expect(report.domains.finance?.parity).toEqual({
      checksumSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(report.operator).toBe("[REDACTED]");
  });

  it("hard-fails when any accepted domain result is missing", async () => {
    const base = services();
    const report = await runProductionParity(config(), {
      ...base,
      runDomains: {
        ...base.runDomains,
        finance: async () => {
          throw new Error("finance failed");
        },
      },
    });

    expect(report.decision).toBe("no-go");
    expect(report.summary.checkedDomains).not.toContain("finance");
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "MISSING_DOMAIN_RESULT", owner: "finance" }),
    );
  });

  it("hard-fails schema drift and immutable source-tag mismatch without exposing the tags", async () => {
    const evidence = baseEvidence();
    evidence.sources[0]!.actualSchemaFingerprint = "e".repeat(32);
    evidence.sources[1]!.snapshotIdentifier = "arn:private:unexpected";
    const report = await runProductionParity(config(), services({ evidence }));
    const serialized = JSON.stringify(report);

    expect(report.findings.map((row) => row.code)).toEqual(
      expect.arrayContaining(["SOURCE_SCHEMA_DRIFT", "SOURCE_TAG_MISMATCH"]),
    );
    expect(report.decision).toBe("no-go");
    expect(serialized).not.toContain("arn:private");
  });

  it("produces the same checksum for repeat runs with different timestamps", async () => {
    const first = await runProductionParity(
      config(),
      services({ times: ["2026-08-30T00:00:00.000Z", "2026-08-30T00:01:00.000Z"] }),
    );
    const second = await runProductionParity(
      config(),
      services({ times: ["2026-08-31T00:00:00.000Z", "2026-08-31T00:01:00.000Z"] }),
    );

    expect(first.startedAt).not.toBe(second.startedAt);
    expect(first.reportChecksumSha256).toBe(second.reportChecksumSha256);
  });

  it("hard-fails an active/future booking lifecycle swap even when totals match", async () => {
    const reports = domainReports();
    reports.booking.parity.activeFutureTargetBookings["booking-1"]!.lifecycleStatus =
      "pending_payment";

    const report = await runProductionParity(config(), services({ reports }));

    expect(report.decision).toBe("no-go");
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "ACTIVE_BOOKING_LIFECYCLE_VARIANCE" }),
    );
  });

  it("hard-fails a missing active/future booking", async () => {
    const reports = domainReports();
    delete reports.booking.parity.activeFutureTargetBookings["booking-1"];

    const report = await runProductionParity(config(), services({ reports }));

    expect(report.decision).toBe("no-go");
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "ACTIVE_BOOKING_LIFECYCLE_VARIANCE" }),
    );
  });

  it("hard-fails unapplied domain inserts even when planned parity would match", async () => {
    const reports = domainReports();
    reports.booking.counts.inserts = 1;
    reports.booking.counts.unchanged = 0;

    const report = await runProductionParity(config(), services({ reports }));

    expect(report.decision).toBe("no-go");
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "UNAPPLIED_DOMAIN_CHANGES", owner: "booking" }),
    );
  });

  it("hard-fails unapplied identity writes", async () => {
    const reports = domainReports();
    reports.identity.counts.pendingTargetWrites = 1;

    const report = await runProductionParity(config(), services({ reports }));

    expect(report.decision).toBe("no-go");
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "UNAPPLIED_DOMAIN_CHANGES", owner: "identity" }),
    );
  });

  it("hard-fails when an active room type has no exact 366-day inventory horizon", async () => {
    const reports = domainReports();
    reports.pms.parity.expectedActiveRoomTypesByProperty.property!.push("room-type-2");

    const report = await runProductionParity(config(), services({ reports }));

    expect(report.decision).toBe("no-go");
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "FUTURE_INVENTORY_VARIANCE" }),
    );
  });

  it("enforces a full release Git SHA in the core runner outside local", async () => {
    await expect(
      runProductionParity(
        {
          ...config(),
          sourceEnvironment: "preprod",
          environment: "production",
          applicationRelease: "short",
        },
        services(),
      ),
    ).rejects.toThrow("full lowercase Git SHA");
  });

  it("rejects a local fixture extraction for a production target", async () => {
    await expect(
      runProductionParity(
        {
          ...config(),
          environment: "production",
          runtimeApplicationRelease: RELEASE,
        },
        services(),
      ),
    ).rejects.toThrow("production target parity requires a preprod extraction");
  });

  it("attests the application release separately from the checksum-bound migration set", async () => {
    const evidence = baseEvidence();
    evidence.extraction!.environment = "preprod";
    evidence.extraction!.cutoverFreezeProofSha256 = SHA;
    evidence.migrationLedger[0]!.environment = "production";
    evidence.migrationLedger[0]!.gitSha = "e".repeat(40);

    const report = await runProductionParity(
      {
        ...config(),
        sourceEnvironment: "preprod",
        environment: "production",
        runtimeApplicationRelease: RELEASE,
      },
      services({ evidence }),
    );

    expect(report.decision).toBe("go");
    expect(report.applicationRelease).toBe(RELEASE);
  });
});

function config(): ProductionParityConfig {
  return {
    connectionString: "postgresql://target.invalid/vayada",
    sourceRunId: RUN_ID,
    sourceTags: {
      auth: "arn:immutable:auth",
      booking: "arn:immutable:booking",
      marketplace: "arn:immutable:marketplace",
      pms: "arn:immutable:pms",
    },
    sourceEnvironment: "local",
    environment: "local",
    applicationRelease: RELEASE,
    operator: "cutover-operator",
    warningBudget: 0,
    migrationsDir: "/migrations",
    targetMediaBucket: "platform-media-test",
    mediaCdnBaseUrl: "https://media.example.test",
  };
}

function baseEvidence(): ProductionParityEvidence {
  return {
    extraction: {
      runId: RUN_ID,
      environment: "local",
      sourceSchemaRevision: "f".repeat(40),
      cutoverFreezeProofSha256: null,
      status: "completed",
    },
    sources: (["auth", "booking", "marketplace", "pms"] as const).map((sourceDatabase) => ({
      sourceDatabase,
      snapshotIdentifier: `arn:immutable:${sourceDatabase}`,
      expectedSchemaFingerprint: FINGERPRINT,
      actualSchemaFingerprint: FINGERPRINT,
      status: "completed",
      rowCount: 1,
      checksumSha256: SHA,
      tableCount: 1,
      tableRowCount: 1,
      failedTableCount: 0,
    })),
    migrationLedger: [
      {
        version: "0001",
        name: "identity",
        checksumSha256: SHA,
        expectedChecksumSha256: SHA,
        environment: "local",
        gitSha: RELEASE,
        runnerVersion: "0.1.0",
        status: "applied",
        appliedAt: "2026-08-30 00:00:00+00",
      },
    ],
    missingMigrationVersions: [],
    unexpectedMigrationVersions: [],
    piiExposureCount: 0,
    rawLegacyMediaReferenceCount: 0,
    staleProvenanceCount: 0,
  };
}

function domainReports(): {
  identity: ProductionIdentityMigrationReport;
  catalog: ProductionCatalogMigrationReport;
  booking: ProductionBookingMigrationReport;
  pms: ProductionPmsMigrationReport;
  marketplace: ProductionMarketplaceMigrationReport;
  finance: ProductionFinanceMigrationReport;
} {
  const reconciliationCounts = {
    sourceRows: 1,
    plannedRecords: 1,
    inserts: 0,
    updates: 0,
    unchanged: 1,
    preservedNewerTarget: 0,
    preservedTargetDeletions: 0,
  };
  return {
    identity: {
      sourceRunId: RUN_ID,
      mode: "dry-run",
      applied: false,
      checksum: SHA,
      counts: {
        users: 1,
        preservedNewerUsers: 0,
        retiredDuplicateUsers: 0,
        quarantinedUsers: 0,
        quarantinedOrganizations: 0,
        quarantinedResourceLinks: 0,
        pendingTargetWrites: 0,
        organizations: 1,
        memberships: 1,
        resourceLinks: 1,
        entitlements: 1,
        workosIdentities: 1,
        userConsents: 0,
        cookieConsents: 0,
        consentHistory: 0,
        gdprRequests: 0,
        loginAuditEvents: 0,
        retiredAuthRows: 0,
      },
      retiredAuthRows: {},
      blockers: [],
    },
    catalog: {
      sourceRunId: RUN_ID,
      mode: "dry-run",
      applied: false,
      checksum: SHA,
      counts: {
        properties: 1,
        sourceLinks: 1,
        quarantinedSourceRows: 0,
        slugs: 1,
        domains: 0,
        locations: 1,
        profiles: 1,
        amenities: 0,
        contacts: 0,
        policies: 0,
        media: 0,
        writes: 0,
        preservedTarget: 0,
      },
      quarantinedSources: [],
      preservedTarget: [],
      blockers: [],
    },
    booking: {
      sourceRunId: RUN_ID,
      mode: "dry-run",
      applied: false,
      checksum: SHA,
      counts: { ...reconciliationCounts },
      parity: {
        sourceTableCounts: { "pms.bookings": 1 },
        targetTableCounts: { "booking.guest_bookings": 1 },
        sourceBookingStatuses: { confirmed: 1 },
        plannedBookingLifecycleStatuses: { confirmed: 1 },
        activeFutureSourceBookings: {
          "booking-1": {
            lifecycleStatus: "confirmed",
            checkIn: "2026-09-01",
            checkOut: "2026-09-02",
          },
        },
        activeFutureTargetBookings: {
          "booking-1": {
            lifecycleStatus: "confirmed",
            checkIn: "2026-09-01",
            checkOut: "2026-09-02",
          },
        },
        sourceDraftMaterialization: {},
        plannedDraftStatuses: {},
      },
      quarantines: [],
      inferences: [],
      blockers: [],
    },
    pms: {
      sourceRunId: RUN_ID,
      mode: "dry-run",
      applied: false,
      checksum: SHA,
      counts: { ...reconciliationCounts },
      parity: {
        sourceTableCounts: { "pms.hotels": 1 },
        targetTableCounts: { "pms.inventory_days": 366 },
        sourceCountsByProperty: { property: { hotels: 1 } },
        targetCountsByProperty: { property: { inventory_days: 366 } },
        futureInventoryByProperty: {
          property: { days: 366, assigned: 0, blocked: 0, available: 366, stopSell: 0 },
        },
        expectedActiveRoomTypesByProperty: { property: ["room-type-1"] },
        actualActiveRoomTypesByProperty: { property: ["room-type-1"] },
        futureInventoryByRoomType: {
          "room-type-1": {
            propertyId: "property",
            roomTypeId: "room-type-1",
            firstStayDate: "2026-08-30",
            lastStayDate: "2027-08-30",
            distinctDays: 366,
            rows: 366,
          },
        },
      },
      blockers: [],
    },
    marketplace: {
      sourceRunId: RUN_ID,
      mode: "dry-run",
      applied: false,
      checksum: SHA,
      counts: {
        ...reconciliationCounts,
        quarantinedValues: 0,
        quarantinedSourceRows: 0,
      },
      quarantineCountsByReason: {},
      parity: {
        sourceTableCounts: { "marketplace.creator_profiles": 1 },
        targetTableCounts: { "marketplace.creator_profiles": 1 },
        sourceCountsByProperty: {},
        targetCountsByProperty: {},
        preferenceDraftsByProperty: {},
      },
      blockers: [],
    },
    finance: {
      sourceRunId: RUN_ID,
      mode: "dry-run",
      applied: false,
      checksum: SHA,
      counts: { ...reconciliationCounts },
      parity: {
        sourceTableCounts: {},
        targetTableCounts: {},
        sourcePaymentAmountsByCurrencyStatusOwner: {},
        targetPaymentAmountsByCurrencyStatusOwner: {},
        sourcePaymentCountsByCurrencyStatusOwner: {},
        targetPaymentCountsByCurrencyStatusOwner: {},
        sourcePaymentFeesByCurrencyStatusOwner: {},
        targetPaymentFeesByCurrencyStatusOwner: {},
        sourcePaymentNetByCurrencyStatusOwner: {},
        targetPaymentNetByCurrencyStatusOwner: {},
        sourcePaymentRefundsByCurrencyStatusOwner: {},
        targetPaymentRefundsByCurrencyStatusOwner: {},
        sourcePayoutAmountsByCurrencyStatusOwner: {},
        targetPayoutAmountsByCurrencyStatusOwner: {},
        sourcePayoutCountsByCurrencyStatusOwner: {},
        targetPayoutCountsByCurrencyStatusOwner: {},
        sourcePayoutNetByCurrencyStatusOwner: {},
        targetPayoutNetByCurrencyStatusOwner: {},
        sourcePayoutAllocationsByBookingOwner: {},
        targetPayoutAllocationsByBookingOwner: {},
      },
      blockers: [],
    },
  };
}

function services(
  input: {
    reports?: ReturnType<typeof domainReports>;
    evidence?: ProductionParityEvidence;
    times?: string[];
  } = {},
): ProductionParityServices {
  const reports = input.reports ?? domainReports();
  const times = [...(input.times ?? ["2026-08-30T00:00:00.000Z", "2026-08-30T00:01:00.000Z"])];
  return {
    withTargetWriteFreeze: async (_config, run) => run(),
    readEvidence: async () => structuredClone(input.evidence ?? baseEvidence()),
    runDomains: {
      identity: async () => structuredClone(reports.identity),
      catalog: async () => structuredClone(reports.catalog),
      booking: async () => structuredClone(reports.booking),
      pms: async () => structuredClone(reports.pms),
      marketplace: async () => structuredClone(reports.marketplace),
      finance: async () => structuredClone(reports.finance),
    },
    now: () => times.shift() ?? "2026-08-30T00:02:00.000Z",
  };
}
