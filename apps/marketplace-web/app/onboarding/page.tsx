"use client";

import { type KeyboardEvent, type MutableRefObject, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ArrowRightIcon, CheckIcon, UserIcon } from "@heroicons/react/24/outline";
import {
  HotelIcon,
  SharedAccountDetailsStep,
  isSharedAccountDetailsComplete,
  type SharedAccountProfileImageUpload,
} from "@vayada/product-onboarding";
import { OnboardingShell } from "@/components/onboarding/OnboardingShell";
import { ROUTES } from "@/lib/constants";
import { authService } from "@/services/auth";
import { creatorService } from "@/services/api/creators";
import {
  hasPendingHotelAccountInvite,
  pendingHotelAccountInviteCode,
} from "@/services/api/hotelAccountInvites";
import { sharedAccountProfileImageUploader } from "@/services/api/sharedHotelSetupClient";
import {
  hasRequiredCreatorAccountDetails,
  hasRequiredCreatorPhoto,
} from "@/lib/utils/creatorAccountRequirements";

type AccountType = "hotel" | "creator";
const ONBOARDING_REQUEST_TIMEOUT_MS = 5_000;

const options: Array<{
  type: AccountType;
  title: string;
  description: string;
  image: string;
}> = [
  {
    type: "hotel",
    title: "I manage a hotel",
    description: "Set up one hotel or manage several from the same account.",
    image: "/hotel-hero.JPG",
  },
  {
    type: "creator",
    title: "I’m a creator",
    description: "Build a profile hotels can review before working with you.",
    image: "/creator-hero.jpg",
  },
];

