import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  resolvePropertyId: vi.fn(),
}));

vi.mock("./pmsOperationsClient", () => ({
  pmsOperationsClient: { post: mocks.post },
  pmsOperationsRequestOptions: { headers: { "X-Vayada-Omit-Hotel-Context": "true" } },
}));

vi.mock("./pmsPropertyClient", () => ({
  propertyEndpoint: (propertyId: string, suffix: string) =>
    `/api/pms/properties/${propertyId}/${suffix}`,
  resolveSelectedPmsPropertyId: mocks.resolvePropertyId,
}));

import { ApiErrorResponse } from "./client";
import {
  PMS_MANUAL_BOOKING_CONTRACT_VERSION,
  PmsManualBookingServiceError,
  pmsManualBookingClient,
  type PmsManualBookingCreateInput,
  type PmsManualBookingPreviewInput,
} from "./pmsManualBookingClient";

const stay = {
  position: 1,
  roomId: "11111111-1111-4111-8111-111111111111",
  checkIn: "2026-09-10",
  checkOut: "2026-09-12",
  adults: 2,
  children: 0,
  ratePlanId: null,
  pricing: {
    kind: "custom" as const,
    nightlyAmount: { amountDecimal: "120.50", currency: "EUR" },
  },
};
const previewInput: PmsManualBookingPreviewInput = { stays: [stay], addOns: [] };
const createInput: PmsManualBookingCreateInput = {
  ...previewInput,
  commandId: "command-1",
  idempotencyKey: "submit-1",
  guest: {
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.com",
    phoneE164: "+306900000000",
    countryCode: "GR",
    specialRequests: "Late arrival",
  },
  privateNote: "Call before arrival",
  directSource: "email",
  payment: {
    expectedMethod: "bank_transfer",
    settlement: { status: "paid", reference: "bank-42" },
  },
};

describe("pmsManualBookingClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePropertyId.mockResolvedValue("property-1");
  });

  it("sends a versioned preview and returns server-derived totals unchanged", async () => {
    const preview = {
      contractVersion: PMS_MANUAL_BOOKING_CONTRACT_VERSION,
      currency: "EUR",
      stays: [],
      addOns: [],
      grandTotal: { amountDecimal: "241.00", currency: "EUR" },
    };
    mocks.post.mockResolvedValue(preview);
    const inputWithStaleVersion = { ...previewInput, contractVersion: "pms-manual-booking.v0" };

    await expect(pmsManualBookingClient.preview(inputWithStaleVersion)).resolves.toBe(preview);
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/pms/properties/property-1/manual-bookings/preview",
      { contractVersion: PMS_MANUAL_BOOKING_CONTRACT_VERSION, ...previewInput },
      { headers: { "X-Vayada-Omit-Hotel-Context": "true" } },
    );
  });

  it("preserves replay IDs and all target create evidence", async () => {
    const replay = {
      contractVersion: PMS_MANUAL_BOOKING_CONTRACT_VERSION,
      outcome: "replayed",
      commandId: "command-1",
      idempotencyKey: "submit-1",
    };
    mocks.post.mockResolvedValue(replay);

    await expect(pmsManualBookingClient.create(createInput)).resolves.toBe(replay);
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/pms/properties/property-1/manual-bookings",
      { contractVersion: PMS_MANUAL_BOOKING_CONTRACT_VERSION, ...createInput },
      { headers: { "X-Vayada-Omit-Hotel-Context": "true" } },
    );
    const sent = mocks.post.mock.calls[0]![1];
    expect(sent).toMatchObject({
      commandId: "command-1",
      idempotencyKey: "submit-1",
      directSource: "email",
      privateNote: "Call before arrival",
      guest: { phoneE164: "+306900000000", specialRequests: "Late arrival" },
      payment: { settlement: { status: "paid", reference: "bank-42" } },
    });
    expect(sent).not.toHaveProperty("propertyId");
  });

  it.each([
    [422, "occupancy_exceeded", "validation"],
    [403, "paid_forbidden", "authorization"],
    [404, "room_not_found", "not_found"],
    [409, "room_unavailable", "conflict"],
    [500, "manual_booking_create_unavailable", "unavailable"],
  ] as const)("maps HTTP %s errors to a stable %s outcome", async (status, code, category) => {
    mocks.post.mockRejectedValue(
      new ApiErrorResponse(status, {
        code,
        message: "Request failed.",
        field: "stays",
        stayPosition: 1,
      }),
    );

    const error = await pmsManualBookingClient.create(createInput).catch((caught) => caught);
    expect(error).toBeInstanceOf(PmsManualBookingServiceError);
    expect(error).toMatchObject({
      category,
      code,
      status,
      message: "Request failed.",
      field: "stays",
      stayPosition: 1,
    });
  });
});
