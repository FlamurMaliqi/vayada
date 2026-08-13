import type { PmsManualBookingCreateCommand } from "@vayada/domain-pms";
import { expect, it, vi } from "vitest";

import { createBookingPmsManualAttributionOwner } from "./bookingPmsManualAttribution.js";
import { createPgPmsManualBookingCommandRepository } from "./pmsManualBookingCommandRepository.js";
import type { PmsManualBookingTransactionDependencies } from "./pmsManualBookingTransactionPorts.js";

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
