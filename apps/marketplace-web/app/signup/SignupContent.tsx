"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { GoogleIcon } from "@/components/auth/GoogleIcon";
import { MARKETING_BASE_URL, ROUTES } from "@/lib/constants";
import { AuthStateError, authService, storePendingEmailVerification } from "@/services/auth";

type SignupIntent = "creator" | "hotel";

type SignupContentProps = {
  intent: SignupIntent | null;
  authError?: string;
};

export function SignupContent({ intent, authError }: SignupContentProps) {
  const router = useRouter();
  const [selectedIntent, setSelectedIntent] = useState<SignupIntent>(intent ?? "hotel");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitError, setSubmitError] = useState(authError ?? "");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const accountTypeDescription =
    selectedIntent === "hotel"
      ? "For properties managing bookings and creator partnerships."
      : "For creators applying to hotel collaborations.";
  const nextPath = selectedIntent === "hotel" ? ROUTES.SETUP : ROUTES.PROFILE_COMPLETE;
  const termsUrl = `${MARKETING_BASE_URL}${ROUTES.TERMS}`;
  const privacyUrl = `${MARKETING_BASE_URL}${ROUTES.PRIVACY}`;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError("");
    setIsSubmitting(true);
    try {
      await authService.signup({
        email,
        password,
        type: selectedIntent,
      });
      router.push(nextPath);
    } catch (error) {
      if (
        error instanceof AuthStateError &&
        error.state === "email_verification_required" &&
        storePendingEmailVerification({ ...error, type: selectedIntent })
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
                Choose how you want to join, then create your account.
              </p>
            </div>

            <div className="mb-5">
              <div className="grid grid-cols-2 rounded-lg border border-gray-200 bg-white p-1">
                <button
                  type="button"
                  aria-pressed={selectedIntent === "hotel"}
                  onClick={() => {
                    setSubmitError("");
                    setSelectedIntent("hotel");
                  }}
                  className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    selectedIntent === "hotel"
                      ? "bg-primary-600 text-white shadow-sm"
                      : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                  }`}
                >
                  Hotel / property
                </button>
                <button
                  type="button"
                  aria-pressed={selectedIntent === "creator"}
                  onClick={() => {
                    setSubmitError("");
                    setSelectedIntent("creator");
                  }}
                  className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    selectedIntent === "creator"
                      ? "bg-primary-600 text-white shadow-sm"
                      : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                  }`}
                >
                  Creator
                </button>
              </div>
              <p className="mt-2 text-center text-xs text-gray-500">{accountTypeDescription}</p>
            </div>

            <button
              type="button"
              onClick={() => authService.startGoogleSignup(selectedIntent, nextPath)}
              className="mb-5 flex w-full items-center justify-center gap-2 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-900 transition-colors hover:bg-gray-50"
            >
              <GoogleIcon className="h-4 w-4" />
              Continue with Google
            </button>
            <div className="mb-5 flex items-center gap-3 text-xs text-gray-400">
              <span className="h-px flex-1 bg-gray-200" />
              <span>or use email</span>
              <span className="h-px flex-1 bg-gray-200" />
            </div>
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-gray-700">
                  Email address
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  autoComplete="email"
                  className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <div>
                <label
                  htmlFor="password"
                  className="mb-1.5 block text-sm font-medium text-gray-700"
                >
                  Password
                </label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  autoComplete="new-password"
                  className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>

              {submitError && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {submitError}
                </div>
              )}

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full rounded-lg bg-primary-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSubmitting ? "Creating account..." : "Create account"}
              </button>
            </form>

            <p className="mt-5 text-center text-sm text-gray-600">
              Already have an account?{" "}
              <Link
                href={ROUTES.LOGIN}
                className="font-medium text-primary-600 hover:text-primary-700"
              >
                Sign in
              </Link>
            </p>
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
