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
import { CREATOR_PROFILE_PHOTO_REQUIRED, ROUTES } from "@/lib/constants";
import { authService } from "@/services/auth";
import { creatorService } from "@/services/api/creators";
import { sharedAccountProfileImageUploader } from "@/services/api/sharedHotelSetupClient";

type AccountType = "hotel" | "creator";

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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const authenticated = await authService.ensureSession();
        if (cancelled) return;
        if (!authenticated) {
          router.replace(ROUTES.LOGIN);
          return;
        }
        const userType = authService.getUserType();
        if (userType === "creator" || userType === "hotel") {
          if (isSharedAccountDetailsComplete(authService.getSessionUser()?.name)) {
            router.replace(nextPathForType(userType));
            return;
          }
          setSelectedType(userType);
          setProvisionedType(userType);
          setWelcomeComplete(true);
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
    };
  }, [router]);

  useEffect(() => {
    if (loading || error || provisionedType) return;

    const user = authService.getSessionUser();
    const storageKey = `vayada:onboarding-welcome:${user?.id ?? user?.email ?? "current"}`;
    try {
      if (window.sessionStorage.getItem(storageKey) === "complete") {
        setWelcomeComplete(true);
      }
    } catch {
      // The welcome remains available when browser storage is unavailable.
    }
  }, [error, loading, provisionedType]);

  useEffect(() => {
    if (welcomeComplete && !loading && !provisionedType) optionRefs.current[0]?.focus();
  }, [loading, provisionedType, welcomeComplete]);

  function handleWelcomeContinue() {
    const user = authService.getSessionUser();
    const storageKey = `vayada:onboarding-welcome:${user?.id ?? user?.email ?? "current"}`;
    try {
      window.sessionStorage.setItem(storageKey, "complete");
    } catch {
      // The in-memory state is enough for the current page.
    }
    setWelcomeComplete(true);
  }

  async function handleContinue() {
    if (!selectedType) return;
    setError("");
    setSubmitting(true);
    try {
      await authService.completeOnboarding(selectedType);
      if (isSharedAccountDetailsComplete(authService.getSessionUser()?.name)) {
        router.push(nextPathForType(selectedType));
        return;
      }
      setProvisionedType(selectedType);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to continue onboarding.");
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

  const showSignupWelcome = !welcomeComplete && !error;

  if (!loading && provisionedType) {
    const user = authService.getSessionUser();
    return (
      <SharedAccountDetailsStep
        accountType={provisionedType}
        requireProfileImage={CREATOR_PROFILE_PHOTO_REQUIRED}
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
      title={showSignupWelcome ? "Thank you for signing up" : "Which best describes you?"}
      description={
        showSignupWelcome
          ? "Welcome to Vayada — we’re glad you’re here. Let’s get you set up."
          : "Choose your role so we can tailor your setup."
      }
      showProgress={false}
    >
      <div className={`mx-auto w-full ${showSignupWelcome ? "max-w-5xl" : "max-w-3xl"}`}>
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

function SignupWelcomeMoment({ onContinue }: { onContinue: () => void }) {
  const nextSteps = [
    "Choose your path",
    "Tell us a little about you",
    "Set up your first hotel or creator profile",
  ];

  return (
    <section
      aria-labelledby="signup-welcome-title"
      className="mx-auto w-full overflow-hidden rounded-[2rem] bg-white text-left shadow-[0_32px_90px_-42px_rgba(15,23,42,0.55)] ring-1 ring-gray-200/80"
    >
      <div className="grid md:grid-cols-[1.05fr_0.95fr]">
        <div className="relative isolate order-2 min-h-[340px] overflow-hidden bg-gradient-to-br from-[#1737c7] via-primary-600 to-[#7067e8] px-7 py-8 text-white sm:px-9 md:order-1 md:min-h-[410px]">
          <span
            aria-hidden="true"
            className="absolute -left-20 -top-24 h-64 w-64 rounded-full bg-white/10 blur-2xl"
          />
          <span
            aria-hidden="true"
            className="absolute -bottom-24 -right-16 h-72 w-72 rounded-full bg-cyan-300/20 blur-3xl"
          />

          <div className="relative z-10 max-w-md">
            <p className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-semibold tracking-wide text-white/95 backdrop-blur-sm">
              <CheckIcon className="h-4 w-4" aria-hidden="true" />
              Welcome to Vayada
            </p>
            <p className="mt-5 text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">
              Your next chapter in hospitality starts here.
            </p>
            <p className="mt-3 max-w-sm text-sm leading-6 text-white/90">
              Connect, collaborate, and grow with hotels and creators who share your ambition.
            </p>
          </div>

          <div className="relative z-10 mt-7 h-40 sm:h-44" aria-hidden="true">
            <div className="absolute bottom-0 left-0 h-36 w-[54%] -rotate-3 overflow-hidden rounded-2xl border-4 border-white/90 bg-white shadow-2xl sm:h-40">
              <Image
                src="/hotel-hero.JPG"
                alt=""
                fill
                priority
                sizes="(min-width: 768px) 260px, 45vw"
                className="object-cover object-[center_75%]"
              />
              <span className="absolute inset-0 bg-gradient-to-t from-gray-950/55 via-transparent to-transparent" />
              <span className="absolute bottom-2.5 left-3 text-xs font-semibold text-white">
                Hotels
              </span>
            </div>
            <div className="absolute bottom-1 right-0 h-32 w-[58%] rotate-3 overflow-hidden rounded-2xl border-4 border-white/90 bg-white shadow-2xl sm:h-36">
              <Image
                src="/creator-category-travel.jpg"
                alt=""
                fill
                priority
                sizes="(min-width: 768px) 280px, 48vw"
                className="object-cover"
              />
              <span className="absolute inset-0 bg-gradient-to-t from-gray-950/55 via-transparent to-transparent" />
              <span className="absolute bottom-2.5 left-3 text-xs font-semibold text-white">
                Creators
              </span>
            </div>
          </div>
        </div>

        <div className="order-1 flex flex-col justify-center px-7 py-8 sm:px-10 sm:py-10 md:order-2">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary-50 text-primary-700 ring-1 ring-primary-100">
            <CheckIcon className="h-5 w-5" aria-hidden="true" />
          </span>
          <p className="mt-5 text-xs font-semibold uppercase tracking-[0.16em] text-primary-700">
            Account created
          </p>
          <h2 id="signup-welcome-title" className="mt-2 text-2xl font-semibold text-gray-950">
            Your account is ready
          </h2>
          <p className="mt-2 text-sm leading-6 text-gray-600">
            We’ll start with your profile and guide you through the rest.
          </p>

          <div className="mt-6 rounded-2xl bg-gray-50 px-4 py-4 ring-1 ring-gray-100">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-500">
              What happens next
            </p>
            <ol className="mt-3 space-y-3">
              {nextSteps.map((step, index) => (
                <li
                  key={step}
                  className="flex items-center gap-3 text-sm font-medium text-gray-800"
                >
                  <span
                    aria-hidden="true"
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white text-xs font-semibold text-primary-700 shadow-sm ring-1 ring-primary-100"
                  >
                    {index + 1}
                  </span>
                  {step}
                </li>
              ))}
            </ol>
          </div>

          <button
            type="button"
            onClick={onContinue}
            className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary-600 px-6 py-3 text-sm font-semibold text-white shadow-[0_16px_34px_-16px_rgba(37,99,235,0.9)] transition hover:-translate-y-0.5 hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"
          >
            Let’s get you set up
            <ArrowRightIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </section>
  );
}
