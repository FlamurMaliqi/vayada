import type { PmsManualBookingCreateCommand } from "@vayada/domain-pms";
import { expect, it, vi } from "vitest";

import { createBookingPmsManualAttributionOwner } from "./bookingPmsManualAttribution.js";
import { createPgPmsManualBookingCommandRepository } from "./pmsManualBookingCommandRepository.js";
import { createPmsManualBookingProductionCommandConfig } from "./pmsManualBookingProductionRuntime.js";
import { createPmsManualBookingCurrentPricingEvidence } from "./pmsManualBookingTransactionalPricing.js";
import type {
  PmsManualBookingTransaction,
  PmsManualBookingTransactionDependencies,
} from "./pmsManualBookingTransactionPorts.js";

const propertyId = "81000000-0000-4000-8000-000000000001";

it("rejects an invalid manual source before transaction collaborators run", async () => {
  const unexpected = vi.fn(() => {
    throw new Error("unexpected transaction collaborator call");
  });
  const unusedPort = new Proxy({}, { get: () => unexpected });
  const connect = vi.fn(unexpected);
  const repository = createPgPmsManualBookingCommandRepository({
    connectionString: "postgresql://unused",
    pool: { connect },
    dependencies: {
      attribution: createBookingPmsManualAttributionOwner(),
      booking: unusedPort,
      operations: unusedPort,
      platform: unusedPort,
      nightlyEvidence: unusedPort,
      financeSettlement: unusedPort,
      pricing: unusedPort,
    } as PmsManualBookingTransactionDependencies,
  });

  await expect(
    repository.createManualBooking({
      directSource: "booking_engine",
    } as unknown as PmsManualBookingCreateCommand),
  ).rejects.toMatchObject({ code: "invalid_source", field: "directSource" });
  expect(connect).not.toHaveBeenCalled();
  expect(unexpected).not.toHaveBeenCalled();
});

it("loads create pricing evidence through the caller transaction", async () => {
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith("WITH pricing_currency"))
      return {
        rows: [
          {
            pricingCurrency: {
              propertyId,
              currency: "EUR",
              pricingCurrencyRevision: 1,
              createdAt: new Date("2026-08-14T00:00:00Z"),
              updatedAt: new Date("2026-08-14T00:00:00Z"),
            },
            flexibleRatePlans: [],
          },
        ],
        rowCount: 1,
      };
    if (sql.includes("FROM pms.property_pricing_settings"))
      return {
        rows: [
          {
            propertyId,
            currency: "EUR",
            pricingCurrencyRevision: 1,
            createdAt: new Date("2026-08-14T00:00:00Z"),
            updatedAt: new Date("2026-08-14T00:00:00Z"),
          },
        ],
        rowCount: 1,
      };
    if (sql.includes("FROM pms.rate_plans") || sql.includes("FROM pms.room_types room_type"))
      return { rows: [], rowCount: 0 };
    if (sql.includes("pms_room_publication_scope"))
      return { rows: [{ authorized: true }], rowCount: 1 };
    throw new Error(`unexpected query: ${sql}`);
  });
  const current = createPmsManualBookingCurrentPricingEvidence({
    amenityVocabulary: { validateRoomAmenities: vi.fn() },
    mediaResolver: { resolvePublicMedia: vi.fn() },
    now: () => new Date("2026-08-14T00:00:00Z"),
  });
  const transaction = { query } as unknown as PmsManualBookingTransaction;
  await expect(
    current.getPricingSourceSnapshot({ transaction, propertyId }),
  ).resolves.toMatchObject({ propertyId, pricingCurrency: { currency: "EUR" } });
  await expect(
    current.getRoomPublicationSnapshot({ transaction, propertyId, organizationId: propertyId }),
  ).resolves.toMatchObject({ propertyId, status: "blocked", rooms: [] });
  expect(query).toHaveBeenCalledTimes(6);
  expect(
    query.mock.calls.filter(
      ([sql]) =>
        sql.includes("FROM pms.property_pricing_settings") && sql.includes("FROM pms.rate_plans"),
    ),
  ).toHaveLength(1);
});

it("composes the exact production owners only when both PMS runtimes are ready", () => {
  const roomPublication = {
    amenityVocabulary: { validateRoomAmenities: vi.fn() },
    mediaResolver: { resolvePublicMedia: vi.fn() },
  };
  expect(
    createPmsManualBookingProductionCommandConfig({
      connectionString: "postgresql://target",
      pmsOperationsReady: false,
      roomPublication,
    }),
  ).toBeNull();
  expect(
    createPmsManualBookingProductionCommandConfig({
      connectionString: "postgresql://target",
      pmsOperationsReady: true,
    }),
  ).toBeNull();

  const config = createPmsManualBookingProductionCommandConfig({
    connectionString: "postgresql://target",
    pmsOperationsReady: true,
    roomPublication,
  });
  expect(config?.connectionString).toBe("postgresql://target");
  expect(Object.keys(config?.dependencies ?? {}).sort()).toEqual([
    "attribution",
    "booking",
    "financeSettlement",
    "nightlyEvidence",
    "operations",
    "platform",
    "pricing",
  ]);
  expect(config?.dependencies).toMatchObject({
    attribution: { resolveManualAttribution: expect.any(Function) },
    booking: { persistBookingFacts: expect.any(Function) },
    financeSettlement: { settleFull: expect.any(Function) },
    nightlyEvidence: { appendExactNightlyEvidence: expect.any(Function) },
    operations: { persistOperationalFacts: expect.any(Function) },
    platform: { reserveCommand: expect.any(Function) },
    pricing: { calculate: expect.any(Function) },
  });
});
