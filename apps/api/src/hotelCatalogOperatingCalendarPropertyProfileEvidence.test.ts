import { describe, expect, it, vi } from "vitest";

import {
  HOTEL_CATALOG_OPERATING_CALENDAR_TIME_ZONE_REGISTRY_VERSION,
  createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort,
  type HotelCatalogOperatingCalendarPropertyProfileEvidenceClient,
  type HotelCatalogOperatingCalendarPropertyProfileEvidencePool,
} from "./domains/hotelCatalogOperatingCalendarPropertyProfileEvidence.js";

const propertyId = "A4000000-0000-4000-8000-000000000001";
const normalizedPropertyId = propertyId.toLowerCase();

describe("Hotel Catalog operating-calendar property-profile evidence", () => {
  it("guards and returns exact canonical source evidence without exposing owner rows", async () => {
    const fixture = fakePool({
      propertyId: normalizedPropertyId,
      profileRevision: "7",
      timeZone: "Europe/Berlin",
    });
    const port = createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort({
      pool: fixture.pool,
    });
    const guarded = vi.fn(async (result) => ({ result }));

    await expect(
      port.runWithPropertyProfileEvidence({ propertyId, expectedProfileRevision: 6 }, guarded),
    ).resolves.toEqual({
      result: {
        status: "available",
        evidence: {
          source: {
            ownerDomain: "hotel_catalog",
            entityType: "property_profile",
            entityId: normalizedPropertyId,
            revision: "profile:7",
          },
          timeZone: "Europe/Berlin",
        },
      },
    });
    expect(port.ownerDomain).toBe("hotel_catalog");
    expect(port.registryVersion).toBe(HOTEL_CATALOG_OPERATING_CALENDAR_TIME_ZONE_REGISTRY_VERSION);
    expect(port.isCanonicalIanaTimeZone("Europe/Berlin")).toBe(true);
    expect(port.isCanonicalIanaTimeZone("US/Eastern")).toBe(false);
    expect(
      ["Europe/Kyiv", "Asia/Kolkata", "America/Nuuk", "Etc/UTC"].every((value) =>
        port.isCanonicalIanaTimeZone(value),
      ),
    ).toBe(true);
    expect(
      ["Europe/Kiev", "Asia/Calcutta", "America/Godthab", "UTC"].every(
        (value) => !port.isCanonicalIanaTimeZone(value),
      ),
    ).toBe(true);
    expect(fixture.calls.map(({ text }) => text)).toEqual([
      "BEGIN",
      expect.stringContaining("FOR SHARE OF property"),
      "COMMIT",
    ]);
    expect(fixture.calls[1]?.values).toEqual([normalizedPropertyId]);
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it.each([
    [null, "timezone_missing"],
    ["", "timezone_missing"],
    ["   ", "timezone_invalid"],
    ["US/Eastern", "timezone_invalid"],
    ["europe/Berlin", "timezone_invalid"],
    ["Europe/Berlin ", "timezone_invalid"],
    ["Mars/Olympus_Mons", "timezone_invalid"],
  ] as const)("returns only source identity for timezone %j", async (timeZone, status) => {
    const fixture = fakePool({ propertyId: normalizedPropertyId, profileRevision: 8, timeZone });
    const port = createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort({
      pool: fixture.pool,
    });

    const result = await port.runWithPropertyProfileEvidence(
      { propertyId: normalizedPropertyId, expectedProfileRevision: 7 },
      async (evidence) => evidence,
    );

    expect(result).toEqual({
      status,
      source: {
        ownerDomain: "hotel_catalog",
        entityType: "property_profile",
        entityId: normalizedPropertyId,
        revision: "profile:8",
      },
    });
    if (timeZone) expect(JSON.stringify(result)).not.toContain(timeZone);
  });

  it("keeps the property guard until the guarded callback settles", async () => {
    const fixture = fakePool({
      propertyId: normalizedPropertyId,
      profileRevision: 1,
      timeZone: "Etc/UTC",
    });
    const port = createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort({
      pool: fixture.pool,
    });
    let releaseGuard!: () => void;
    const guardedWait = new Promise<void>((resolve) => {
      releaseGuard = resolve;
    });

    const pending = port.runWithPropertyProfileEvidence(
      { propertyId: normalizedPropertyId, expectedProfileRevision: 1 },
      async () => {
        expect(fixture.calls.map(({ text }) => text)).not.toContain("COMMIT");
        await guardedWait;
        return "accepted";
      },
    );
    await vi.waitFor(() => expect(fixture.calls).toHaveLength(2));
    expect(fixture.release).not.toHaveBeenCalled();
    releaseGuard();
    await expect(pending).resolves.toBe("accepted");
    expect(fixture.calls.at(-1)?.text).toBe("COMMIT");
  });

  it("rolls back callback and owner-evidence failures without replacing their identity", async () => {
    const callbackFailure = new Error("guarded PMS write failed");
    const callbackFixture = fakePool({
      propertyId: normalizedPropertyId,
      profileRevision: 1,
      timeZone: "Europe/Berlin",
    });
    const callbackPort = createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort({
      pool: callbackFixture.pool,
    });
    await expect(
      callbackPort.runWithPropertyProfileEvidence(
        { propertyId: normalizedPropertyId, expectedProfileRevision: 1 },
        async () => Promise.reject(callbackFailure),
      ),
    ).rejects.toBe(callbackFailure);
    expect(callbackFixture.calls.at(-1)?.text).toBe("ROLLBACK");

    const queryFailure = new Error("owner read failed");
    const queryFixture = fakePool(null, queryFailure);
    const queryPort = createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort({
      pool: queryFixture.pool,
    });
    await expect(
      queryPort.runWithPropertyProfileEvidence(
        { propertyId: normalizedPropertyId, expectedProfileRevision: 1 },
        async () => "unreachable",
      ),
    ).rejects.toBe(queryFailure);
    expect(queryFixture.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("fails closed for malformed scope, missing rows, and invalid revisions", async () => {
    const fixture = fakePool(null);
    const port = createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort({
      pool: fixture.pool,
    });
    await expect(
      port.runWithPropertyProfileEvidence(
        { propertyId: "not-a-uuid", expectedProfileRevision: 1 },
        async () => null,
      ),
    ).rejects.toThrow("property ID is invalid");
    expect(fixture.connect).not.toHaveBeenCalled();

    await expect(
      port.runWithPropertyProfileEvidence(
        { propertyId: normalizedPropertyId, expectedProfileRevision: 0 },
        async () => null,
      ),
    ).rejects.toThrow("revision is invalid");
    expect(fixture.connect).not.toHaveBeenCalled();

    await expect(
      port.runWithPropertyProfileEvidence(
        { propertyId: normalizedPropertyId, expectedProfileRevision: 1 },
        async () => null,
      ),
    ).rejects.toThrow("evidence is unavailable");
    expect(fixture.calls.at(-1)?.text).toBe("ROLLBACK");

    for (const [row, message] of [
      [
        { propertyId: normalizedPropertyId, profileRevision: "07", timeZone: "Etc/UTC" },
        "revision is invalid",
      ],
      [
        { propertyId: normalizedPropertyId, profileRevision: 7, timeZone: 42 },
        "timezone row is invalid",
      ],
      [
        {
          propertyId: "a4000000-0000-4000-8000-000000000099",
          profileRevision: 7,
          timeZone: "Etc/UTC",
        },
        "escaped its property scope",
      ],
    ] as const) {
      const invalid = fakePool(row);
      const invalidPort = createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort({
        pool: invalid.pool,
      });
      await expect(
        invalidPort.runWithPropertyProfileEvidence(
          { propertyId: normalizedPropertyId, expectedProfileRevision: 1 },
          async () => null,
        ),
      ).rejects.toThrow(message);
      expect(invalid.calls.at(-1)?.text).toBe("ROLLBACK");
    }
  });

  it("closes only an owned pool", async () => {
    const external = fakePool(null);
    const externalPort = createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort({
      pool: external.pool,
    });
    await externalPort.close();
    expect(external.end).not.toHaveBeenCalled();

    expect(() => createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort({})).toThrow(
      "connectionString must not be empty",
    );
  });
});

type EvidenceRow = {
  propertyId: string;
  profileRevision: number | string;
  timeZone: unknown;
};

function fakePool(row: EvidenceRow | null, selectFailure?: Error) {
  const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  const release = vi.fn();
  const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
    calls.push({ text, values });
    if (text.includes("FROM hotel_catalog.properties")) {
      if (selectFailure) throw selectFailure;
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  const client = {
    query,
    release,
  } as unknown as HotelCatalogOperatingCalendarPropertyProfileEvidenceClient;
  const connect = vi.fn(async () => client);
  const end = vi.fn(async () => undefined);
  return {
    pool: { connect, end } as HotelCatalogOperatingCalendarPropertyProfileEvidencePool,
    calls,
    connect,
    end,
    release,
  };
}
