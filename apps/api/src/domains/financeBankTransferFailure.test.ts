import { beforeEach, expect, it, vi } from "vitest";
import { createBankTransferRepository } from "./financeBankTransferRepository.js";
import { createBankTransferBookingOperations } from "./financeBankTransferBooking.js";
import type { createBankTransferCodec } from "./financeBankTransferCodec.js";

const client = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn() }));
vi.mock("pg", () => ({
  default: {
    Pool: class {
      connect() {
        return Promise.resolve(client);
      }
      query(...args: unknown[]) {
        return client.query(...args);
      }
      end() {
        return Promise.resolve();
      }
    },
  },
}));
beforeEach(() => vi.resetAllMocks());
const codec = { decrypt: vi.fn() } as unknown as ReturnType<typeof createBankTransferCodec>;

it("preserves sanitized errors when both the transaction and rollback fail", async () => {
  client.query.mockRejectedValue(new Error("raw driver SECRET"));
  const repository = createBankTransferRepository("postgresql://test");
  await expect(
    repository.execute({
      propertyId: "id",
      actorId: "actor",
      commandId: "command",
      action: "delete",
      expectedVersion: 1,
    }),
  ).rejects.toThrow(/^Bank transfer destination unavailable\.$/);
  const bookings = createBankTransferBookingOperations("postgresql://test", codec);
  await expect(
    bookings.confirmation({ propertyId: "id", bookingId: "booking", tokenHash: "token" }),
  ).rejects.toThrow(/^Bank transfer instructions unavailable\.$/);
  expect(client.release).toHaveBeenCalledTimes(2);
});

it("returns no instructions when lookup misses even if rollback fails", async () => {
  client.query.mockImplementation(async (sql: string) => {
    if (sql === "ROLLBACK") throw new Error("raw driver SECRET");
    return { rows: [] };
  });
  const bookings = createBankTransferBookingOperations("postgresql://test", codec);
  await expect(
    bookings.confirmation({ propertyId: "id", bookingId: "booking", tokenHash: "token" }),
  ).resolves.toBeNull();
});

it("refuses startup with enabled destinations but missing KMS", async () => {
  client.query.mockResolvedValue({ rows: [{}] });
  const repository = createBankTransferRepository("postgresql://test");
  await expect(repository.assertConfigured()).rejects.toThrow(
    "Bank transfer KMS configuration is required",
  );
  client.query.mockResolvedValue({ rows: [] });
  await expect(repository.assertConfigured()).resolves.toBeUndefined();
  client.query.mockClear();
  await expect(
    createBankTransferRepository("postgresql://test", codec).assertConfigured(),
  ).resolves.toBeUndefined();
  expect(client.query).not.toHaveBeenCalled();
});
