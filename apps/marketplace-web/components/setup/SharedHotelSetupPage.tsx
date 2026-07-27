"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  SharedAccountDetailsStep,
  SharedFirstRunPropertySetupWizard,
  isSharedAccountDetailsComplete,
  isSafeSharedHotelSetupReturnTo,
  normalizeSharedAccountName,
  parseSharedHotelSetupEntryProduct,
  safeSharedHotelSetupReturnTo,
  type SharedFirstRunContinueInput,
  type SharedHotelSetupEntryProduct,
} from "@vayada/product-onboarding";

import { ROUTES } from "@/lib/constants";
import {
  clearSetupReturnContext,
  readSetupReturnContext,
  saveSetupReturnContext,
} from "@/lib/utils/setupReturnContext";
import { authService } from "@/services/auth";
import {
  sharedAccountProfileImageUploader,
  sharedHotelSetupApi,
} from "@/services/api/sharedHotelSetupClient";
import { getAuthSessionUser } from "@/services/auth/sessionStore";

const PMS_FRONTEND_URL = process.env.NEXT_PUBLIC_PMS_URL || "https://pms.vayada.com";
const BOOKING_ADMIN_URL =
  process.env.NEXT_PUBLIC_BOOKING_ADMIN_URL || "https://admin.booking.vayada.com";

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
        if (!ok || authService.getUserType() !== "hotel") {
          router.replace(ROUTES.LOGIN);
          return;
        }
        const user = getAuthSessionUser();
        setAccountName(user?.name ?? localStorage.getItem("userName"));
        setAccountContactEmail(user?.email ?? null);
        setAccountContactPhone(user?.phone ?? null);
        setAccountProfilePictureUrl(user?.profilePictureUrl ?? null);
        setAccountProfilePictureMediaObjectId(user?.profilePictureMediaObjectId ?? null);
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
  const returnProduct = useMemo(
    () => parseSharedHotelSetupEntryProduct(searchParams.get("returnProduct")) ?? "marketplace",
    [searchParams],
  );
  const returnTo = useMemo(
    () =>
      safeSharedHotelSetupReturnTo(
        searchParams.get("returnTo"),
        returnProduct === "marketplace" ? defaultReturnTo : "/dashboard",
      ),
    [defaultReturnTo, returnProduct, searchParams],
  );
  const initialAddProperty = searchParams.get("mode") === "add";
  const initialPropertyId = searchParams.get("propertyId");
  const setupQuery = searchParams.toString();
  const hasExplicitReturnContext =
    parseSharedHotelSetupEntryProduct(searchParams.get("entryProduct")) !== null &&
    parseSharedHotelSetupEntryProduct(searchParams.get("returnProduct")) !== null &&
    isSafeSharedHotelSetupReturnTo(searchParams.get("returnTo"));
  const [restoringReturnContext, setRestoringReturnContext] = useState(() =>
    Boolean(initialPropertyId && !hasExplicitReturnContext),
  );

  useEffect(() => {
    if (!initialPropertyId || hasExplicitReturnContext) {
      setRestoringReturnContext(false);
      return;
    }

    const storedContext = readSetupReturnContext(initialPropertyId);
    if (!storedContext) {
      setRestoringReturnContext(false);
      return;
    }

    setRestoringReturnContext(true);
    const restored = new URLSearchParams(setupQuery);
    restored.set("entryProduct", storedContext.entryProduct);
    restored.set("returnProduct", storedContext.returnProduct);
    restored.set("returnTo", storedContext.returnTo);
    router.replace(`/setup?${restored.toString()}`);
  }, [hasExplicitReturnContext, initialPropertyId, router, setupQuery]);

  const handleContinue = async (input: SharedFirstRunContinueInput) => {
    localStorage.setItem("selectedSharedPropertyId", input.propertyId);
    if (input.action === "continue_setup") {
      saveSetupReturnContext({
        propertyId: input.propertyId,
        entryProduct,
        returnProduct,
        returnTo,
      });
      const handoff = await sharedHotelSetupApi.createHandoff({
        propertyId: input.propertyId,
        taskId: input.taskId,
        planRevision: input.planRevision,
      });
      window.location.href = handoff.launchUrl;
      return;
    }
    clearSetupReturnContext();
    const requestedReturnTo = input.product === returnProduct ? input.returnTo : null;
    if (input.product === "booking") {
      window.location.replace(productReturnUrl("booking", requestedReturnTo));
      return;
    }
    if (input.product === "pms") {
      window.location.replace(productReturnUrl("pms", requestedReturnTo));
      return;
    }
    router.replace(
      returnProduct === "marketplace" && isSafeSharedHotelSetupReturnTo(input.returnTo)
        ? input.returnTo
        : ROUTES.MARKETPLACE,
    );
  };

  if (checkingAuth || !authorized || restoringReturnContext) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-gray-950" />
      </div>
    );
  }

  if (
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
      onContinue={handleContinue}
      onExit={() => {
        clearSetupReturnContext();
        if (returnProduct === "marketplace") {
          router.replace(returnTo);
          return;
        }
        window.location.replace(productReturnUrl(returnProduct, returnTo));
      }}
    />
  );
}

function productReturnUrl(
  product: Exclude<SharedHotelSetupEntryProduct, "marketplace">,
  returnTo: string | null,
): string {
  const safeReturnTo = safeSharedHotelSetupReturnTo(returnTo, "/dashboard");
  return new URL(
    safeReturnTo,
    product === "booking" ? BOOKING_ADMIN_URL : PMS_FRONTEND_URL,
  ).toString();
}
