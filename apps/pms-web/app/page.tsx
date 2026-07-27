"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { authService } from "@/services/auth";
import { resolvePmsSetupGuard } from "@/lib/utils/sharedSetupGuard";

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    async function redirect() {
      const authorized = await authService.ensureSession();
      if (cancelled) return;
      if (!authorized || !authService.isHotelAdmin()) {
        router.replace("/login");
        return;
      }

      const decision = await resolvePmsSetupGuard("/dashboard");
      if (cancelled) return;

      router.replace(decision.action === "enter_product" ? "/dashboard" : decision.redirectPath);
    }
    redirect();
    return () => {
      cancelled = true;
    };
  }, [router]);

  return null;
}
