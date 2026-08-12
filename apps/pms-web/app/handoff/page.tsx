"use client";

import { useEffect, useState } from "react";
import {
  clearStoredPmsPropertyId,
  getStoredPmsPropertyId,
  listPmsProperties,
  storeSelectedPmsPropertyId,
  type PmsPropertySummary,
} from "@/services/api/pmsPropertyClient";
import { authService } from "@/services/auth";
import { isAuthOrganizationSelectionResponse } from "@/services/auth/sessionStore";
import {
  isSafeRelativeReturnTo,
  missingOrganizationHandoffLoginPath,
  organizationSelectionLoginPath,
} from "@vayada/product-onboarding/returnTo";
import {
  BrowserAuthHandoffError,
  isPmsSetupExitPath,
  pmsSetupExitPropertyId,
  redeemBrowserAuthHandoff,
  useSingleFlightGuard,
} from "@vayada/product-onboarding";

export default function HandoffPage() {
  const [retryable, setRetryable] = useState(false);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const beginRedemption = useSingleFlightGuard();

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!beginRedemption()) return;

    // Auth data in URL hash (not query) so it never hits server logs.
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

    // Optional `?redirect=...` query param — honored if it's a
    // same-origin relative path, else ignored. Used when another
    // app needs to hand off and land on a specific page (e.g.
    // /choose-property, /setup?mode=add).
    const queryParams = new URLSearchParams(window.location.search);
    const redirectParam = queryParams.get("redirect");
    let safeRedirect = isSafeRelativeReturnTo(redirectParam) ? redirectParam : null;

    void (async () => {
      if (code) {
        try {
          const handoff = await redeemBrowserAuthHandoff({
            code,
            targetSurface: "pms-web",
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
          const session = await authService.refreshSession();
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

            const selectedSession = await authService.refreshSession(
              workosOrganizationId ?? organization.workosOrganizationId,
            );
            if (
              isAuthOrganizationSelectionResponse(selectedSession) ||
              (organizationId && selectedSession.organizationId !== organizationId) ||
              (workosOrganizationId &&
                selectedSession.workosOrganizationId !== workosOrganizationId)
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
            const selectedSession = await authService.refreshSession(workosOrganizationId);
            if (
              isAuthOrganizationSelectionResponse(selectedSession) ||
              (organizationId && selectedSession.organizationId !== organizationId) ||
              selectedSession.workosOrganizationId !== workosOrganizationId
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

      const routingPropertyId = propertyId?.trim() || handoffHotelId?.trim() || null;
      const setupExit = Boolean(safeRedirect && isPmsSetupExitPath(safeRedirect));
      const setupExitPropertyId = safeRedirect ? pmsSetupExitPropertyId(safeRedirect) : null;
      if (routingPropertyId && setupExit && routingPropertyId !== setupExitPropertyId) {
        clearStoredPmsPropertyId();
        setHandoffError("The setup exit does not match the property from your session transfer.");
        return;
      }

      let properties: PmsPropertySummary[];
      try {
        properties = await listPmsProperties();
      } catch {
        if (safeRedirect && isPmsSetupExitPath(safeRedirect)) {
          setRetryable(true);
          return;
        }
        localStorage.setItem("pmsSetupComplete", "false");
        window.location.href = routingPropertyId
          ? `/setup?entryProduct=pms&propertyId=${encodeURIComponent(routingPropertyId)}`
          : "/setup";
        return;
      }

      const explicitPropertyId = routingPropertyId || setupExitPropertyId;
      const requestedPropertyId = explicitPropertyId || getStoredPmsPropertyId();
      let selected = requestedPropertyId
        ? (properties.find((property) => property.id === requestedPropertyId) ?? null)
        : null;

      if (requestedPropertyId && !selected) {
        clearStoredPmsPropertyId();
      }
      if (!explicitPropertyId && !selected && properties.length === 1) {
        selected = properties[0]!;
      }
      if (selected) {
        storeSelectedPmsPropertyId(selected.id);
      }

      if (safeRedirect && isExplicitSetupRedirect(safeRedirect)) {
        window.location.href = safeRedirect;
        return;
      }
      if (explicitPropertyId && !selected) {
        localStorage.setItem("pmsSetupComplete", "false");
        if (safeRedirect && isPmsSetupExitPath(safeRedirect)) {
          setHandoffError(
            "The property you were setting up is no longer available in this hotel group.",
          );
          return;
        }
        window.location.href = `/setup?entryProduct=pms&propertyId=${encodeURIComponent(explicitPropertyId)}`;
        return;
      }
      if (
        safeRedirect &&
        isPmsSetupExitPath(safeRedirect) &&
        (selected || safeRedirect.startsWith("/choose-property?"))
      ) {
        window.location.href = safeRedirect;
        return;
      }
      if (properties.length === 0) {
        localStorage.setItem("pmsSetupComplete", "false");
        window.location.href = "/setup";
        return;
      }
      if (!selected && properties.length > 1) {
        localStorage.setItem("pmsSetupComplete", "true");
        window.location.href = "/choose-property";
        return;
      }
      if (safeRedirect) {
        window.location.href = safeRedirect;
        return;
      }

      localStorage.setItem("pmsSetupComplete", "true");
      window.location.href = "/dashboard";
    })().catch(() => {
      if (safeRedirect && isPmsSetupExitPath(safeRedirect)) {
        setRetryable(true);
        return;
      }
      localStorage.setItem("pmsSetupComplete", "false");
      window.location.href = "/setup";
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

  if (handoffError) {
    return (
      <div
        className="min-h-screen flex flex-col items-center justify-center gap-4 bg-gray-50 px-6 text-center"
        role="alert"
      >
        <p className="max-w-md text-sm font-medium text-gray-700">{handoffError}</p>
        <a href="/choose-property" className="text-sm font-semibold text-primary-600 underline">
          Choose another property
        </a>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div
        className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin"
        role="status"
        aria-label="Transferring your session"
      />
    </div>
  );
}

function isExplicitSetupRedirect(path: string | null): boolean {
  return path === "/setup" || path?.startsWith("/setup?") === true;
}
