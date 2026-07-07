"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRightIcon,
  BuildingOfficeIcon,
  CheckCircleIcon,
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
  outcome: string;
  steps: string[];
}> = [
  {
    type: "hotel",
    title: "Hotel or property",
    description: "Create a creator-ready property listing and collaboration offer.",
    outcome: "Get discovered by creators who match your property.",
    steps: ["Add property basics", "Set the offer", "Invite creators"],
  },
  {
    type: "creator",
    title: "Creator",
    description: "Build a profile hotels can review before collaborating with you.",
    outcome: "Find properties looking for content partners.",
    steps: ["Pick your niche", "Add your profile", "Apply to properties"],
  },
];

export default function OnboardingPage() {
  const router = useRouter();
  const [selectedType, setSelectedType] = useState<AccountType>("hotel");
  const [loading, setLoading] = useState(true);
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

  return (
    <OnboardingShell
      currentStep={1}
      title="What do you want to create first?"
      description="We will shape the next steps around the first thing that gets you value in vayada."
    >
      <div className="max-w-2xl">
        <div className="mb-6">
          <p className="mb-2 text-xs font-semibold text-primary-600">Start your setup</p>
          <h2 className="text-3xl font-semibold leading-tight text-gray-950">Choose your path</h2>
          <p className="mt-3 text-sm leading-6 text-gray-600">
            Hotels create collaboration listings. Creators create profiles hotels can review.
          </p>
        </div>

        {loading ? (
          <p className="text-sm text-gray-600">Loading...</p>
        ) : (
          <div className="space-y-4">
            <div role="radiogroup" aria-label="Choose onboarding path" className="space-y-3">
              {options.map((option) => (
                <button
                  key={option.type}
                  type="button"
                  role="radio"
                  aria-checked={selectedType === option.type}
                  onClick={() => {
                    setError("");
                    setSelectedType(option.type);
                  }}
                  className={`w-full rounded-lg border bg-white p-4 text-left transition-colors ${
                    selectedType === option.type
                      ? "border-primary-600 shadow-sm"
                      : "border-gray-300 hover:border-gray-400"
                  }`}
                >
                  <span className="flex items-start gap-3">
                    <span
                      className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                        selectedType === option.type
                          ? "bg-primary-600 text-white"
                          : "bg-gray-100 text-gray-700"
                      }`}
                    >
                      {option.type === "hotel" ? (
                        <BuildingOfficeIcon className="h-5 w-5" />
                      ) : (
                        <SparklesIcon className="h-5 w-5" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-3">
                        <span className="text-sm font-semibold text-gray-950">{option.title}</span>
                        {selectedType === option.type && (
                          <CheckCircleIcon className="h-5 w-5 shrink-0 text-primary-600" />
                        )}
                      </span>
                      <span className="mt-1 block text-sm leading-5 text-gray-600">
                        {option.description}
                      </span>
                      <span className="mt-3 block text-xs font-medium text-gray-950">
                        {option.outcome}
                      </span>
                      <span className="mt-3 grid gap-1.5">
                        {option.steps.map((step) => (
                          <span
                            key={step}
                            className="flex items-center gap-1.5 text-xs font-medium text-gray-600"
                          >
                            <CheckCircleIcon className="h-3.5 w-3.5 text-primary-600" />
                            {step}
                          </span>
                        ))}
                      </span>
                    </span>
                  </span>
                </button>
              ))}
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
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "Continuing..." : "Continue setup"}
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
