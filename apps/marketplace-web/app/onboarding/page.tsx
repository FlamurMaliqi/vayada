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
import { sharedAccountProfileImageUploader } from "@/services/api/sharedHotelSetupClient";

type AccountType = "hotel" | "creator";

const SIGNUP_WELCOME_DURATION_MS = 1800;

const options: Array<{
  type: AccountType;
  title: string;
  description: string;
  image: string;
}> = [
  {
    type: "hotel",
    title: "Manage a hotel",
    description: "Set up one hotel or manage several from the same account.",
    image: "/hotel-hero.JPG",
  },
  {
    type: "creator",
    title: "Create a creator profile",
    description: "Build a profile hotels can review before working with you.",
    image: "/creator-hero.jpg",
  },
];

export default function OnboardingPage() {
  const router = useRouter();
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [selectedType, setSelectedType] = useState<AccountType>("hotel");
  const [provisionedType, setProvisionedType] = useState<AccountType | null>(null);
  const [loading, setLoading] = useState(true);
  const [introComplete, setIntroComplete] = useState(false);
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
          setIntroComplete(true);
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
    let storedState: string | null = null;

    try {
      storedState = window.sessionStorage.getItem(storageKey);
    } catch {
      // The transition still works when browser storage is unavailable.
    }

    const finishIntro = () => {
      try {
        window.sessionStorage.setItem(storageKey, "complete");
      } catch {
        // The in-memory state is enough for the current page.
      }
      setIntroComplete(true);
    };

    if (
      storedState === "complete" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      finishIntro();
      return;
    }

    const storedDeadline = Number(storedState);
    const deadline =
      Number.isFinite(storedDeadline) && storedDeadline > 0
        ? storedDeadline
        : Date.now() + SIGNUP_WELCOME_DURATION_MS;

    if (storedState === null || !Number.isFinite(storedDeadline) || storedDeadline <= 0) {
      try {
        window.sessionStorage.setItem(storageKey, String(deadline));
      } catch {
        // The timer below remains the fallback.
      }
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      finishIntro();
      return;
    }

    const timer = window.setTimeout(finishIntro, remaining);
    return () => window.clearTimeout(timer);
  }, [error, loading, provisionedType]);

  async function handleContinue() {
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

  const showSignupWelcome = !introComplete && !error;

  if (!loading && provisionedType) {
    const user = authService.getSessionUser();
    return (
      <SharedAccountDetailsStep
        email={user?.email ?? ""}
        initialName={user?.name}
        initialPhone={user?.phone}
        onUploadProfileImage={(file) => {
          if (!user?.id) throw new Error("Your session has expired. Please sign in again.");
          return sharedAccountProfileImageUploader(user.id, file);
        }}
        onSubmit={async (accountDetails) => {
          await authService.updateAccountDetails(accountDetails);
          router.push(nextPathForType(provisionedType));
        }}
      />
    );
  }

  return (
    <OnboardingShell
      currentStep={1}
      title={showSignupWelcome ? "Thank you for signing up to Vayada" : "Welcome to Vayada"}
      description={
        showSignupWelcome
          ? "Let's set up your profile in a little more detail."
          : "Choose how you want to use Vayada."
      }
      showProgress={false}
    >
      <div className="mx-auto w-full max-w-3xl">
        {loading ? (
          <div className="flex min-h-72 items-center justify-center">
            <p className="text-sm text-gray-600">Loading...</p>
          </div>
        ) : showSignupWelcome ? (
          <SignupWelcomeMoment />
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
              disabled={submitting}
              aria-label={
                selectedType === "hotel" ? "Continue to hotel setup" : "Continue to creator profile"
              }
              className="mx-auto inline-flex items-center justify-center gap-2 rounded-full bg-primary-600 px-6 py-2.5 text-sm font-semibold text-white shadow-[0_14px_30px_-18px_rgba(37,99,235,0.8)] transition hover:-translate-y-0.5 hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
            >
              {submitting ? "Continuing..." : "Continue"}
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
  selectedType: AccountType;
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
            tabIndex={selected ? 0 : -1}
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

function SignupWelcomeMoment() {
  return (
    <div className="mx-auto flex min-h-48 w-full max-w-sm flex-col items-center justify-center rounded-2xl bg-white px-6 py-8 text-center shadow-[0_22px_55px_-32px_rgba(15,23,42,0.45)] ring-1 ring-gray-200">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-600 text-white">
        <CheckIcon className="h-6 w-6" />
      </span>
      <p className="mt-4 text-base font-semibold text-gray-950">Your account is ready</p>
      <p className="mt-2 text-sm text-gray-600">Preparing your setup...</p>
      <div className="mt-4 flex justify-center gap-2" aria-hidden="true">
        <span className="h-2 w-2 animate-pulse rounded-full bg-primary-600" />
        <span className="h-2 w-2 animate-pulse rounded-full bg-primary-300 [animation-delay:150ms]" />
        <span className="h-2 w-2 animate-pulse rounded-full bg-primary-200 [animation-delay:300ms]" />
      </div>
    </div>
  );
}
