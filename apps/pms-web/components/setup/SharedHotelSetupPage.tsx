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

import { authService } from "@/services/auth";
import { getAuthSessionUser } from "@/services/auth/sessionStore";
import { sharedHotelSetupApi } from "@/services/api/sharedHotelSetupClient";
import { SELECTED_SHARED_PROPERTY_ID_KEY } from "@/lib/utils/pmsPropertySelectionKeys";

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
        if (!ok || !authService.isHotelAdmin()) {
          router.replace("/login");
          return;
        }
        const user = getAuthSessionUser();
        setAccountContactEmail(user?.email ?? localStorage.getItem("userEmail"));
        setAccountContactPhone(user?.phone ?? null);
        setAuthorized(true);
      })
      .catch(() => {
        if (!cancelled) router.replace("/login");
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
    localStorage.setItem(SELECTED_SHARED_PROPERTY_ID_KEY, input.propertyId);
    if (input.action === "complete_product_activation" && input.product === "pms") {
      router.push("/rooms");
      return;
    }
    if (isSafeSharedHotelSetupReturnTo(input.returnTo)) {
      router.push(input.returnTo);
      return;
    }
    router.push(input.product === "pms" ? "/dashboard" : returnTo);
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
