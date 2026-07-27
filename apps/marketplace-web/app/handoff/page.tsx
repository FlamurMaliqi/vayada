"use client";

import { useEffect, useRef, useState } from "react";
import {
  canonicalSetupReturnUrl,
  errorForHandoffFailure,
  invalidHandoffError,
  resolveOpaqueHandoffLocation,
  type HandoffError,
} from "@vayada/product-onboarding/returnTo";

import { authService } from "@/services/auth";
import { sharedHotelSetupApi } from "@/services/api/sharedHotelSetupClient";
import { isAuthOrganizationSelectionResponse } from "@/services/auth/sessionStore";

export default function HandoffPage() {
  const [handoffError, setHandoffError] = useState<HandoffError | null>(null);
  const startedRef = useRef(false);
  const setupReturnUrlRef = useRef("/setup?entryProduct=marketplace&returnProduct=marketplace");

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const location = resolveOpaqueHandoffLocation(window.location);
    if (!location) {
      setHandoffError(invalidHandoffError());
      return;
    }
    const { code, loginPath } = location;

    void (async () => {
      try {
        let session = await authService.refreshSession();
        if (isAuthOrganizationSelectionResponse(session)) {
          if (session.organizations.length !== 1) {
            window.location.replace(loginPath);
            return;
          }
          session = await authService.refreshSession(
            session.organizations[0]!.workosOrganizationId,
          );
          if (isAuthOrganizationSelectionResponse(session)) {
            window.location.replace(loginPath);
            return;
          }
        }
      } catch {
        window.location.replace(loginPath);
        return;
      }

      try {
        const handoff = await sharedHotelSetupApi.exchangeHandoff({ code });
        const destination = marketplaceSetupTaskDestination(handoff, window.location.origin);
        if (!destination) {
          throw new Error("The requested setup task does not have a Marketplace destination.");
        }
        setupReturnUrlRef.current =
          canonicalSetupReturnUrl(handoff.returnUrl, handoff.propertyId, window.location.origin) ??
          setupReturnUrlRef.current;

        const status = await sharedHotelSetupApi.getStatus({
          entryProduct: "marketplace",
          propertyId: handoff.propertyId,
        });
        const selectedProperty = status.propertySelection.availableProperties.find(
          (property) => property.propertyId === handoff.propertyId,
        );
        if (!selectedProperty) {
          throw new Error("The requested property is not available in Creator Marketplace.");
        }

        localStorage.setItem("selectedSharedPropertyId", selectedProperty.propertyId);
        // The handoff code is single-use. Replace the consumed URL so browser Back
        // returns to the setup hub instead of retrying an already-used code.
        window.location.replace(destination);
      } catch (error: unknown) {
        setHandoffError(errorForHandoffFailure(error));
      }
    })();
  }, []);

  if (handoffError) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <section className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-gray-950">
            {handoffError.refreshPlan ? "Setup plan changed" : "Setup link unavailable"}
          </h1>
          <p className="mt-2 text-sm text-gray-600">{handoffError.message}</p>
          <button
            type="button"
            onClick={() => {
              window.location.replace(setupReturnUrlRef.current);
            }}
            className="mt-5 rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700"
          >
            {handoffError.refreshPlan ? "Refresh setup plan" : "Return to setup"}
          </button>
        </section>
      </main>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-gray-900" />
    </div>
  );
}

function marketplaceSetupTaskDestination(
  handoff: {
    propertyId: string;
    taskId: string;
    issuedPlanRevision: string;
    destinationRouteKey: string;
    returnUrl: string;
  },
  marketplaceOrigin: string,
): string | null {
  const destinations: Record<string, string> = {
    shared_identity: "hotel_catalog.shared_identity",
    public_profile: "hotel_catalog.public_profile",
    creator_profile: "marketplace.creator_profile",
    creator_offer: "marketplace.creator_offer",
  };
  if (destinations[handoff.taskId] !== handoff.destinationRouteKey) return null;

  const returnUrl = canonicalSetupReturnUrl(
    handoff.returnUrl,
    handoff.propertyId,
    marketplaceOrigin,
  );
  if (!returnUrl) return null;
  if (handoff.taskId === "shared_identity") return returnUrl;

  return `/profile/complete?${new URLSearchParams({
    activation: "marketplace",
    taskId: handoff.taskId,
    destinationRouteKey: handoff.destinationRouteKey,
    planRevision: handoff.issuedPlanRevision,
    returnUrl,
  }).toString()}`;
}
