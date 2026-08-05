import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { createPgBookingSetupLifecycleStatusRepository } from "./domains/bookingSetupLifecycleStatusRepository.js";
import {
  authorizedLifecycleExecutor,
  lifecycleTestScope,
} from "./propertySetupLifecycleStatusRepositoryTestSupport.js";

const bookingBase = {
  operationId: "10000000-0000-4000-8000-000000000005",
  attemptStatus: "pending",
  resultRevisionId: null,
  failureCode: null,
  attemptUpdatedAt: new Date("2026-08-02T12:00:00.000Z"),
  activeRevisionId: null,
  activatedAt: null,
} as const;

describe("Booking Review lifecycle status repository", () => {
  it("maps only persisted publication-attempt and active-pointer lifecycle state", async () => {
    await expect(bookingStatus(bookingBase)).resolves.toMatchObject({
      ...lifecycleTestScope,
      product: "booking",
      phase: "publishing",
      sourceRevision: expect.stringMatching(/^booking-review:sha256:[0-9a-f]{64}$/),
    });
    await expect(
      bookingStatus({
        ...bookingBase,
        attemptStatus: "failed",
        failureCode: "source_content_changed",
      }),
    ).resolves.toMatchObject({ phase: "source_content_changed" });
    await expect(
      bookingStatus({
        ...bookingBase,
        attemptStatus: "unknown",
        failureCode: "external_result_unconfirmed",
      }),
    ).resolves.toMatchObject({ phase: "publication_unknown" });
    await expect(
      bookingStatus({
        ...bookingBase,
        attemptStatus: "succeeded",
        resultRevisionId: "10000000-0000-4000-8000-000000000006",
        activeRevisionId: "10000000-0000-4000-8000-000000000006",
        activatedAt: new Date("2026-08-02T12:03:00.000Z"),
      }),
    ).resolves.toMatchObject({ phase: "published" });
  });

  it("fails closed for malformed attempt and activation combinations", async () => {
    await expect(bookingStatus({ ...bookingBase, attemptStatus: null })).rejects.toThrow(
      "attempt is malformed",
    );
    await expect(bookingStatus({ ...bookingBase, attemptStatus: "unsupported" })).rejects.toThrow(
      "status is malformed",
    );
    await expect(
      bookingStatus({ ...bookingBase, attemptStatus: "failed", failureCode: null }),
    ).rejects.toThrow("result is malformed");
    await expect(
      bookingStatus({
        ...bookingBase,
        attemptStatus: "succeeded",
        resultRevisionId: "10000000-0000-4000-8000-000000000006",
      }),
    ).rejects.toThrow("no active result");
    await expect(
      bookingStatus({
        ...bookingBase,
        activeRevisionId: "10000000-0000-4000-8000-000000000006",
      }),
    ).rejects.toThrow("activation is malformed");
  });
});

async function bookingStatus(row: QueryResultRow) {
  const repository = createPgBookingSetupLifecycleStatusRepository({
    connectionString: "postgresql://unit.test/vayada_test",
    pool: authorizedLifecycleExecutor(row),
  });
  return repository.getBookingSetupLifecycleStatus(lifecycleTestScope);
}
