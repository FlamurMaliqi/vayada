"use client";

import { useEffect, useState } from "react";
import { authService } from "@/services/auth";
import { isAuthOrganizationSelectionResponse } from "@/services/auth/sessionStore";
import { settingsService, type HotelSummary } from "@/services/settings";
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

export default function HandoffPage() {
  const [retryable, setRetryable] = useState(false);
  const beginRedemption = useSingleFlightGuard();

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!beginRedemption()) return;

    // Auth data arrives in the URL hash so it never hits server logs.
    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    const code = hashParams.get("code");
    const token = hashParams.get("token");
    const expiresAt = hashParams.get("expires_at");
    const userData = hashParams.get("user");
    let handoffHotelId = hashParams.get("hotel_id");
    let propertyId = hashParams.get("property_id");
    let organizationId = hashParams.get("organization_id")?.trim() || null;
    let workosOrganizationId = hashParams.get("workos_organization_id")?.trim() || null;
    let organizationSelectionPath = organizationSelectionLoginPath(
      window.location.pathname,
      window.location.search,
      window.location.hash,
    );

    // Optional `?redirect=...` query param tells us where to go after
    // auth. Used by the PMS header's "Add Property" button which
    // needs to land on /setup?mode=add instead of /dashboard.
    const queryParams = new URLSearchParams(window.location.search);
    const redirectParam = queryParams.get("redirect");
    // Only honor same-origin relative paths — never trust an arbitrary URL
    let safeRedirect = isSafeRelativeReturnTo(redirectParam) ? redirectParam : null;

    void (async () => {
      if (code) {
        try {
          const handoff = await redeemBrowserAuthHandoff({
            code,
            targetSurface: "booking-admin",
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
      } else if (!authService.isAuthKitEnabled() && token && expiresAt) {
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

      if (!authService.isAuthKitEnabled() && token && expiresAt && userData) {
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
        localStorage.setItem("setupComplete", "false");
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
        localStorage.setItem("selectedHotelId", selected.id);
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

      localStorage.setItem("setupComplete", "true");
      window.location.href = "/dashboard";
    })().catch(() => {
      window.location.href = organizationSelectionPath;
    });
  }, [beginRedemption]);

  if (retryable) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-gray-50 px-6 text-center">
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
      <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
