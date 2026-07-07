"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { GoogleIcon } from "@/components/auth/GoogleIcon";
import LoginForm from "@/components/auth/LoginForm";
import { MARKETING_BASE_URL, ROUTES } from "@/lib/constants";
import { AuthStateError, authService, storePendingEmailVerification } from "@/services/auth";

type SignupContentProps = {
  authError?: string;
};

export function SignupContent({ authError }: SignupContentProps) {
  const router = useRouter();
  const [submitError, setSubmitError] = useState(authError ?? "");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const termsUrl = `${MARKETING_BASE_URL}${ROUTES.TERMS}`;
  const privacyUrl = `${MARKETING_BASE_URL}${ROUTES.PRIVACY}`;

  async function handleSubmit(email: string, password: string) {
    setSubmitError("");
    setIsSubmitting(true);
    try {
      await authService.signup({
        email,
        password,
      });
      router.push(ROUTES.ONBOARDING);
    } catch (error) {
      if (
        error instanceof AuthStateError &&
        error.state === "email_verification_required" &&
        storePendingEmailVerification({ ...error, flow: "signup" })
      ) {
        router.push(ROUTES.VERIFY_EMAIL);
        return;
      }
      setSubmitError(error instanceof Error ? error.message : "Signup failed. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen bg-gray-50">
      <div className="flex min-h-screen w-full flex-col px-4 lg:w-[40%]">
        <div className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-sm">
            <div className="mb-6 text-center">
              <Image
                src="/vayada-logo.png"
                alt="vayada"
                width={120}
                height={40}
                className="mx-auto mb-4 h-10 w-auto"
                priority
              />
              <h1 className="text-xl font-bold text-gray-900">Create your vayada account</h1>
              <p className="mt-1 text-[13px] text-gray-500">
                Use your email and password to continue.
              </p>
            </div>

            <button
              type="button"
              onClick={() => authService.startGoogleSignup(ROUTES.ONBOARDING)}
              className="mb-5 flex w-full items-center justify-center gap-2 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-900 transition-colors hover:bg-gray-50"
            >
              <GoogleIcon className="h-4 w-4" />
              Continue with Google
            </button>
            <div className="mb-5 flex items-center gap-3 text-xs text-gray-400">
              <span className="h-px flex-1 bg-gray-200" />
              <span>or</span>
              <span className="h-px flex-1 bg-gray-200" />
            </div>
            <LoginForm
              onSubmit={handleSubmit}
              isSubmitting={isSubmitting}
              submitError={submitError}
              onErrorClear={() => setSubmitError("")}
              showForgotPassword={false}
              registerHref={ROUTES.LOGIN}
              registerLabel="Sign in"
              registerPrompt="Already have an account?"
              passwordAutoComplete="new-password"
              submitLabel="Create account"
              submittingLabel="Creating account..."
            />
          </div>
        </div>
        <p className="pb-8 text-center text-xs leading-5 text-gray-500">
          By continuing, you agree to our{" "}
          <Link href={termsUrl} className="font-medium text-primary-600 hover:text-primary-700">
            Terms
          </Link>{" "}
          and acknowledge our{" "}
          <Link href={privacyUrl} className="font-medium text-primary-600 hover:text-primary-700">
            Privacy Policy
          </Link>
          .
        </p>
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
