"use client";

import { useEffect, useState } from "react";
import { ROUTES } from "@/lib/constants";
import { authService } from "@/services/auth";
import { sharedHotelSetupApi } from "@/services/api/sharedHotelSetupClient";
import { isAuthOrganizationSelectionResponse } from "@/services/auth/sessionStore";
import {
  isSafeRelativeReturnTo,
  missingOrganizationHandoffLoginPath,
  organizationSelectionLoginPath,
} from "@vayada/product-onboarding/returnTo";
import {
  BrowserAuthHandoffError,
  redeemBrowserAuthHandoff,
  useSingleFlightGuard,
} from "@vayada/product-onboarding";

// Cross-app AuthKit handoff landing page. Other products provide only
// organization/property hints; authentication always comes from the sealed
// browser session and never from URL-supplied token or user data.
export default function HandoffPage() {
  const [retryable, setRetryable] = useState(false);
  const beginRedemption = useSingleFlightGuard();

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!beginRedemption()) return;

    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    const code = hashParams.get("code");
    let handoffHotelId = hashParams.get("hotel_id");
    let propertyId = hashParams.get("property_id");
    let organizationId = hashParams.get("organization_id")?.trim() || null;
    let workosOrganizationId = hashParams.get("workos_organization_id")?.trim() || null;
    let organizationSelectionPath = organizationSelectionLoginPath(
      window.location.pathname,
      window.location.search,
      window.location.hash,
    );

    // Optional `?redirect=...` — honored only if it's a same-origin
    // relative path, so another app can hand off onto a specific page.
    const queryParams = new URLSearchParams(window.location.search);
    const redirectParam = queryParams.get("redirect");
    let safeRedirect = isSafeRelativeReturnTo(redirectParam) ? redirectParam : null;

    void (async () => {
      let redeemed = false;
      if (code) {
        try {
          const handoff = await redeemBrowserAuthHandoff({
            code,
            targetSurface: "marketplace-web",
          });
          window.history.replaceState(
            null,
            "",
            `${window.location.pathname}${window.location.search}`,
          );
          organizationSelectionPath = organizationSelectionLoginPath(
            window.location.pathname,
            window.location.search,
            "",
          );
          handoffHotelId = handoff.routingHints.hotelId ?? null;
          propertyId = handoff.routingHints.propertyId ?? null;
          organizationId = handoff.routingHints.organizationId ?? null;
          workosOrganizationId = handoff.routingHints.workosOrganizationId ?? null;
          safeRedirect = handoff.targetPath;
          if (!(await authService.ensureSession())) throw new Error("Handoff session unavailable");
          redeemed = true;
        } catch (error) {
          if (error instanceof BrowserAuthHandoffError && error.retryable) {
            setRetryable(true);
            return;
          }
          window.history.replaceState(
            null,
            "",
            `${window.location.pathname}${window.location.search}`,
          );
          window.location.replace(
            organizationSelectionLoginPath(window.location.pathname, window.location.search, ""),
          );
          return;
        }
      }

      try {
        if (redeemed) {
          // Redemption already selected and authorized the target-host session.
        } else {
          let session = await authService.refreshSession();
          if (isAuthOrganizationSelectionResponse(session)) {
            const organization = organizationId
              ? session.organizations.find(
                  (candidate) => candidate.organizationId === organizationId,
                )
              : workosOrganizationId
                ? session.organizations.find(
                    (candidate) => candidate.workosOrganizationId === workosOrganizationId,
                  )
                : session.organizations.length === 1
                  ? session.organizations[0]
                  : undefined;

            if (
              !organization ||
              (workosOrganizationId && organization.workosOrganizationId !== workosOrganizationId)
            ) {
              window.location.href = organizationSelectionPath;
              return;
            }

            session = await authService.refreshSession(
              workosOrganizationId ?? organization.workosOrganizationId,
            );
            if (
              isAuthOrganizationSelectionResponse(session) ||
              (organizationId && session.organizationId !== organizationId) ||
              (workosOrganizationId && session.workosOrganizationId !== workosOrganizationId)
            ) {
              window.location.href = organizationSelectionPath;
              return;
            }
          } else if (
            (organizationId && session.organizationId !== organizationId) ||
            (workosOrganizationId && session.workosOrganizationId !== workosOrganizationId)
          ) {
            if (!workosOrganizationId) {
              window.location.href = missingOrganizationHandoffLoginPath();
              return;
            }
            session = await authService.refreshSession(workosOrganizationId);
            if (
              isAuthOrganizationSelectionResponse(session) ||
              (organizationId && session.organizationId !== organizationId) ||
              session.workosOrganizationId !== workosOrganizationId
            ) {
              window.location.href = organizationSelectionPath;
              return;
            }
          }
        }
      } catch {
        window.location.href = organizationSelectionPath;
        return;
      }

      let status;
      try {
        status = await sharedHotelSetupApi.getStatus({ entryProduct: "marketplace" });
      } catch {
        const explicitPropertyId = propertyId?.trim() || handoffHotelId?.trim();
        window.location.href = explicitPropertyId
          ? `/setup?entryProduct=marketplace&propertyId=${encodeURIComponent(explicitPropertyId)}`
          : "/setup";
        return;
      }
      const storedPropertyId = localStorage.getItem("selectedSharedPropertyId")?.trim();
      const explicitPropertyId = propertyId?.trim() || handoffHotelId?.trim() || null;
      const requestedPropertyId = explicitPropertyId || storedPropertyId;
      const properties = status.propertySelection.availableProperties;
      let selectedProperty = requestedPropertyId
        ? (properties.find((property) => property.propertyId === requestedPropertyId) ?? null)
        : null;

      if (requestedPropertyId && !selectedProperty) {
        localStorage.removeItem("selectedSharedPropertyId");
      }
      if (!explicitPropertyId && !selectedProperty && properties.length === 1) {
        selectedProperty = properties[0]!;
      }
      if (selectedProperty) {
        localStorage.setItem("selectedSharedPropertyId", selectedProperty.propertyId);
      }

      if (explicitPropertyId && !selectedProperty) {
        window.location.href = `/setup?entryProduct=marketplace&propertyId=${encodeURIComponent(explicitPropertyId)}`;
        return;
      }
      window.location.href = safeRedirect || ROUTES.MARKETPLACE;
    })().catch(() => {
      window.location.href = organizationSelectionPath;
    });
  }, [beginRedemption]);

  if (retryable) {
    return (
      <div
        className="min-h-screen flex flex-col items-center justify-center gap-4 bg-gray-50 px-6 text-center"
        role="status"
      >
        <p className="text-sm font-medium text-gray-700">
          Your session transfer is temporarily unavailable.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-full bg-primary-600 px-5 py-2 text-sm font-semibold text-white"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div
        className="w-6 h-6 border-2 border-gray-300 border-t-gray-900 rounded-full animate-spin"
        role="status"
        aria-label="Transferring your session"
      />
    </div>
  );
}
