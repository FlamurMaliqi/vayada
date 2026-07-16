"use client";

import { type KeyboardEvent, type MutableRefObject, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ArrowRightIcon, CheckIcon, UserIcon } from "@heroicons/react/24/outline";
import {
  HotelIcon,
  SharedAccountDetailsStep,
  isSharedAccountDetailsComplete,
} from "@vayada/product-onboarding";
import { OnboardingShell } from "@/components/onboarding/OnboardingShell";
import { ROUTES } from "@/lib/constants";
import { authService } from "@/services/auth";
import { creatorService } from "@/services/api/creators";
import { sharedAccountProfileImageUploader } from "@/services/api/sharedHotelSetupClient";

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
  const [provisionedType, setProvisionedType] = useState<AccountType | null>(null);
  const [loading, setLoading] = useState(true);
  const [welcomeComplete, setWelcomeComplete] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [creatorPhotoRequired, setCreatorPhotoRequired] = useState<boolean | null>(null);
  const [sessionConfirmed, setSessionConfirmed] = useState(false);
  const [sessionAttempt, setSessionAttempt] = useState(0);

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
        const userType = authService.getUserType();
        if (userType === "creator" || userType === "hotel") {
          setProvisionedType(userType);
          if (isSharedAccountDetailsComplete(authService.getSessionUser()?.name)) {
            router.replace(nextPathForType(userType));
            return;
          }
          const photoRequired = await creatorPhotoRequirement(userType, requestController.signal);
          if (cancelled) return;
          setCreatorPhotoRequired(photoRequired);
          setLoading(false);
          return;
        }
        try {
          setWelcomeComplete(
            window.sessionStorage.getItem(onboardingWelcomeStorageKey()) === "complete",
          );
        } catch {
          // The welcome remains available when browser storage is unavailable.
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

  useEffect(() => {
    if (welcomeComplete && !loading && !provisionedType) optionRefs.current[0]?.focus();
  }, [loading, provisionedType, welcomeComplete]);

  function handleWelcomeContinue() {
    try {
      window.sessionStorage.setItem(onboardingWelcomeStorageKey(), "complete");
    } catch {
      // The in-memory state is enough for the current page.
    }
    setWelcomeComplete(true);
  }

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
      await authService.completeOnboarding(selectedType);
      const canonicalType = authService.getUserType();
      if (canonicalType !== "creator" && canonicalType !== "hotel") {
        throw new Error("Your account role could not be confirmed. Please sign in again.");
      }
      setProvisionedType(canonicalType);
      if (isSharedAccountDetailsComplete(authService.getSessionUser()?.name)) {
        router.push(nextPathForType(canonicalType));
        return;
      }
      setCreatorPhotoRequired(await creatorPhotoRequirement(canonicalType));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to continue onboarding.");
    } finally {
      setSubmitting(false);
    }
  }

  async function retryCreatorPhotoRequirement() {
    if (provisionedType !== "creator") return;
    setError("");
    setSubmitting(true);
    try {
      setCreatorPhotoRequired(await creatorPhotoRequirement(provisionedType));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to load creator requirements.");
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

  const showSignupWelcome = !loading && !welcomeComplete && !error;

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

  if (!loading && provisionedType === "creator" && creatorPhotoRequired === null) {
    return (
      <OnboardingShell
        currentStep={1}
        title="Finish setting up your creator profile"
        description="We need the current creator profile requirements before continuing."
        showProgress={false}
      >
        <div className="mx-auto max-w-xl rounded-2xl border border-gray-200 bg-white p-6 text-center shadow-sm">
          {error ? (
            <p role="alert" className="text-sm text-red-700">
              {error}
            </p>
          ) : (
            <p className="text-sm text-gray-600">Loading creator profile requirements…</p>
          )}
          {error && (
            <button
              type="button"
              onClick={() => void retryCreatorPhotoRequirement()}
              disabled={submitting}
              className="mt-5 rounded-xl bg-primary-600 px-5 py-3 text-sm font-semibold text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? "Retrying…" : "Retry creator requirements"}
            </button>
          )}
        </div>
      </OnboardingShell>
    );
  }

  if (!loading && provisionedType) {
    const user = authService.getSessionUser();
    return (
      <SharedAccountDetailsStep
        accountType={provisionedType}
        requireProfileImage={creatorPhotoRequired === true}
        email={user?.email ?? ""}
        initialName={user?.name}
        initialPhone={user?.phone}
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
              !currentProfile.profilePicture?.trim() &&
              !currentProfile.profilePictureMediaObjectId &&
              Boolean(accountDetails.profilePictureMediaObjectId);
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
          router.push(nextPathForType(provisionedType));
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
          : showSignupWelcome
            ? "Thank you for signing up"
            : "Which best describes you?"
      }
      description={
        loading
          ? "Loading your account details."
          : showSignupWelcome
            ? "Welcome to Vayada — where independent hotels and creators connect, build trusted partnerships, and grow together."
            : "Choose your role so we can tailor your setup."
      }
      showProgress={false}
    >
      <div className={`mx-auto w-full ${showSignupWelcome ? "max-w-4xl" : "max-w-3xl"}`}>
        {loading ? (
          <div className="flex min-h-72 items-center justify-center">
            <p className="text-sm text-gray-600">Loading...</p>
          </div>
        ) : showSignupWelcome ? (
          <SignupWelcomeMoment onContinue={handleWelcomeContinue} />
        ) : (
          <div className="space-y-5 text-center">
            <PathChoice
              selectedType={selectedType}
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
  optionRefs,
  onSelect,
  onKeyDown,
}: {
  selectedType: AccountType | null;
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

async function creatorPhotoRequirement(type: AccountType, signal?: AbortSignal): Promise<boolean> {
  if (type !== "creator") return false;
  const timeoutSignal = AbortSignal.timeout(ONBOARDING_REQUEST_TIMEOUT_MS);
  try {
    return (
      await creatorService.getProfileStatus({
        signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      })
    ).profile_photo_required;
  } catch (error) {
    if (timeoutSignal.aborted && !signal?.aborted) {
      throw new Error("Loading the creator photo requirement took too long. Please try again.");
    }
    throw error;
  }
}

function onboardingWelcomeStorageKey(): string {
  const user = authService.getSessionUser();
  return `vayada:onboarding-welcome:${user?.id ?? user?.email ?? "current"}`;
}

function SignupWelcomeMoment({ onContinue }: { onContinue: () => void }) {
  return (
    <section aria-label="Welcome to Vayada" className="flex w-full flex-col items-center">
      <div aria-hidden="true" className="relative h-56 w-full max-w-3xl sm:h-72">
        <div className="absolute inset-x-5 bottom-0 top-5 rounded-[2.5rem] bg-gradient-to-r from-primary-50 via-white to-violet-50 sm:inset-x-14" />
        <div className="absolute left-[8%] top-[4%] h-3 w-3 rounded-full bg-primary-300 sm:left-[13%] sm:h-4 sm:w-4" />
        <div className="absolute right-[8%] top-[12%] h-5 w-5 rounded-full border-2 border-violet-200 sm:right-[14%]" />

        <div className="absolute bottom-3 left-[2%] h-[78%] w-[55%] -rotate-3 overflow-hidden rounded-[1.6rem] border-4 border-white bg-white shadow-[0_24px_55px_-28px_rgba(15,23,42,0.5)] sm:bottom-4 sm:left-[5%] sm:w-[51%] sm:rounded-[2rem]">
          <Image
            src="/hotel-hero.JPG"
            alt=""
            fill
            priority
            sizes="(min-width: 640px) 390px, 55vw"
            className="object-cover object-[center_70%]"
          />
          <span className="absolute inset-0 bg-gradient-to-t from-gray-950/50 via-transparent to-transparent" />
          <span className="absolute bottom-3 left-3 rounded-full bg-white/90 px-3 py-1 text-xs font-semibold text-gray-950 shadow-sm backdrop-blur-sm sm:bottom-4 sm:left-4">
            Independent hotels
          </span>
        </div>

        <div className="absolute right-[2%] top-3 h-[76%] w-[55%] rotate-3 overflow-hidden rounded-[1.6rem] border-4 border-white bg-white shadow-[0_24px_55px_-28px_rgba(15,23,42,0.5)] sm:right-[5%] sm:top-4 sm:w-[51%] sm:rounded-[2rem]">
          <Image
            src="/creator-category-travel.jpg"
            alt=""
            fill
            priority
            sizes="(min-width: 640px) 390px, 55vw"
            className="object-cover"
          />
          <span className="absolute inset-0 bg-gradient-to-t from-gray-950/50 via-transparent to-transparent" />
          <span className="absolute bottom-3 right-3 rounded-full bg-white/90 px-3 py-1 text-xs font-semibold text-gray-950 shadow-sm backdrop-blur-sm sm:bottom-4 sm:right-4">
            Creators
          </span>
        </div>

        <span className="absolute left-1/2 top-1/2 flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-4 border-white bg-white shadow-[0_14px_30px_-12px_rgba(37,99,235,0.55)] sm:h-16 sm:w-16">
          <Image src="/vayada-logo.png" alt="" width={30} height={30} className="h-7 w-auto" />
        </span>
      </div>

      <button
        type="button"
        onClick={onContinue}
        className="mt-8 inline-flex min-h-12 w-full max-w-xs items-center justify-center gap-2 rounded-full bg-primary-600 px-7 py-3 text-sm font-semibold text-white shadow-[0_16px_34px_-16px_rgba(37,99,235,0.9)] transition hover:-translate-y-0.5 hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 sm:mt-9"
      >
        Continue to Vayada
        <ArrowRightIcon className="h-4 w-4" aria-hidden="true" />
      </button>
    </section>
  );
}