export default function OnboardingPage() {
  const router = useRouter();
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [selectedType, setSelectedType] = useState<AccountType | null>(null);
  const [pendingHotelInvite, setPendingHotelInvite] = useState(false);
  const [provisionedType, setProvisionedType] = useState<AccountType | null>(null);
  const [setupHandoffType, setSetupHandoffType] = useState<AccountType | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [existingCreatorPhoto, setExistingCreatorPhoto] =
    useState<SharedAccountProfileImageUpload | null>(null);
  const [accountDetailsLoadError, setAccountDetailsLoadError] = useState("");
  const [sessionConfirmed, setSessionConfirmed] = useState(false);
  const [sessionAttempt, setSessionAttempt] = useState(0);

  useEffect(() => {
    const pending = hasPendingHotelAccountInvite();
    setPendingHotelInvite(pending);
    if (pending) setSelectedType("hotel");
  }, []);

  useEffect(() => {
    let cancelled = false;
    const requestController = new AbortController();
    const sessionTimeoutSignal = AbortSignal.timeout(ONBOARDING_REQUEST_TIMEOUT_MS);
    const sessionSignal = AbortSignal.any([requestController.signal, sessionTimeoutSignal]);
    void (async () => {
      try {
        let authenticated: boolean;
        try {
          authenticated = await authService.ensureSession(sessionSignal);
        } catch (error) {
          if (sessionTimeoutSignal.aborted && !requestController.signal.aborted) {
            throw new Error("Loading your session took too long. Please try again.");
          }
          throw error;
        }
        if (cancelled) return;
        if (!authenticated) {
          router.replace(ROUTES.LOGIN);
          return;
        }
        setSessionConfirmed(true);
        const invitePending = hasPendingHotelAccountInvite();
        if (invitePending) {
          setPendingHotelInvite(true);
          setSelectedType("hotel");
          setLoading(false);
          return;
        }
        const userType = authService.getUserType();
        if (userType === "creator" || userType === "hotel") {
          setProvisionedType(userType);
          let accountDetailsStatus;
          try {
            accountDetailsStatus = await loadSharedAccountDetailsStatus(
              userType,
              requestController.signal,
            );
          } catch (error) {
            if (cancelled) return;
            setAccountDetailsLoadError(accountDetailsErrorMessage(error));
            setLoading(false);
            return;
          }
          if (cancelled) return;
          setExistingCreatorPhoto(accountDetailsStatus.existingCreatorPhoto ?? null);
          if (accountDetailsStatus.complete) {
            setSetupHandoffType(userType);
            setLoading(false);
            return;
          }
          setLoading(false);
          return;
        }
        setLoading(false);
      } catch (error) {
        if (cancelled) return;
        setError(error instanceof Error ? error.message : "Failed to load onboarding.");
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      requestController.abort();
    };
  }, [router, sessionAttempt]);

  function retrySession() {
    setError("");
    setLoading(true);
    setSessionConfirmed(false);
    setSessionAttempt((attempt) => attempt + 1);
  }

  async function handleContinue() {
    if (!selectedType) return;
    setError("");
    setSubmitting(true);
    try {
      const inviteCode = selectedType === "hotel" ? pendingHotelAccountInviteCode() : null;
      await authService.completeOnboarding(selectedType, inviteCode ? { inviteCode } : undefined);
      const canonicalType = authService.getUserType();
      if (canonicalType !== "creator" && canonicalType !== "hotel") {
        throw new Error("Your account role could not be confirmed. Please sign in again.");
      }
      setProvisionedType(canonicalType);
      let accountDetailsStatus;
      try {
        accountDetailsStatus = await loadSharedAccountDetailsStatus(canonicalType);
      } catch (error) {
        setAccountDetailsLoadError(accountDetailsErrorMessage(error));
        return;
      }
      setExistingCreatorPhoto(accountDetailsStatus.existingCreatorPhoto ?? null);
      if (accountDetailsStatus.complete) {
        setSetupHandoffType(canonicalType);
        return;
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to continue onboarding.");
    } finally {
      setSubmitting(false);
    }
  }

  async function retryAccountDetailsStatus() {
    if (!provisionedType) return;
    setAccountDetailsLoadError("");
    setSubmitting(true);
    try {
      const accountDetailsStatus = await loadSharedAccountDetailsStatus(provisionedType);
      setExistingCreatorPhoto(accountDetailsStatus.existingCreatorPhoto ?? null);
      if (accountDetailsStatus.complete) setSetupHandoffType(provisionedType);
    } catch (error) {
      setAccountDetailsLoadError(accountDetailsErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }
  function selectOptionAtIndex(index: number) {
    const option = options[index];
    if (!option) return;
    setError("");
    setSelectedType(option.type);
    optionRefs.current[index]?.focus();
  }

  function handleOptionKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const nextKeys: Record<string, number> = {
      ArrowRight: index + 1,
      ArrowDown: index + 1,
      ArrowLeft: index - 1,
      ArrowUp: index - 1,
      Home: 0,
      End: options.length - 1,
    };
    const nextIndex = nextKeys[event.key];
    if (nextIndex === undefined) return;
    event.preventDefault();
    selectOptionAtIndex((nextIndex + options.length) % options.length);
  }

  if (!loading && !sessionConfirmed) {
    return (
      <OnboardingShell
        currentStep={1}
        title="Reconnect your session"
        description="Confirm your account before continuing onboarding."
        showProgress={false}
      >
        <div className="mx-auto max-w-xl rounded-2xl border border-gray-200 bg-white p-6 text-center shadow-sm">
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
          <button
            type="button"
            onClick={retrySession}
            className="mt-5 rounded-xl bg-primary-600 px-5 py-3 text-sm font-semibold text-white hover:bg-primary-700"
          >
            Retry session
          </button>
        </div>
      </OnboardingShell>
    );
  }

  if (!loading && setupHandoffType) {
    return (
      <OnboardingShell
        currentStep={1}
        title="Your profile is ready"
        description=""
        showProgress={false}
      >
        <SignupCompleteMoment
          type={setupHandoffType}
          onContinue={() =>
            router.push(
              pendingHotelInvite && setupHandoffType === "hotel"
                ? "/invite"
                : nextPathForType(setupHandoffType),
            )
          }
        />
      </OnboardingShell>
    );
  }

  if (!loading && provisionedType && accountDetailsLoadError) {
    return (
      <OnboardingShell
        currentStep={1}
        title="Finish setting up your account"
        description="We couldn’t load your current account details."
        showProgress={false}
      >
        <div className="mx-auto max-w-xl rounded-2xl border border-gray-200 bg-white p-6 text-center shadow-sm">
          <p role="alert" className="text-sm text-red-700">
            {accountDetailsLoadError}
          </p>
          <button
            type="button"
            onClick={() => void retryAccountDetailsStatus()}
            disabled={submitting}
            className="mt-5 rounded-xl bg-primary-600 px-5 py-3 text-sm font-semibold text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? "Retrying…" : "Retry account details"}
          </button>
        </div>
      </OnboardingShell>
    );
  }
  if (!loading && provisionedType) {
    const user = authService.getSessionUser();
    return (
      <SharedAccountDetailsStep
        accountType={provisionedType}
        email={user?.email ?? ""}
        initialName={user?.name}
        initialPhone={user?.phone}
        initialProfileImage={
          existingCreatorPhoto ??
          (user?.profilePictureUrl && user.profilePictureMediaObjectId
            ? {
                profilePictureUrl: user.profilePictureUrl,
                profilePictureMediaObjectId: user.profilePictureMediaObjectId,
              }
            : null)
        }
        onUploadProfileImage={(file) => {
          if (!user?.id) throw new Error("Your session has expired. Please sign in again.");
          return sharedAccountProfileImageUploader(user.id, file);
        }}
        onSubmit={async (accountDetails) => {
          if (provisionedType === "creator") {
            const currentProfile = await creatorService.getMyProfile();
            const accountName = `${accountDetails.firstName} ${accountDetails.lastName}`.trim();
            const accountPhone = accountDetails.phone?.trim();
            const shouldProjectPhoto =
              Boolean(accountDetails.profilePictureMediaObjectId) &&
              (!currentProfile.profilePicture?.trim() ||
                accountDetails.profilePictureMediaObjectId !==
                  currentProfile.profilePictureMediaObjectId?.trim());
            const creatorUpdate = {
              ...(!currentProfile.name.trim() ? { name: accountName } : {}),
              ...(!currentProfile.phone?.trim() && accountPhone ? { phone: accountPhone } : {}),
              ...(shouldProjectPhoto
                ? {
                    profilePictureMediaObjectId: accountDetails.profilePictureMediaObjectId,
                  }
                : {}),
            };

            // Project only missing creator fields before marking shared identity details complete.
            if (Object.keys(creatorUpdate).length > 0) {
              await creatorService.updateMyProfile(creatorUpdate);
            }
          }
          await authService.updateAccountDetails(accountDetails);
          setSetupHandoffType(provisionedType);
        }}
      />
    );
  }

  return (
    <OnboardingShell
      currentStep={1}
      title={
        loading
          ? "Getting things ready"
          : pendingHotelInvite
            ? "Create your invited hotel account"
            : "Welcome to vayada — what brings you here?"
      }
      description={
        loading
          ? "Loading your account details."
          : pendingHotelInvite
            ? "Your invitation already selected the hotel path."
            : "Choose your role so we can tailor your setup."
      }
      showProgress={false}
    >
      <div className="mx-auto w-full max-w-3xl">
        {loading ? (
          <div className="flex min-h-72 items-center justify-center">
            <p className="text-sm text-gray-600">Loading...</p>
          </div>
        ) : (
          <div className="space-y-5 text-center">
            <p className="mx-auto inline-flex items-center gap-2 rounded-full border border-primary-100 bg-primary-50 px-3 py-1.5 text-xs font-semibold text-primary-700">
              <CheckIcon className="h-4 w-4" aria-hidden="true" />
              Account created
            </p>

            <PathChoice
              selectedType={selectedType}
              hotelInvite={pendingHotelInvite}
              optionRefs={optionRefs}
              onSelect={(type) => {
                setError("");
                setSelectedType(type);
              }}
              onKeyDown={handleOptionKeyDown}
            />

            {error && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            )}

            <button
              type="button"
              onClick={handleContinue}
              disabled={submitting || !selectedType}
              className="mx-auto inline-flex items-center justify-center gap-2 rounded-full bg-primary-600 px-6 py-2.5 text-sm font-semibold text-white shadow-[0_14px_30px_-18px_rgba(37,99,235,0.8)] transition hover:-translate-y-0.5 hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
            >
              {submitting ? "Getting things ready..." : "Continue"}
              {!submitting && <ArrowRightIcon className="h-4 w-4" />}
            </button>
          </div>
        )}
      </div>
    </OnboardingShell>
  );
}

function PathChoice({
  selectedType,
  hotelInvite,
  optionRefs,
  onSelect,
  onKeyDown,
}: {
  selectedType: AccountType | null;
  hotelInvite: boolean;
  optionRefs: MutableRefObject<Array<HTMLButtonElement | null>>;
  onSelect: (type: AccountType) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, index: number) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Choose onboarding path"
      className="grid gap-4 sm:grid-cols-2"
    >
      {options.map((option, index) => {
        if (hotelInvite && option.type !== "hotel") return null;
        const selected = selectedType === option.type;
        const isHotel = option.type === "hotel";
        const tiltClass = selected ? "sm:rotate-0" : isHotel ? "sm:-rotate-2" : "sm:rotate-2";

        return (
          <button
            key={option.type}
            ref={(element) => {
              optionRefs.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected || (!selectedType && index === 0) ? 0 : -1}
            onClick={() => onSelect(option.type)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={`group relative rounded-2xl bg-white p-2.5 pb-4 text-left shadow-[0_22px_55px_-32px_rgba(15,23,42,0.5)] ring-1 transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-950 sm:hover:-translate-y-1 ${tiltClass} ${
              selected ? "ring-2 ring-primary-500" : "ring-gray-200 hover:ring-gray-300"
            }`}
          >
            <span className="relative block aspect-[16/10] overflow-hidden rounded-xl bg-gray-100">
              <Image
                src={option.image}
                alt=""
                fill
                priority={index < 2}
                sizes="(min-width: 640px) 360px, 100vw"
                className="object-cover transition duration-300 group-hover:scale-105"
              />
              <span className="absolute inset-0 bg-gradient-to-t from-gray-950/35 to-transparent" />
              <span className="absolute bottom-3 left-3 rounded-full bg-white/90 px-3 py-1 text-xs font-semibold text-gray-950 shadow-sm">
                {isHotel ? "For hotels" : "For creators"}
              </span>
              <span
                className={`absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-full ${
                  selected ? "bg-primary-600 text-white" : "bg-white/85 text-transparent"
                }`}
              >
                <CheckIcon className="h-4 w-4" />
              </span>
            </span>

            <span className="mt-3 flex items-start gap-3">
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                  selected ? "bg-primary-600 text-white" : "bg-gray-100 text-gray-600"
                }`}
              >
                {isHotel ? <HotelIcon className="h-4 w-4" /> : <UserIcon className="h-4 w-4" />}
              </span>
              <span>
                <span className="block text-base font-semibold text-gray-950">{option.title}</span>
                <span className="mt-1 block text-sm leading-5 text-gray-600">
                  {option.description}
                </span>
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function nextPathForType(type: AccountType): string {
  return type === "creator" ? ROUTES.PROFILE_COMPLETE : `${ROUTES.SETUP}?entryProduct=marketplace`;
}

async function loadSharedAccountDetailsStatus(
  type: AccountType,
  signal?: AbortSignal,
): Promise<{
  complete: boolean;
  existingCreatorPhoto?: SharedAccountProfileImageUpload;
}> {
  const user = authService.getSessionUser();
  if (type !== "creator") {
    return { complete: isSharedAccountDetailsComplete(user) };
  }

  const timeoutSignal = AbortSignal.timeout(ONBOARDING_REQUEST_TIMEOUT_MS);
  try {
    const profile = await creatorService.getMyProfile({
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
    });
    return {
      complete: hasRequiredCreatorAccountDetails(user, profile),
      ...(hasRequiredCreatorPhoto(profile)
        ? {
            existingCreatorPhoto: {
              profilePictureUrl: profile.profilePicture!.trim(),
              profilePictureMediaObjectId: profile.profilePictureMediaObjectId!.trim(),
            },
          }
        : {}),
    };
  } catch (error) {
    if (timeoutSignal.aborted && !signal?.aborted) {
      throw new Error("Loading your account details took too long. Please try again.");
    }
    throw error;
  }
}

function accountDetailsErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to load your account details.";
}
function SignupCompleteMoment({ type, onContinue }: { type: AccountType; onContinue: () => void }) {
  const isHotel = type === "hotel";
  return (
    <section aria-label="Profile ready" className="flex w-full flex-col items-center">
      <div aria-hidden="true" className="relative h-56 w-full max-w-lg">
        <div className="absolute inset-4 overflow-hidden rounded-[2rem] border-4 border-white bg-white shadow-[0_24px_55px_-28px_rgba(15,23,42,0.5)]">
          <Image
            src={isHotel ? "/hotel-hero.JPG" : "/creator-category-travel.jpg"}
            alt=""
            fill
            sizes="(min-width: 640px) 480px, 90vw"
            className={`object-cover ${isHotel ? "object-[center_70%]" : ""}`}
          />
          <span className="absolute inset-0 bg-gradient-to-t from-gray-950/55 via-gray-950/5 to-transparent" />
          <span className="absolute bottom-4 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-white/90 px-4 py-1.5 text-xs font-semibold text-gray-950 shadow-sm backdrop-blur-sm">
            {isHotel ? "Hotel account ready" : "Creator account ready"}
          </span>
        </div>

        <span className="absolute left-1/2 top-1/2 h-20 w-20 -translate-x-1/2 -translate-y-1/2">
          <span
            data-testid="signup-success-ring"
            className="absolute inset-0 rounded-full bg-primary-300 opacity-60 motion-safe:animate-ping"
            style={{ animationIterationCount: 2 }}
          />
          <span
            data-testid="signup-success-check"
            className="relative flex h-full w-full items-center justify-center rounded-full border-4 border-white bg-primary-600 text-white shadow-[0_18px_36px_-14px_rgba(37,99,235,0.9)] motion-safe:animate-bounce"
            style={{ animationIterationCount: 1 }}
          >
            <CheckIcon className="h-10 w-10" strokeWidth={2.5} />
          </span>
        </span>
      </div>

      <p
        id="signup-complete-message"
        className="mt-2 max-w-lg text-center text-sm leading-6 text-gray-600"
      >
        {isHotel
          ? "Your account details are saved. Next, let’s set up your first hotel."
          : "Your account details are saved. Next, let’s create the public creator profile hotels will see."}
      </p>

      <button
        type="button"
        autoFocus
        aria-describedby="signup-complete-message"
        onClick={onContinue}
        className="mt-6 inline-flex min-h-12 w-full max-w-xs items-center justify-center gap-2 rounded-full bg-primary-600 px-7 py-3 text-sm font-semibold text-white shadow-[0_16px_34px_-16px_rgba(37,99,235,0.9)] transition hover:-translate-y-0.5 hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"
      >
        {isHotel ? "Set up my first hotel" : "Create my public creator profile"}
        <ArrowRightIcon className="h-4 w-4" aria-hidden="true" />
      </button>
    </section>
  );
}
