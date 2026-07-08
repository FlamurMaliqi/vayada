"use client";

import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  ArrowRightIcon,
  BuildingOfficeIcon,
  CheckIcon,
  SparklesIcon,
} from "@heroicons/react/24/outline";
import { OnboardingShell } from "@/components/onboarding/OnboardingShell";
import { ROUTES } from "@/lib/constants";
import { authService } from "@/services/auth";

type AccountType = "hotel" | "creator";

const options: Array<{
  type: AccountType;
  title: string;
  description: string;
  image: string;
}> = [
  {
    type: "hotel",
    title: "List a property",
    description: "Create a creator-ready listing for your hotel, stay, or venue.",
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
          router.replace(nextPathForType(userType));
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
    if (loading || error) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setIntroComplete(true);
      return;
    }
    const timer = window.setTimeout(() => setIntroComplete(true), 1200);
    return () => window.clearTimeout(timer);
  }, [error, loading]);

  async function handleContinue() {
    setError("");
    setSubmitting(true);
    try {
      await authService.completeOnboarding(selectedType);
      router.push(nextPathForType(selectedType));
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

  return (
    <OnboardingShell
      currentStep={1}
      title="Welcome to Vayada"
      description="First things first, tell us a little bit about yourself."
    >
      <div className="mx-auto w-full max-w-3xl">
        {loading ? (
          <div className="flex min-h-72 items-center justify-center">
            <p className="text-sm text-gray-600">Loading...</p>
          </div>
        ) : !introComplete && !error ? (
          <WelcomeMoment />
        ) : (
          <div className="space-y-6 text-center">
            <div
              role="radiogroup"
              aria-label="Choose onboarding path"
              className="grid gap-5 sm:grid-cols-2"
            >
              {options.map((option, index) => {
                const selected = selectedType === option.type;
                const isHotel = option.type === "hotel";
                const tiltClass = selected
                  ? "sm:rotate-0"
                  : isHotel
                    ? "sm:-rotate-2"
                    : "sm:rotate-2";

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
                    onClick={() => {
                      setError("");
                      setSelectedType(option.type);
                    }}
                    onKeyDown={(event) => handleOptionKeyDown(event, index)}
                    className={`group relative rounded-3xl bg-white p-3 pb-5 text-left shadow-[0_22px_55px_-32px_rgba(15,23,42,0.5)] ring-1 transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-950 sm:hover:-translate-y-1 ${tiltClass} ${
                      selected ? "ring-2 ring-primary-500" : "ring-gray-200 hover:ring-gray-300"
                    }`}
                  >
                    <span className="relative block aspect-[4/3] overflow-hidden rounded-2xl bg-gray-100">
                      <Image
                        src={option.image}
                        alt=""
                        fill
                        sizes="(min-width: 640px) 360px, 100vw"
                        className="object-cover transition duration-300 group-hover:scale-105"
                      />
                      <span className="absolute inset-0 bg-gradient-to-t from-gray-950/35 to-transparent" />
                      <span className="absolute bottom-3 left-3 rounded-full bg-white/90 px-3 py-1 text-xs font-semibold text-gray-950 shadow-sm">
                        {isHotel ? "For properties" : "For creators"}
                      </span>
                      <span
                        className={`absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-full ${
                          selected ? "bg-primary-600 text-white" : "bg-white/85 text-transparent"
                        }`}
                      >
                        <CheckIcon className="h-4 w-4" />
                      </span>
                    </span>

                    <span className="mt-4 flex items-start gap-3">
                      <span
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                          selected ? "bg-primary-600 text-white" : "bg-gray-100 text-gray-600"
                        }`}
                      >
                        {isHotel ? (
                          <BuildingOfficeIcon className="h-5 w-5" />
                        ) : (
                          <SparklesIcon className="h-5 w-5" />
                        )}
                      </span>
                      <span>
                        <span className="block text-base font-semibold text-gray-950">
                          {option.title}
                        </span>
                        <span className="mt-1 block text-sm leading-6 text-gray-600">
                          {option.description}
                        </span>
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>

            {error && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            )}

            <button
              type="button"
              onClick={handleContinue}
              disabled={submitting}
              aria-label={`Continue to ${
                selectedType === "hotel" ? "property setup" : "creator profile"
              }`}
              className="mx-auto inline-flex items-center justify-center gap-2 rounded-full bg-primary-600 px-6 py-3 text-sm font-semibold text-white shadow-[0_14px_30px_-18px_rgba(37,99,235,0.8)] transition hover:-translate-y-0.5 hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
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

function nextPathForType(type: AccountType): string {
  return type === "hotel" ? ROUTES.SETUP : ROUTES.PROFILE_COMPLETE;
}

function WelcomeMoment() {
  return (
    <div className="flex min-h-72 flex-col items-center justify-center text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gray-950 text-white">
        <SparklesIcon className="h-7 w-7" />
      </div>
      <div className="mt-6">
        <p className="text-sm font-semibold text-primary-600">You are in</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-normal text-gray-950">
          Thanks for choosing Vayada.
        </h2>
        <p className="mt-3 text-sm text-gray-600">Setting up your first step.</p>
        <div className="mt-7 flex justify-center gap-2" aria-hidden="true">
          <span className="h-2 w-2 animate-pulse rounded-full bg-gray-950" />
          <span className="h-2 w-2 animate-pulse rounded-full bg-gray-400 [animation-delay:150ms]" />
          <span className="h-2 w-2 animate-pulse rounded-full bg-gray-300 [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  );
}
