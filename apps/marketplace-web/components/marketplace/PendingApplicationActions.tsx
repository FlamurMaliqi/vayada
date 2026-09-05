"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import type { CollaborationOffering } from "@/lib/types";
import { hotelService } from "@/services/api/hotels";
import {
  collaborationService,
  transformCollaborationResponse,
  type DetailedCollaboration,
  type CreateCreatorCollaborationRequest,
} from "@/services/api/collaborations";
import { CollaborationApplicationModal } from "./CollaborationApplicationModal";

export function PendingApplicationActions({
  collaboration,
  onUpdated,
}: {
  collaboration: DetailedCollaboration;
  onUpdated: (value: DetailedCollaboration) => void;
}) {
  const [offerings, setOfferings] = useState<CollaborationOffering[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cancel = async () => {
    if (!window.confirm("Cancel this request? The hotel will no longer be able to accept it."))
      return;
    setBusy(true);
    setError("");
    try {
      onUpdated(
        transformCollaborationResponse(
          await collaborationService.cancelCollaboration(collaboration.id, undefined, true),
        ),
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : "Cancellation failed. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  const edit = async () => {
    setBusy(true);
    setError("");
    try {
      const hotels = await hotelService.getAll();
      const options = hotels.data.find(
        (hotel) => hotel.id === collaboration.listingId,
      )?.collaborationOfferings;
      if (!options?.length) throw new Error("This offer is no longer available for editing.");
      setOfferings(options);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not load the application.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant="outline" disabled={busy} onClick={cancel}>
        Cancel Request
      </Button>
      <Button disabled={busy} onClick={edit}>
        Edit Request
      </Button>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {offerings && (
        <CollaborationApplicationModal
          isOpen
          onClose={() => setOfferings(null)}
          listingId={collaboration.listingId!}
          compensationOptions={offerings}
          creatorPlatforms={collaboration.creator?.platforms.map((p) => p.name)}
          initialData={{
            compensationOptionId: collaboration.selectedCompensationOptionId ?? "",
            whyGreatFit: collaboration.whyGreatFit ?? "",
            travelDateFrom: collaboration.travelDateFrom ?? undefined,
            travelDateTo: collaboration.travelDateTo ?? undefined,
            preferredMonths: collaboration.preferredMonths ?? [],
            platformDeliverables: collaboration.platformDeliverables ?? [],
            consent: true,
          }}
          onSubmit={async (data, options) => {
            if (!data.consent) throw new Error("Consent is required.");
            const request: CreateCreatorCollaborationRequest = {
              initiator_type: "creator",
              listing_id: collaboration.listingId!,
              compensation_option_id: data.compensationOptionId,
              why_great_fit: data.whyGreatFit,
              consent: data.consent,
              travel_date_from: data.travelDateFrom,
              travel_date_to: data.travelDateTo,
              preferred_months: data.preferredMonths,
              platform_deliverables:
                data.platformDeliverables as CreateCreatorCollaborationRequest["platform_deliverables"],
            };
            onUpdated(
              await collaborationService.editApplication(
                collaboration.id,
                request,
                new Date(collaboration.updatedAt).toISOString(),
                options,
              ),
            );
          }}
        />
      )}
    </>
  );
}
