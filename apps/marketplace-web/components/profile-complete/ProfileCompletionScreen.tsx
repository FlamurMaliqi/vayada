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
      title={userType === "creator" ? "Start matching with hotels" : "Start matching with creators"}
      description={
        userType === "creator"
          ? "Your profile is ready for review before you apply to properties."
          : "Your offer is ready for review before creators can discover it."
      }
      showProgress={false}
    >
      <div className="mx-auto w-full max-w-3xl">
        <div className="rounded-3xl border border-gray-100 bg-white p-6 text-center shadow-[0_24px_80px_-50px_rgba(15,23,42,0.55)] sm:p-9">
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
            <CheckCircleIcon className="h-9 w-9" />
          </div>
          <h2 className="text-2xl font-semibold leading-tight text-gray-950">
            {userType === "creator" ? "Your profile is complete" : "Your offer is complete"}
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-gray-600">
            Thank you for completing your vayada {userType === "creator" ? "creator" : "hotel"}{" "}
            profile. We will review your submission and connect you with{" "}
            {userType === "creator" ? "high-quality hotels" : "talented creators"}.
          </p>

          {/* Email Confirmation Notice */}
          <div className="mt-7 rounded-2xl border border-primary-100 bg-primary-50/70 p-4 text-left">
            <div className="flex items-start gap-3">
              <EnvelopeIcon className="mt-0.5 h-5 w-5 flex-shrink-0 text-primary-600" />
              <div>
                <p className="mb-1 text-sm font-semibold text-gray-950">Check your email</p>
                <p className="mb-2 text-sm text-gray-700">
                  You should have received a confirmation email with details about your profile
                  submission and next steps.
                </p>
                <p className="mt-2 border-t border-primary-100 pt-2 text-xs leading-5 text-gray-600">
                  <strong>Email Verification:</strong> If your email is not yet verified, please
                  check your inbox for a verification link. Click the link to verify your email
                  address and activate your account. The link expires in 48 hours.
                </p>
              </div>
            </div>
          </div>

          <div className="mt-4 space-y-3 rounded-2xl border border-gray-100 bg-gray-50 p-4 text-left">
            <div className="flex items-center gap-2">
              <CheckCircleIcon className="h-5 w-5 text-primary-600" />
              <p className="text-sm font-semibold text-gray-950">Profile review</p>
            </div>
            <p className="text-sm text-gray-600">
              Your profile is now in review by the vayada team. This process ensures the quality and
              authenticity of our {userType === "creator" ? "creator" : "hotel partner"} network.
            </p>
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
            <div className="flex items-start gap-2 text-sm text-gray-700">
              <CheckCircleIcon className="mt-0.5 h-5 w-5 text-primary-600" />
              <p>
                <span className="font-semibold">Email Verification:</span> Make sure to verify your
                email address first. Your account must be verified before your profile can be fully
                activated.
              </p>
            </div>
          </div>

          <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-center">
            <Button
              type="button"
              variant="outline"
              className="justify-center rounded-full border-gray-200 px-6 font-semibold"
              onClick={onEditProfile}
            >
              Edit profile details
            </Button>
            <Button
              type="button"
              variant="primary"
              className="justify-center rounded-full px-6 font-semibold"
              onClick={onGoHome}
            >
              Open marketplace
            </Button>
          </div>

          <p className="mt-6 text-xs text-gray-500">
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
