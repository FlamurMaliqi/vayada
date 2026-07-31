"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { authService } from "@/services/auth";
import { resolveBookingSetupGuard } from "@/lib/utils/sharedSetupGuard";

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    async function redirect() {
      let authorized = false;
      try {
        authorized = await authService.ensureSession();
      } catch (error) {
        console.error("Failed to verify booking admin session:", error);
        if (!cancelled) router.replace("/login");
        return;
      }
      if (cancelled) return;
      if (authorized && authService.isHotelAdmin()) {
        let decision: Awaited<ReturnType<typeof resolveBookingSetupGuard>>;
        try {
          decision = await resolveBookingSetupGuard("/dashboard");
        } catch (error) {
          console.error("Failed to verify booking setup:", error);
          if (!cancelled) router.replace("/login");
          return;
        }
        if (cancelled) return;
        if (decision.action === "redirect_to_setup") {
          window.location.replace(decision.redirectPath);
          return;
        }
        router.replace("/dashboard");
      } else {
        router.replace("/login");
      }
    }
    void redirect();
    return () => {
      cancelled = true;
    };
  }, [router]);

  return null;
}
