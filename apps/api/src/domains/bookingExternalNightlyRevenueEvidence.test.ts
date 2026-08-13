import { expect, it, vi } from "vitest";

import {
  appendExternalNightlyRevenueEvidence,
  type AppendExternalRevenueEvidenceCommand,
  type ExternalRevenueEvidenceLine,
} from "./bookingExternalNightlyRevenueEvidence.js";

it("accepts the full manual stay shape while retaining the OTA batch bound", async () => {
  const start = Date.parse("2028-01-01T00:00:00Z");
  const lines: ExternalRevenueEvidenceLine[] = Array.from({ length: 20 * 366 }, (_, index) => ({
    roomTypeId: "82000000-0000-4000-8000-000000000005",
    stayDate: new Date(start + Math.floor(index / 20) * 86_400_000).toISOString().slice(0, 10),
    recognizedOn: new Date(start + Math.floor(index / 20) * 86_400_000).toISOString().slice(0, 10),
    grossRoomAmount: String(index),
    occupiedRoomNights: 1,
    economicEvent: "room_night",
    lifecycleState: "confirmed",
    evidenceQuality: "exact",
    linePosition: (index % 20) + 1,
  }));
  const command = (sourceKind: "manual" | "ota", selected: ExternalRevenueEvidenceLine[]) =>
    ({
      propertyId: "82000000-0000-4000-8000-000000000003",
      guestBookingId: "82000000-0000-4000-8000-000000000009",
      sourceKind,
      sourceBookingReference: "manual-command",
      idempotencyKey: "manual-key",
      lines: selected,
    }) satisfies AppendExternalRevenueEvidenceCommand;
  const query = vi.fn(async () => {
    throw new Error("normalized before transaction query");
  });

  await expect(
    appendExternalNightlyRevenueEvidence({ query } as never, command("manual", lines)),
  ).rejects.toThrow("normalized before transaction query");
  await expect(
    appendExternalNightlyRevenueEvidence({ query } as never, command("ota", lines.slice(0, 1_001))),
  ).rejects.toThrow("External evidence lines are malformed");
  await expect(
    appendExternalNightlyRevenueEvidence(
      { query } as never,
      command("manual", [...lines, lines[0]!]),
    ),
  ).rejects.toThrow("External evidence lines are malformed");
  expect(query).toHaveBeenCalledTimes(1);
});
