"use client";

import { useEffect } from "react";
import {
  getStoredPmsPropertyId,
  listPmsProperties,
  storeSelectedPmsPropertyId,
  type PmsPropertySummary,
} from "@/services/api/pmsPropertyClient";

export default function HandoffPage() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    // Auth data in URL hash (not query) so it never hits server logs.
    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    const token = hashParams.get("token");
    const expiresAt = hashParams.get("expires_at");
    const userData = hashParams.get("user");
    const handoffHotelId = hashParams.get("hotel_id");

    // Optional `?redirect=...` query param — honored if it's a
    // same-origin relative path, else ignored. Used when another
    // app needs to hand off and land on a specific page (e.g.
    // /choose-property, /setup?mode=add).
    const queryParams = new URLSearchParams(window.location.search);
    const redirectParam = queryParams.get("redirect");
    const safeRedirect =
      redirectParam && redirectParam.startsWith("/") && !redirectParam.startsWith("//")
        ? redirectParam
        : null;

    if (token && expiresAt) {
      localStorage.setItem("access_token", token);
      localStorage.setItem("token_expires_at", expiresAt);
      if (userData) {
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

      // Check PMS setup status before redirecting.
      // Precedence: explicit safeRedirect > choose-property (if 2+ hotels and no
      // valid selected PMS property) > setup (if incomplete) > dashboard.
      (async () => {
        let properties: PmsPropertySummary[] = [];
        let selectedPmsPropertyId = handoffHotelId?.trim() || getStoredPmsPropertyId();

        if (selectedPmsPropertyId) {
          storeSelectedPmsPropertyId(selectedPmsPropertyId);
        } else {
          try {
            properties = await listPmsProperties();
            const selected = properties[0] ?? null;
            if (selected) {
              selectedPmsPropertyId = selected.id;
              storeSelectedPmsPropertyId(selected.id);
            }
          } catch {
            /* A missing list read model should not clear a valid AuthKit resource selection. */
          }
        }

        if (!safeRedirect && !selectedPmsPropertyId && properties.length > 1) {
          window.location.href = "/choose-property";
          return;
        }

        const setupComplete = Boolean(selectedPmsPropertyId || properties.length > 0);
        localStorage.setItem("pmsSetupComplete", setupComplete ? "true" : "false");

        if (safeRedirect) {
          window.location.href = safeRedirect;
          return;
        }
        if (!setupComplete) {
          window.location.href = "/setup";
          return;
        }

        // If the caller already told us which hotel to land on,
        // honor it and skip the choose-property step.
        if (selectedPmsPropertyId) {
          window.location.href = "/dashboard";
          return;
        }

        window.location.href = "/dashboard";
      })().catch(() => {
        if (getStoredPmsPropertyId()) {
          localStorage.setItem("pmsSetupComplete", "true");
          window.location.href = safeRedirect ?? "/dashboard";
          return;
        }
        localStorage.setItem("pmsSetupComplete", "false");
        window.location.href = "/setup";
      });
    } else {
      window.location.href = "/login";
    }
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
