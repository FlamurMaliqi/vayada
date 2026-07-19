"use client";

import { useEffect } from "react";
import { authService } from "@/services/auth";
import { isAuthOrganizationSelectionResponse } from "@/services/auth/sessionStore";
import { settingsService, type HotelSummary } from "@/services/settings";
import {
  isSafeRelativeReturnTo,
  missingOrganizationHandoffLoginPath,
} from "@vayada/product-onboarding/returnTo";

export default function HandoffPage() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    // Auth data arrives in the URL hash so it never hits server logs.
    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    const token = hashParams.get("token");
    const expiresAt = hashParams.get("expires_at");
    const userData = hashParams.get("user");
    const handoffHotelId = hashParams.get("hotel_id");
    const propertyId = hashParams.get("property_id");
    const organizationId = hashParams.get("organization_id")?.trim() || null;
    const workosOrganizationId = hashParams.get("workos_organization_id")?.trim() || null;

    // Optional `?redirect=...` query param tells us where to go after
    // auth. Used by the PMS header's "Add Property" button which
    // needs to land on /setup?mode=add instead of /dashboard.
    const queryParams = new URLSearchParams(window.location.search);
    const redirectParam = queryParams.get("redirect");
    // Only honor same-origin relative paths — never trust an arbitrary URL
    const safeRedirect = isSafeRelativeReturnTo(redirectParam) ? redirectParam : null;

    void (async () => {
      if (token && expiresAt) {
        localStorage.setItem("access_token", token);
        localStorage.setItem("token_expires_at", expiresAt);
      } else if (!authService.isAuthKitEnabled()) {
        if (!(await authService.ensureSession())) {
          window.location.href = organizationSelectionPath();
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
              window.location.href = organizationSelectionPath();
              return;
            }

            session = await authService.refreshSession(
              workosOrganizationId ?? organization.workosOrganizationId,
            );
            if (
              isAuthOrganizationSelectionResponse(session) ||
              (organizationId && session.organizationId !== organizationId)
            ) {
              window.location.href = organizationSelectionPath();
              return;
            }
          } else if (organizationId && session.organizationId !== organizationId) {
            if (!workosOrganizationId) {
              window.location.href = missingOrganizationHandoffLoginPath();
              return;
            }
            session = await authService.refreshSession(workosOrganizationId);
            if (
              isAuthOrganizationSelectionResponse(session) ||
              session.organizationId !== organizationId
            ) {
              window.location.href = organizationSelectionPath();
              return;
            }
          }
        } catch {
          window.location.href = organizationSelectionPath();
          return;
        }
      }

      if (token && expiresAt && userData) {
        try {
          const user = JSON.parse(decodeURIComponent(userData));
          localStorage.setItem("isLoggedIn", "true");
          localStorage.setItem("userId", user.id);
          localStorage.setItem("userEmail", user.email);
          localStorage.setItem("userName", user.name);
          localStorage.setItem("userType", user.type);
          localStorage.setItem("userStatus", user.status);
          localStorage.setItem("user", JSON.stringify(user));
        } catch {
          /* ignore */
        }
      }

      let hotels: HotelSummary[];
      try {
        hotels = await settingsService.listHotels();
      } catch {
        const explicitId = propertyId?.trim() || handoffHotelId?.trim();
        window.location.href = explicitId
          ? `/setup?entryProduct=booking&propertyId=${encodeURIComponent(explicitId)}`
          : "/setup";
        return;
      }

      const storedPropertyId = localStorage.getItem("selectedSharedPropertyId")?.trim();
      const storedHotelId = localStorage.getItem("selectedHotelId")?.trim();
      const requestedPropertyId = propertyId?.trim();
      const requestedHotelId = handoffHotelId?.trim();
      const explicitSelectionRequested = Boolean(requestedPropertyId || requestedHotelId);
      let selected = requestedPropertyId
        ? (hotels.find(
            (hotel) => hotel.propertyId === requestedPropertyId || hotel.id === requestedPropertyId,
          ) ?? null)
        : requestedHotelId
          ? (hotels.find((hotel) => hotel.id === requestedHotelId) ?? null)
          : storedPropertyId
            ? (hotels.find(
                (hotel) => hotel.propertyId === storedPropertyId || hotel.id === storedPropertyId,
              ) ?? null)
            : storedHotelId
              ? (hotels.find((hotel) => hotel.id === storedHotelId) ?? null)
              : null;
      const explicitSelectionMissing = explicitSelectionRequested && !selected;

      if (
        (requestedPropertyId || requestedHotelId || storedPropertyId || storedHotelId) &&
        !selected
      ) {
        localStorage.removeItem("selectedSharedPropertyId");
        localStorage.removeItem("selectedHotelId");
      }
      if (!explicitSelectionRequested && !selected && hotels.length === 1) {
        selected = hotels[0]!;
      }
      if (selected) {
        localStorage.setItem("selectedSharedPropertyId", selected.propertyId ?? selected.id);
        if (selected.productReady === false) {
          localStorage.removeItem("selectedHotelId");
        } else {
          localStorage.setItem("selectedHotelId", selected.id);
        }
      }

      if (safeRedirect && !explicitSelectionMissing) {
        localStorage.setItem("setupComplete", "true");
        window.location.href = safeRedirect;
        return;
      }
      if (explicitSelectionMissing) {
        localStorage.setItem("setupComplete", "false");
        if (requestedPropertyId) {
          window.location.href = `/setup?entryProduct=booking&propertyId=${encodeURIComponent(requestedPropertyId)}`;
        } else if (hotels.length > 1) {
          window.location.href = "/choose-property";
        } else {
          window.location.href = "/setup";
        }
        return;
      }
      if (hotels.length === 0) {
        localStorage.setItem("setupComplete", "false");
        window.location.href = "/setup";
        return;
      }
      if (!selected && hotels.length > 1) {
        localStorage.setItem("setupComplete", "true");
        window.location.href = "/choose-property";
        return;
      }

      if (selected?.productReady === false) {
        localStorage.setItem("setupComplete", "false");
        window.location.href = `/setup?entryProduct=booking&propertyId=${encodeURIComponent(
          selected.propertyId ?? selected.id,
        )}`;
        return;
      }

      localStorage.setItem("setupComplete", "true");
      window.location.href = "/dashboard";
    })().catch(() => {
      window.location.href = organizationSelectionPath();
    });
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

function organizationSelectionPath(): string {
  const currentHash = new URLSearchParams(window.location.hash.slice(1));
  const safeHash = new URLSearchParams();
  for (const key of ["organization_id", "workos_organization_id", "property_id", "hotel_id"]) {
    const value = currentHash.get(key)?.trim();
    if (value) safeHash.set(key, value);
  }
  const returnTo = `${window.location.pathname}${window.location.search}${safeHash.size > 0 ? `#${safeHash.toString()}` : ""}`;
  const loginParams = new URLSearchParams();
  loginParams.set("auth", "callback");
  loginParams.set("returnTo", returnTo);
  return `/login?${loginParams.toString()}`;
}
