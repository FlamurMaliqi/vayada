import type {
  BookingGuestPolicyChoices,
  BookingGuestPolicyComposition,
  BookingGuestPolicySetupAggregate,
} from "@vayada/domain-booking";
import { pmsOperationsClient, pmsOperationsRequestOptions } from "../api/pmsOperationsClient";
import { resolveSelectedPmsPropertyId } from "../api/pmsPropertyClient";

const endpoint = (id: string) =>
  `/api/booking/properties/${encodeURIComponent(id)}/booking-guest-policy`;
export const arrivalTimesService = {
  async load(signal?: AbortSignal): Promise<BookingGuestPolicySetupAggregate> {
    const id = await resolveSelectedPmsPropertyId("loading arrival times");
    return pmsOperationsClient.get(endpoint(id), { ...pmsOperationsRequestOptions, signal });
  },
  preview(id: string, choices: BookingGuestPolicyChoices): Promise<BookingGuestPolicyComposition> {
    return pmsOperationsClient.post(
      `${endpoint(id)}/preview`,
      { choices },
      pmsOperationsRequestOptions,
    );
  },
  save(
    setup: BookingGuestPolicySetupAggregate,
    preview: Extract<BookingGuestPolicyComposition, { outcome: "ready" }>,
    key: string,
  ) {
    return pmsOperationsClient.put(
      endpoint(setup.propertyId),
      {
        expectedRevision: setup.current?.revision ?? 0,
        expectedSourceFingerprint: preview.bundle.sourceFingerprint,
        choices: preview.bundle.choices,
        confirmPolicyBundle: true,
      },
      {
        ...pmsOperationsRequestOptions,
        headers: { ...pmsOperationsRequestOptions.headers, "Idempotency-Key": key },
      },
    );
  },
};
