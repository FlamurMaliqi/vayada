"use client";

import { OnboardingShell } from "@/components/onboarding/OnboardingShell";
import { Button } from "@/components/ui";
import { CheckCircleIcon, EnvelopeIcon, ClockIcon } from "@heroicons/react/24/outline";
import type { ProfileCompletionScreenProps } from "./types";

export function ProfileCompletionScreen({
  userType,
  onGoHome,
  onEditProfile,
}: ProfileCompletionScreenProps) {
  return (
    <OnboardingShell
      currentStep={3}
      title={userType === "creator" ? "Your profile is complete" : "Your offer is complete"}
      description={
        userType === "creator"
          ? "We’ll review it and email you when you can start matching with hotels."
          : "We’ll review it and email you when creators can discover it."
      }
      compact
      centerContent
      showProgress={false}
    >
      <div className="mx-auto w-full max-w-3xl">
        <div className="rounded-3xl border border-gray-100 bg-white p-5 text-center shadow-[0_24px_80px_-50px_rgba(15,23,42,0.55)] sm:p-6">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
            <CheckCircleIcon className="h-7 w-7" />
          </div>

          <div className="rounded-2xl border border-primary-100 bg-primary-50/70 p-3 text-left">
            <div className="flex items-start gap-3">
              <EnvelopeIcon className="mt-0.5 h-5 w-5 flex-shrink-0 text-primary-600" />
              <div>
                <p className="mb-1 text-sm font-semibold text-gray-950">Verify your email</p>
                <p className="text-sm leading-5 text-gray-700">
                  Check your inbox for the verification link. It expires in 48 hours.
                </p>
              </div>
            </div>
          </div>

          <div className="mt-3 space-y-2 rounded-2xl border border-gray-100 bg-gray-50 p-3 text-left">
            <div className="flex items-center gap-2">
              <CheckCircleIcon className="h-5 w-5 text-primary-600" />
              <p className="text-sm font-semibold text-gray-950">Profile review</p>
            </div>
            <div className="flex items-start gap-2 text-sm text-gray-700">
              <ClockIcon className="mt-0.5 h-5 w-5 text-primary-600" />
              <p>
                <span className="font-semibold">Review Timeframe:</span> Up to 24 hours
              </p>
            </div>
            <div className="flex items-start gap-2 text-sm text-gray-700">
              <EnvelopeIcon className="mt-0.5 h-5 w-5 text-primary-600" />
              <p>
                You will receive an email notification once your profile has been accepted and{" "}
                {userType === "creator"
                  ? "you can start connecting with hotels"
                  : "your offers are live for creator matching"}
                .
              </p>
            </div>
          </div>

          <div className="mt-5 flex flex-col gap-3 sm:flex-row-reverse sm:justify-center">
            <Button
              type="button"
              variant="primary"
              className="justify-center rounded-full px-6 font-semibold"
              onClick={onGoHome}
            >
              Open marketplace
            </Button>
            <Button
              type="button"
              variant="outline"
              className="justify-center rounded-full border-gray-200 px-6 font-semibold"
              onClick={onEditProfile}
            >
              Edit profile details
            </Button>
          </div>

          <p className="mt-4 text-xs text-gray-500">
            Questions? Contact us at{" "}
            <a href="mailto:support@vayada.com" className="text-primary-600 hover:underline">
              support@vayada.com
            </a>
            .
          </p>
        </div>
      </div>
    </OnboardingShell>
  );
}
