import {
  parsePmsCanonicalIanaTimeZone,
  type PmsOperatingCalendarPropertyProfileEvidencePort,
  type PmsOperatingCalendarPropertyProfileEvidenceResult,
} from "@vayada/domain-pms";
import { getTimezone } from "countries-and-timezones";
import pg, { type QueryResult, type QueryResultRow } from "pg";

export const HOTEL_CATALOG_OPERATING_CALENDAR_TIME_ZONE_REGISTRY_VERSION =
  "countries-and-timezones@3.9.0" as const;

export type HotelCatalogOperatingCalendarPropertyProfileEvidenceClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type HotelCatalogOperatingCalendarPropertyProfileEvidencePool = {
  connect(): Promise<HotelCatalogOperatingCalendarPropertyProfileEvidenceClient>;
  end(): Promise<void>;
};

export type HotelCatalogOperatingCalendarPropertyProfileEvidencePort =
  PmsOperatingCalendarPropertyProfileEvidencePort;

type PropertyProfileRow = {
  propertyId: string;
  profileRevision: number | string;
  timeZone: unknown;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort(config: {
  connectionString?: string;
  max?: number;
  pool?: HotelCatalogOperatingCalendarPropertyProfileEvidencePool;
}): HotelCatalogOperatingCalendarPropertyProfileEvidencePort & { close(): Promise<void> } {
  const ownsPool = !config.pool;
  if (ownsPool && !config.connectionString?.trim()) {
    throw new Error("Hotel Catalog operating-calendar evidence connectionString must not be empty");
  }
  const pool: HotelCatalogOperatingCalendarPropertyProfileEvidencePool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });

  return {
    ...TIME_ZONE_REGISTRY,

    async runWithPropertyProfileEvidence(input, guarded) {
      const propertyId = canonicalUuid(input.propertyId);
      positiveRevision(input.expectedProfileRevision);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const selected = await client.query<PropertyProfileRow>(
          `SELECT property.id::text AS "propertyId",
                  property.profile_revision AS "profileRevision",
                  location.timezone AS "timeZone"
           FROM hotel_catalog.properties property
           LEFT JOIN hotel_catalog.property_locations location
             ON location.property_id = property.id
           WHERE property.id = $1::uuid
           FOR SHARE OF property`,
          [propertyId],
        );
        if (selected.rows.length > 1) {
          throw new Error("Hotel Catalog property-profile evidence is not unique");
        }
        const row = selected.rows[0];
        if (!row) throw new Error("Hotel Catalog property-profile evidence is unavailable");
        if (canonicalUuid(row.propertyId) !== propertyId) {
          throw new Error("Hotel Catalog property-profile evidence escaped its property scope");
        }
        const source = Object.freeze({
          ownerDomain: "hotel_catalog" as const,
          entityType: "property_profile" as const,
          entityId: propertyId,
          revision: `profile:${positiveRevision(row.profileRevision)}`,
        });
        const evidence = evidenceResult(source, row.timeZone);
        const result = await guarded(evidence);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await rollbackQuietly(client);
        throw error;
      } finally {
        client.release();
      }
    },

    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

function evidenceResult(
  source: Extract<
    PmsOperatingCalendarPropertyProfileEvidenceResult,
    { status: "timezone_missing" }
  >["source"],
  timeZone: unknown,
): PmsOperatingCalendarPropertyProfileEvidenceResult {
  if (timeZone === null || timeZone === "") {
    return Object.freeze({ status: "timezone_missing" as const, source });
  }
  if (typeof timeZone !== "string") {
    throw new Error("Hotel Catalog property-profile timezone row is invalid");
  }
  const parsedTimeZone = parsePmsCanonicalIanaTimeZone(timeZone, TIME_ZONE_REGISTRY);
  if (!parsedTimeZone) {
    return Object.freeze({ status: "timezone_invalid" as const, source });
  }
  return Object.freeze({
    status: "available" as const,
    evidence: Object.freeze({ source, timeZone: parsedTimeZone }),
  });
}

function isCanonicalIanaTimeZone(value: string): boolean {
  try {
    const timezone = getTimezone(value);
    return timezone !== null && timezone.name === value && timezone.aliasOf === null;
  } catch {
    return false;
  }
}

const TIME_ZONE_REGISTRY = Object.freeze({
  ownerDomain: "hotel_catalog" as const,
  registryVersion: HOTEL_CATALOG_OPERATING_CALENDAR_TIME_ZONE_REGISTRY_VERSION,
  isCanonicalIanaTimeZone,
});

function canonicalUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new TypeError("Hotel Catalog property-profile evidence property ID is invalid");
  }
  return value.toLowerCase();
}

function positiveRevision(value: number | string): number {
  const revision = typeof value === "number" ? value : Number(value);
  if (
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    revision > 2_147_483_647 ||
    (typeof value === "string" && !/^[1-9][0-9]*$/.test(value))
  ) {
    throw new Error("Hotel Catalog property-profile evidence revision is invalid");
  }
  return revision;
}

async function rollbackQuietly(
  client: HotelCatalogOperatingCalendarPropertyProfileEvidenceClient,
): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the owner evidence or callback failure.
  }
}
