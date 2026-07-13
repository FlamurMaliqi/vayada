"use client";

import { useEffect } from "react";
import {
  clearStoredPmsPropertyId,
  getStoredPmsPropertyId,
  listPmsProperties,
  storeSelectedPmsPropertyId,
  type PmsPropertySummary,
} from "@/services/api/pmsPropertyClient";
import { authService } from "@/services/auth";
import { isSafeRelativeReturnTo } from "@vayada/product-onboarding/returnTo";

export default function HandoffPage() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    // Auth data in URL hash (not query) so it never hits server logs.
    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    const token = hashParams.get("token");
    const expiresAt = hashParams.get("expires_at");
    const userData = hashParams.get("user");
    const handoffHotelId = hashParams.get("hotel_id");
    const propertyId = hashParams.get("property_id");

    // Optional `?redirect=...` query param — honored if it's a
    // same-origin relative path, else ignored. Used when another
    // app needs to hand off and land on a specific page (e.g.
    // /choose-property, /setup?mode=add).
    const queryParams = new URLSearchParams(window.location.search);
    const redirectParam = queryParams.get("redirect");
    const safeRedirect = isSafeRelativeReturnTo(redirectParam) ? redirectParam : null;

    void (async () => {
      if (token && expiresAt) {
        localStorage.setItem("access_token", token);
        localStorage.setItem("token_expires_at", expiresAt);
      } else if (!(await authService.ensureSession())) {
        window.location.href = "/login";
        return;
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

      let properties: PmsPropertySummary[];
      try {
        properties = await listPmsProperties();
      } catch {
        localStorage.setItem("pmsSetupComplete", "false");
        window.location.href = "/setup";
        return;
      }

      const requestedPropertyId =
        propertyId?.trim() || handoffHotelId?.trim() || getStoredPmsPropertyId();
      let selected = requestedPropertyId
        ? (properties.find((property) => property.id === requestedPropertyId) ?? null)
        : null;

      if (requestedPropertyId && !selected) {
        clearStoredPmsPropertyId();
      }
      if (!selected && properties.length === 1) {
        selected = properties[0]!;
      }
      if (selected) {
        storeSelectedPmsPropertyId(selected.id);
      }

      if (safeRedirect) {
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

      localStorage.setItem("pmsSetupComplete", "true");
      window.location.href = "/dashboard";
    })().catch(() => {
      localStorage.setItem("pmsSetupComplete", "false");
      window.location.href = "/setup";
    });
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
