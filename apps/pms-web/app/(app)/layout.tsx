"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Header from "@/components/layout/Header";
import Sidebar from "@/components/layout/Sidebar";
import { authService } from "@/services/auth";
import { resolvePmsSetupGuard } from "@/lib/utils/sharedSetupGuard";
import { pmsSetupExitPropertyId } from "@vayada/product-onboarding";
import { useTranslation } from "@/lib/i18n";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [setupGuardError, setSetupGuardError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setIsAuthorized(false);
    setSetupGuardError(false);
    async function authorize() {
      let authorized = false;
      try {
        authorized = await authService.ensureSession();
      } catch (error) {
        console.error("Failed to verify PMS session:", error);
        if (!cancelled) router.replace(loginPathForCurrentRoute("/dashboard"));
        return;
      }
      if (cancelled) return;
      if (!authorized || !authService.isHotelAdmin()) {
        router.replace(loginPathForCurrentRoute("/dashboard"));
        return;
      }

      const returnTo =
        typeof window === "undefined"
          ? "/dashboard"
          : `${window.location.pathname}${window.location.search}`;
      const setupExitPropertyId = pmsSetupExitPropertyId(returnTo);
      let decision: Awaited<ReturnType<typeof resolvePmsSetupGuard>>;
      try {
        decision = await resolvePmsSetupGuard(returnTo, undefined, undefined, undefined, {
          propertyId: setupExitPropertyId,
        });
      } catch (error) {
        console.error("Failed to verify PMS setup:", error);
        if (!cancelled) {
          setSetupGuardError(true);
        }
        return;
      }
      if (cancelled) return;
      setSetupGuardError(false);
      if (decision.action === "redirect_to_setup") {
        window.location.replace(decision.redirectPath);
        return;
      }
      setIsAuthorized(true);
    }
    void authorize();
    return () => {
      cancelled = true;
    };
  }, [pathname, router]);

  if (setupGuardError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="w-full max-w-sm rounded-lg border border-amber-200 bg-white p-6 text-center shadow-sm">
          <h1 className="text-base font-semibold text-gray-950">{t("layout.setupGuardError")}</h1>
          <p className="mt-2 text-sm text-gray-600">{t("layout.refreshToRetry")}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 rounded-md bg-gray-950 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
          >
            {t("auth.chooseProperty.retry")}
          </button>
        </div>
      </div>
    );
  }

  if (!isAuthorized) {
    return null;
  }

  return (
    // 100dvh (not 100vh): on iOS Safari 100vh ignores the URL bar, so the
    // shell's bottom — and any sticky footers anchored to it — sit behind
    // the browser chrome until Safari collapses it mid-scroll.
    <div className="h-[100dvh] flex overflow-x-hidden">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      {/* Sidebar: hidden on mobile, shown as overlay when open */}
      <div
        className={`fixed inset-y-0 left-0 z-50 lg:static lg:z-auto transition-transform duration-200 ${sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}`}
      >
        <Sidebar onNavigate={() => setSidebarOpen(false)} />
      </div>
      <div className="flex-1 flex flex-col min-w-0">
        <Header onMenuToggle={() => setSidebarOpen(!sidebarOpen)} />
        <main className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain bg-gray-50">
          {children}
        </main>
      </div>
    </div>
  );
}

function loginPathForCurrentRoute(fallbackReturnTo: string): string {
  const returnTo =
    typeof window === "undefined"
      ? fallbackReturnTo
      : `${window.location.pathname}${window.location.search}`;
  return `/login?returnTo=${encodeURIComponent(returnTo)}`;
}
