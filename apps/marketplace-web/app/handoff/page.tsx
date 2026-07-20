"use client";

import { useEffect } from "react";
import { ROUTES, STORAGE_KEYS } from "@/lib/constants";
import { authService } from "@/services/auth";
import { sharedHotelSetupApi } from "@/services/api/sharedHotelSetupClient";
import { isAuthOrganizationSelectionResponse } from "@/services/auth/sessionStore";
import {
  isSafeRelativeReturnTo,
  missingOrganizationHandoffLoginPath,
  organizationSelectionLoginPath,
} from "@vayada/product-onboarding/returnTo";

// Cross-app auth handoff landing page.
//
// The PMS and Booking Engine admin "SWITCH APP" dropdowns deep-link here
// (`/handoff#token=...&expires_at=...&user=...&hotel_id=...`) so a user who
// is already signed in over there lands in the marketplace authenticated,
// without re-login. Auth data travels in the URL hash (not the query) so it
// never reaches server logs.
//
// The keys written here are exactly the ones `services/auth` reads back
// (`access_token`, `token_expires_at`, plus the STORAGE_KEYS user fields),
// and `token_expires_at` is the same epoch-ms format `storeToken()` uses,
// so the existing `getToken()` validity check works unchanged.
export default function HandoffPage() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    const token = hashParams.get("token");
    const expiresAt = hashParams.get("expires_at");
    const userData = hashParams.get("user");
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
      if (token && expiresAt) {
        localStorage.setItem("access_token", token);
        localStorage.setItem("token_expires_at", expiresAt);
      } else if (!authService.isAuthKitEnabled()) {
        if (!(await authService.ensureSession())) {
          window.location.href = organizationSelectionPath;
          return;
        }
      } else {
        try {
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
        } catch {
          window.location.href = organizationSelectionPath;
          return;
        }
      }

      if (token && expiresAt && userData) {
        try {
          const user = JSON.parse(decodeURIComponent(userData));
          localStorage.setItem(STORAGE_KEYS.IS_LOGGED_IN, "true");
          localStorage.setItem(STORAGE_KEYS.USER_ID, user.id);
          localStorage.setItem(STORAGE_KEYS.USER_EMAIL, user.email);
          localStorage.setItem(STORAGE_KEYS.USER_NAME, user.name);
          localStorage.setItem(STORAGE_KEYS.USER_TYPE, user.type);
          localStorage.setItem(STORAGE_KEYS.USER_STATUS, user.status);
          localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(user));
        } catch {
          /* ignore — malformed user payload, token alone still signs them in */
        }
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
      let selectedProperty = requestedPropertyId
        ? (status.properties.find((property) => property.propertyId === requestedPropertyId) ??
          null)
        : null;

      if (requestedPropertyId && !selectedProperty) {
        localStorage.removeItem("selectedSharedPropertyId");
      }
      if (!explicitPropertyId && !selectedProperty && status.properties.length === 1) {
        selectedProperty = status.properties[0]!;
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
