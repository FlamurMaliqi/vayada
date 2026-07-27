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
import { isAuthOrganizationSelectionResponse } from "@/services/auth/sessionStore";
import { sharedHotelSetupApi } from "@/services/api/sharedHotelSetupClient";
import { listPmsProperties, storeSelectedPmsPropertyId } from "@/services/api/pmsPropertyClient";

const MARKETPLACE_FRONTEND_URL =
  process.env.NEXT_PUBLIC_MARKETPLACE_URL || "https://app.vayada.com";

export default function HandoffPage() {
  const [handoffError, setHandoffError] = useState<HandoffError | null>(null);
  const startedRef = useRef(false);

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
        if (!authService.isAuthKitEnabled()) {
          if (!(await authService.ensureSession())) {
            window.location.href = loginPath;
            return;
          }
        } else {
          let session = await authService.refreshSession();
          if (isAuthOrganizationSelectionResponse(session)) {
            if (session.organizations.length !== 1) {
              window.location.href = loginPath;
              return;
            }
            session = await authService.refreshSession(
              session.organizations[0]!.workosOrganizationId,
            );
            if (isAuthOrganizationSelectionResponse(session)) {
              window.location.href = loginPath;
              return;
            }
          }
        }
      } catch {
        window.location.href = loginPath;
        return;
      }

      try {
        const handoff = await sharedHotelSetupApi.exchangeHandoff({ code });
        const destination = pmsSetupTaskDestination(handoff);
        if (!destination) {
          throw new Error("The requested setup task does not have a PMS destination.");
        }

        const properties = await listPmsProperties();
        const selected = properties.find((property) => property.id === handoff.propertyId);
        if (!selected) {
          throw new Error("The requested property is not available in PMS.");
        }

        storeSelectedPmsPropertyId(selected.id);
        window.location.href = destination;
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
              window.location.href = new URL("/setup", MARKETPLACE_FRONTEND_URL).toString();
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
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
    </div>
  );
}

function pmsSetupTaskDestination(handoff: {
  propertyId: string;
  taskId: string;
  issuedPlanRevision: string;
  destinationRouteKey: string;
  returnUrl: string;
}): string | null {
  if (
    handoff.taskId !== "rooms_rates_availability" ||
    handoff.destinationRouteKey !== "pms.rooms_rates_availability"
  ) {
    return null;
  }

  const returnUrl = canonicalSetupReturnUrl(
    handoff.returnUrl,
    handoff.propertyId,
    MARKETPLACE_FRONTEND_URL,
  );
  if (!returnUrl) return null;

  return `/rooms/new?${new URLSearchParams({
    onboarding: "pms-activation",
    taskId: handoff.taskId,
    destinationRouteKey: handoff.destinationRouteKey,
    planRevision: handoff.issuedPlanRevision,
    returnUrl,
  }).toString()}`;
}
