"use client";

import { useEffect } from "react";
import { ROUTES } from "@/lib/constants";
import { authService } from "@/services/auth";
import { sharedHotelSetupApi } from "@/services/api/sharedHotelSetupClient";
import { isAuthOrganizationSelectionResponse } from "@/services/auth/sessionStore";
import {
  isSafeRelativeReturnTo,
  missingOrganizationHandoffLoginPath,
  organizationSelectionLoginPath,
} from "@vayada/product-onboarding/returnTo";

// Cross-app AuthKit handoff landing page. Other products provide only
// organization/property hints; authentication always comes from the sealed
// browser session and never from URL-supplied token or user data.
export default function HandoffPage() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    const handoffHotelId = hashParams.get("hotel_id");
    const propertyId = hashParams.get("property_id");
    const organizationId = hashParams.get("organization_id")?.trim() || null;
    const workosOrganizationId = hashParams.get("workos_organization_id")?.trim() || null;
    const organizationSelectionPath = organizationSelectionLoginPath(
      window.location.pathname,
      window.location.search,
      window.location.hash,
    );

    // Optional `?redirect=...` — honored only if it's a same-origin
    // relative path, so another app can hand off onto a specific page.
    const queryParams = new URLSearchParams(window.location.search);
    const redirectParam = queryParams.get("redirect");
    const safeRedirect = isSafeRelativeReturnTo(redirectParam) ? redirectParam : null;

    void (async () => {
      try {
        let session = await authService.refreshSession();
        if (isAuthOrganizationSelectionResponse(session)) {
          const organization = organizationId
            ? session.organizations.find((candidate) => candidate.organizationId === organizationId)
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
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-6 h-6 border-2 border-gray-300 border-t-gray-900 rounded-full animate-spin" />
    </div>
  );
}
