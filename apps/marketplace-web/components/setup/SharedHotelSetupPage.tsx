"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  SharedAccountDetailsStep,
  SharedFirstRunPropertySetupWizard,
  createBrowserAuthHandoff,
  crossAppReauthenticationUrl,
  isSharedAccountDetailsComplete,
  isSafeSharedHotelSetupReturnTo,
  normalizeSharedAccountName,
  parseSharedHotelSetupEntryProduct,
  safeSharedHotelSetupReturnTo,
  type SharedFirstRunContinueInput,
  type SharedHotelSetupEntryProduct,
  type SharedSetupTaskFormContext,
} from "@vayada/product-onboarding";

import { ROUTES } from "@/lib/constants";
import { authService } from "@/services/auth";
import {
  sharedAccountProfileImageUploader,
  sharedHotelSetupApi,
} from "@/services/api/sharedHotelSetupClient";
import { hotelOperationsSetupApi } from "@/services/api/hotelOperationsSetupClient";
import { getAuthCsrfToken, getAuthSessionUser } from "@/services/auth/sessionStore";
import { AdaptiveRoomAuthoringSetupController } from "./adaptive/rooms/AdaptiveRoomAuthoringSetupController";
import { SetupTaskFormRouter } from "./SetupTaskFormRouter";

const PMS_FRONTEND_URL = process.env.NEXT_PUBLIC_PMS_URL || "https://pms.vayada.com";
const BOOKING_ADMIN_URL =
  process.env.NEXT_PUBLIC_BOOKING_ADMIN_URL || "https://admin.booking.vayada.com";
const PROPERTY_LAUNCH_SETTINGS_API = {
  get: (propertyId: string, options?: RequestInit) =>
    hotelOperationsSetupApi.getPropertyLaunchSettings(propertyId, options?.signal ?? undefined),
  update: hotelOperationsSetupApi.updatePropertyLaunchSettings,
};

export function SharedHotelSetupPage({
  defaultEntryProduct,
  defaultReturnTo,
  adaptiveShellEnabled = false,
}: {
  defaultEntryProduct: SharedHotelSetupEntryProduct;
  defaultReturnTo: string;
  adaptiveShellEnabled?: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [authorized, setAuthorized] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [handoffError, setHandoffError] = useState<string | null>(null);
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

  const handlePropertySelected = (propertyId: string) => {
    localStorage.setItem("selectedSharedPropertyId", propertyId);
    router.replace(setupPathForSelectedProperty(searchParams.toString(), propertyId), {
      scroll: false,
    });
  };

  const handoffToProduct = async (
    product: Exclude<SharedHotelSetupEntryProduct, "marketplace">,
    targetPath: string,
    propertyId?: string | null,
  ) => {
    setHandoffError(null);
    const baseUrl = product === "booking" ? BOOKING_ADMIN_URL : PMS_FRONTEND_URL;
    const targetSurface = product === "booking" ? "booking-admin" : "pms-web";
    const csrfToken = getAuthCsrfToken();
    if (csrfToken) {
      try {
        window.location.replace(
          await createBrowserAuthHandoff({
            csrfToken,
            routingHints: propertyId ? { propertyId } : undefined,
            sourceSurface: "marketplace-web",
            targetPath,
            targetSurface,
          }),
        );
        return;
      } catch {
        // Require target-app authentication when the one-time exchange is unavailable.
      }
    }
    try {
      window.location.replace(crossAppReauthenticationUrl(baseUrl, targetPath));
    } catch {
      setHandoffError("We couldn't open that app. Please check the app URL and try again.");
    }
  };

  const handleContinue = async (input: SharedFirstRunContinueInput) => {
    localStorage.setItem("selectedSharedPropertyId", input.propertyId);
    const requestedReturnTo = input.product === returnProduct ? input.returnTo : null;
    if (input.product === "booking") {
      await handoffToProduct(
        "booking",
        safeSharedHotelSetupReturnTo(requestedReturnTo, "/dashboard"),
        input.propertyId,
      );
      return;
    }
    if (input.product === "pms") {
      await handoffToProduct(
        "pms",
        safeSharedHotelSetupReturnTo(requestedReturnTo, "/dashboard"),
        input.propertyId,
      );
      return;
    }
    router.replace(
      returnProduct === "marketplace" && isSafeSharedHotelSetupReturnTo(input.returnTo)
        ? input.returnTo
        : ROUTES.MARKETPLACE,
    );
  };

  const handleExit = () => {
    if (returnProduct === "marketplace") {
      router.replace(returnTo);
      return;
    }
    void handoffToProduct(
      returnProduct,
      returnTo,
      localStorage.getItem("selectedSharedPropertyId"),
    );
  };

  if (checkingAuth || !authorized) {
    return (
      <div
        className="flex min-h-screen items-center justify-center bg-gray-50 px-6"
        role="status"
        aria-live="polite"
      >
        <p className="text-sm font-medium text-gray-600">Confirming your setup session…</p>
      </div>
    );
  }

  if (handoffError) {
    return (
      <main className="flex min-h-[100dvh] items-center justify-center bg-gray-50 px-6 py-12">
        <div
          className="w-full max-w-xl rounded-2xl border border-red-200 bg-white px-6 py-8 text-center sm:px-10"
          role="alert"
        >
          <h1 className="text-xl font-semibold text-gray-950">Unable to open the app</h1>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-gray-600">{handoffError}</p>
          <button
            type="button"
            onClick={() => setHandoffError(null)}
            className="mt-5 min-h-10 rounded-full bg-primary-600 px-5 py-2 text-sm font-semibold text-white outline-none hover:bg-primary-700 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"
          >
            Return to setup
          </button>
        </div>
      </main>
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

  if (adaptiveShellEnabled) {
    if (initialPropertyId) {
      return (
        <AdaptiveRoomAuthoringSetupController
          key={initialPropertyId}
          propertyId={initialPropertyId}
          requestedStepId={searchParams.get("step")}
          onExit={handleExit}
        />
      );
    }

    return (
      <main className="flex min-h-[100dvh] items-center justify-center bg-gray-50 px-6 py-12">
        <div
          className="w-full max-w-xl rounded-2xl border border-amber-200 bg-white px-6 py-8 text-center sm:px-10"
          role="alert"
        >
          <h1 className="text-xl font-semibold text-gray-950">Choose a hotel to continue</h1>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-gray-600">
            This setup link does not identify a hotel. Return to your dashboard, select the hotel,
            and open setup again.
          </p>
          <button
            type="button"
            onClick={handleExit}
            className="mt-5 min-h-10 rounded-full bg-primary-600 px-5 py-2 text-sm font-semibold text-white outline-none hover:bg-primary-700 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"
          >
            Exit setup
          </button>
        </div>
      </main>
    );
  }

  return (
    <SharedFirstRunPropertySetupWizard
      api={sharedHotelSetupApi}
      entryProduct={entryProduct}
      initialPropertyId={initialPropertyId}
      returnTo={returnTo}
      initialAddProperty={initialAddProperty}
      propertyLaunchSettingsApi={PROPERTY_LAUNCH_SETTINGS_API}
      onContinue={handleContinue}
      onPropertySelected={handlePropertySelected}
      renderTaskForm={(context: SharedSetupTaskFormContext) => <SetupTaskFormRouter {...context} />}
      onExit={handleExit}
    />
  );
}

export function setupPathForSelectedProperty(query: string, propertyId: string): string {
  const searchParams = new URLSearchParams(query);
  searchParams.set("propertyId", propertyId);
  searchParams.delete("mode");
  return `${ROUTES.SETUP}?${searchParams.toString()}`;
}
