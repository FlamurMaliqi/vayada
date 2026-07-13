"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  SharedFirstRunPropertySetupWizard,
  isSafeSharedHotelSetupReturnTo,
  parseSharedHotelSetupEntryProduct,
  safeSharedHotelSetupReturnTo,
  type SharedFirstRunProductContinueInput,
  type SharedHotelSetupEntryProduct,
} from "@vayada/product-onboarding";

import { ROUTES } from "@/lib/constants";
import { canOpenMarketplaceProfileTools } from "@/lib/utils/sharedSetupGuard";
import { authService } from "@/services/auth";
import { sharedHotelSetupApi } from "@/services/api/sharedHotelSetupClient";
import { getAuthSessionUser } from "@/services/auth/sessionStore";

const PMS_FRONTEND_URL = process.env.NEXT_PUBLIC_PMS_URL || "https://pms.vayada.com";
const BOOKING_ADMIN_URL =
  process.env.NEXT_PUBLIC_BOOKING_ADMIN_URL || "https://admin.booking.vayada.com";

function productHandoffUrl(baseUrl: string, propertyId: string): string {
  return `${baseUrl}/handoff#${new URLSearchParams({ property_id: propertyId }).toString()}`;
}

export function SharedHotelSetupPage({
  defaultEntryProduct,
  defaultReturnTo,
}: {
  defaultEntryProduct: SharedHotelSetupEntryProduct;
  defaultReturnTo: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [authorized, setAuthorized] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [accountContactEmail, setAccountContactEmail] = useState<string | null>(null);
  const [accountContactPhone, setAccountContactPhone] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void authService
      .ensureSession()
      .then((ok) => {
        if (cancelled) return;
        if (!ok || authService.getUserType() !== "hotel") {
          router.replace(ROUTES.LOGIN);
          return;
        }
        const user = getAuthSessionUser();
        setAccountContactEmail(user?.email ?? null);
        setAccountContactPhone(user?.phone ?? null);
        setAuthorized(true);
      })
      .catch(() => {
        if (!cancelled) router.replace(ROUTES.LOGIN);
      })
      .finally(() => {
        if (!cancelled) setCheckingAuth(false);
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  const entryProduct = useMemo(
    () =>
      parseSharedHotelSetupEntryProduct(searchParams.get("entryProduct")) ?? defaultEntryProduct,
    [defaultEntryProduct, searchParams],
  );
  const returnTo = useMemo(
    () => safeSharedHotelSetupReturnTo(searchParams.get("returnTo"), defaultReturnTo),
    [defaultReturnTo, searchParams],
  );
  const initialAddProperty = searchParams.get("mode") === "add";
  const initialPropertyId = searchParams.get("propertyId");

  const handleProductContinue = (input: SharedFirstRunProductContinueInput) => {
    localStorage.setItem("selectedSharedPropertyId", input.propertyId);
    if (input.product === "booking") {
      window.location.href = productHandoffUrl(BOOKING_ADMIN_URL, input.propertyId);
      return;
    }
    if (input.product === "pms") {
      window.location.href = productHandoffUrl(PMS_FRONTEND_URL, input.propertyId);
      return;
    }
    if (input.action === "complete_product_activation" && canOpenMarketplaceProfileTools(input)) {
      router.push(ROUTES.PROFILE);
      return;
    }
    if (isSafeSharedHotelSetupReturnTo(input.returnTo)) {
      router.push(input.returnTo);
      return;
    }
    router.push(input.product === "marketplace" ? ROUTES.MARKETPLACE : returnTo);
  };

  if (checkingAuth || !authorized) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-gray-950" />
      </div>
    );
  }

  return (
    <SharedFirstRunPropertySetupWizard
      api={sharedHotelSetupApi}
      entryProduct={entryProduct}
      initialPropertyId={initialPropertyId}
      returnTo={returnTo}
      initialAddProperty={initialAddProperty}
      accountContactEmail={accountContactEmail}
      accountContactPhone={accountContactPhone}
      onProductContinue={handleProductContinue}
    />
  );
}
