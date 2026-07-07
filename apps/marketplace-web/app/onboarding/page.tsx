"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ROUTES } from "@/lib/constants";
import { authService } from "@/services/auth";

type AccountType = "hotel" | "creator";

const options: Array<{
  type: AccountType;
  title: string;
  description: string;
}> = [
  {
    type: "hotel",
    title: "Hotel / property",
    description: "Set up a property workspace for bookings and creator collaborations.",
  },
  {
    type: "creator",
    title: "Creator",
    description: "Set up a creator workspace for hotel collaborations.",
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
    <div className="flex min-h-screen bg-gray-50">
      <div className="flex min-h-screen w-full flex-col px-4 lg:w-[40%]">
        <main className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-sm">
            <div className="mb-7 text-center">
              <Image
                src="/vayada-logo.png"
                alt="vayada"
                width={120}
                height={40}
                className="mx-auto mb-4 h-10 w-auto"
                priority
              />
              <h1 className="text-xl font-bold text-gray-900">Set up your workspace</h1>
              <p className="mt-1 text-[13px] text-gray-500">Tell us how you want to use vayada.</p>
            </div>

            {loading ? (
              <p className="text-center text-sm text-gray-600">Loading...</p>
            ) : (
              <div className="space-y-5">
                <div className="space-y-3">
                  {options.map((option) => (
                    <button
                      key={option.type}
                      type="button"
                      aria-pressed={selectedType === option.type}
                      onClick={() => {
                        setError("");
                        setSelectedType(option.type);
                      }}
                      className={`w-full rounded-lg border px-4 py-3 text-left transition-colors ${
                        selectedType === option.type
                          ? "border-primary-600 bg-primary-50"
                          : "border-gray-300 bg-white hover:bg-gray-50"
                      }`}
                    >
                      <span className="block text-sm font-semibold text-gray-900">
                        {option.title}
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-gray-500">
                        {option.description}
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
                  className="w-full rounded-lg bg-primary-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting ? "Continuing..." : "Continue"}
                </button>
              </div>
            )}
          </div>
        </main>
      </div>
      <div className="relative hidden min-h-screen flex-1 overflow-hidden bg-gray-900 lg:block">
        <Image
          src="/hotel-hero.JPG"
          alt=""
          fill
          sizes="50vw"
          className="object-cover"
          aria-hidden="true"
        />
        <div className="absolute inset-0 bg-gray-950/20" />
      </div>
    </div>
  );
}

function nextPathForType(type: AccountType): string {
  return type === "hotel" ? ROUTES.SETUP : ROUTES.PROFILE_COMPLETE;
}
