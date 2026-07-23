"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  SharedAccountDetailsStep,
  SharedFirstRunPropertySetupWizard,
  buildProductHandoffUrl,
  isSharedAccountDetailsComplete,
  isSafeSharedHotelSetupReturnTo,
  normalizeSharedAccountName,
  parseSharedHotelSetupEntryProduct,
  safeSharedHotelSetupReturnTo,
  type SharedFirstRunProductContinueInput,
  type SharedHotelSetupEntryProduct,
} from "@vayada/product-onboarding";

import { authService } from "@/services/auth";
import { getAuthSessionUser, getAuthWorkosOrganizationId } from "@/services/auth/sessionStore";
import {
  sharedAccountProfileImageUploader,
  sharedHotelSetupApi,
} from "@/services/api/sharedHotelSetupClient";
import { storeSelectedPmsPropertyId } from "@/services/api/pmsPropertyClient";

const BOOKING_ADMIN_URL =
  process.env.NEXT_PUBLIC_BOOKING_ADMIN_URL || "https://admin.booking.vayada.com";
const MARKETPLACE_FRONTEND_URL =
  process.env.NEXT_PUBLIC_MARKETPLACE_URL || "https://app.vayada.com";

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
  const [accountName, setAccountName] = useState<string | null>(null);
  const [accountContactEmail, setAccountContactEmail] = useState<string | null>(null);
  const [accountContactPhone, setAccountContactPhone] = useState<string | null>(null);
  const [accountProfilePictureUrl, setAccountProfilePictureUrl] = useState<string | null>(null);
  const [accountProfilePictureMediaObjectId, setAccountProfilePictureMediaObjectId] = useState<
    string | null
  >(null);

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
        setAccountName(user?.name ?? localStorage.getItem("userName"));
        setAccountContactEmail(user?.email ?? localStorage.getItem("userEmail"));
        setAccountContactPhone(user?.phone ?? null);
        setAccountProfilePictureUrl(user?.profilePictureUrl ?? null);
        setAccountProfilePictureMediaObjectId(user?.profilePictureMediaObjectId ?? null);
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
    storeSelectedPmsPropertyId(input.propertyId);
    const workosOrganizationId = getAuthWorkosOrganizationId();
    if (input.product === "booking") {
      const redirect = `/setup?${new URLSearchParams({
        entryProduct: "booking",
        propertyId: input.propertyId,
      }).toString()}`;
      window.location.href = buildProductHandoffUrl(
        BOOKING_ADMIN_URL,
        input.propertyId,
        input.organizationId,
        workosOrganizationId,
        redirect,
      );
      return;
    }
    if (input.product === "marketplace") {
      const redirect =
        input.action === "complete_product_activation"
          ? `/profile/complete?${new URLSearchParams({
              activation: "marketplace",
              propertyId: input.propertyId,
            }).toString()}`
          : undefined;
      window.location.href = buildProductHandoffUrl(
        MARKETPLACE_FRONTEND_URL,
        input.propertyId,
        input.organizationId,
        workosOrganizationId,
        redirect,
      );
      return;
    }
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

  if (
    getAuthSessionUser() &&
    !isSharedAccountDetailsComplete({
      name: accountName,
      phone: accountContactPhone,
      profilePictureUrl: accountProfilePictureUrl,
      profilePictureMediaObjectId: accountProfilePictureMediaObjectId,
    })
  ) {
    return (
      <SharedAccountDetailsStep
        accountType="hotel"
        email={accountContactEmail ?? ""}
        initialName={accountName}
        initialPhone={accountContactPhone}
        initialProfilePictureUrl={accountProfilePictureUrl}
        initialProfilePictureMediaObjectId={accountProfilePictureMediaObjectId}
        onUploadProfileImage={(file) => {
          const userId = getAuthSessionUser()?.id;
          if (!userId) throw new Error("Your session has expired. Please sign in again.");
          return sharedAccountProfileImageUploader(userId, file);
        }}
        onSubmit={async (accountDetails) => {
          await authService.updateAccountDetails(accountDetails);
          setAccountName(
            normalizeSharedAccountName(accountDetails.firstName, accountDetails.lastName),
          );
          setAccountContactPhone(accountDetails.phone ?? null);
          if (accountDetails.profilePictureUrl) {
            setAccountProfilePictureUrl(accountDetails.profilePictureUrl);
          }
          if (accountDetails.profilePictureMediaObjectId) {
            setAccountProfilePictureMediaObjectId(accountDetails.profilePictureMediaObjectId);
          }
        }}
      />
    );
  }

  return (
    <SharedFirstRunPropertySetupWizard
      api={sharedHotelSetupApi}
      entryProduct={entryProduct}
      initialPropertyId={initialPropertyId}
      returnTo={returnTo}
      initialAddProperty={initialAddProperty}
      autoContinueToProduct
      accountContactEmail={accountContactEmail}
      accountContactPhone={accountContactPhone}
      onProductContinue={handleProductContinue}
    />
  );
}
