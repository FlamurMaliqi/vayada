"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { GoogleIcon } from "@/components/auth/GoogleIcon";
import LoginForm from "@/components/auth/LoginForm";
import { MARKETING_BASE_URL, ROUTES } from "@/lib/constants";
import { getMarketplacePostLoginRedirect } from "@/lib/utils/postLoginRedirect";
import { AuthStateError, authService, storePendingEmailVerification } from "@/services/auth";
import {
  isAuthOrganizationSelectionResponse,
  type AuthOrganizationSelectionResponse,
} from "@/services/auth/sessionStore";

type LoginContentProps = {
  returnTo?: string;
  resumeSession?: boolean;
  authError?: string;
};

export function LoginContent({
  returnTo = ROUTES.MARKETPLACE,
  resumeSession = false,
  authError,
}: LoginContentProps) {
  const router = useRouter();
  const [submitError, setSubmitError] = useState(authError ?? "");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const [organizationSelection, setOrganizationSelection] =
    useState<AuthOrganizationSelectionResponse | null>(null);

  const redirectAfterLogin = useCallback(async () => {
    const destination = await getMarketplacePostLoginRedirect(returnTo);
    if (new URL(destination, "https://vayada.local").pathname === "/handoff") {
      router.replace(destination);
      return;
    }
    router.push(destination);
  }, [returnTo, router]);

  const handleLogin = useCallback(
    async (email: string, password: string) => {
      setSubmitError("");
      setIsSubmitting(true);
      try {
        const response = await authService.login({ email, password });
        if (isAuthOrganizationSelectionResponse(response)) {
          setOrganizationSelection(response);
          return;
        }
        await redirectAfterLogin();
      } catch (error) {
        if (
          error instanceof AuthStateError &&
          error.state === "email_verification_required" &&
          storePendingEmailVerification(error)
        ) {
          router.push(ROUTES.VERIFY_EMAIL);
          return;
        }
        setSubmitError(error instanceof Error ? error.message : "Login failed. Please try again.");
      } finally {
        setIsSubmitting(false);
      }
    },
    [redirectAfterLogin, router],
  );

  const handleOrganizationSelect = useCallback(
    async (workosOrganizationId: string) => {
      setSubmitError("");
      setIsSubmitting(true);
      try {
        const response = await authService.refreshSession(workosOrganizationId);
        if (isAuthOrganizationSelectionResponse(response)) {
          setOrganizationSelection(response);
          return;
        }
        await redirectAfterLogin();
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : "Login failed. Please try again.");
      } finally {
        setIsSubmitting(false);
      }
    },
    [redirectAfterLogin],
  );

  useEffect(() => {
    if (!resumeSession) return;
    let cancelled = false;
    setSubmitError("");
    setIsResuming(true);
    authService
      .refreshSession()
      .then(async (response) => {
        if (cancelled) return;
        if (isAuthOrganizationSelectionResponse(response)) {
          setOrganizationSelection(response);
          return;
        }
        await redirectAfterLogin();
      })
      .catch((error) => {
        if (cancelled) return;
        setSubmitError(error instanceof Error ? error.message : "Login failed. Please try again.");
      })
      .finally(() => {
        if (!cancelled) {
          setIsResuming(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [redirectAfterLogin, resumeSession]);

  const isResumingSession = resumeSession && isResuming && !organizationSelection && !submitError;
  const termsUrl = `${MARKETING_BASE_URL}${ROUTES.TERMS}`;
  const privacyUrl = `${MARKETING_BASE_URL}${ROUTES.PRIVACY}`;

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
              <h1 className="text-xl font-bold text-gray-900">
                {organizationSelection
                  ? "Choose workspace"
                  : isResumingSession
                    ? "Signing you in"
                    : "Sign in to vayada"}
              </h1>
              <p className="text-[13px] text-gray-500 mt-1">
                {organizationSelection
                  ? "Select where you want to continue."
                  : isResumingSession
                    ? "Finishing secure sign in..."
                    : "Use your email and password to continue."}
              </p>
            </div>

            {organizationSelection && (
              <div className="mb-5 space-y-2">
                {organizationSelection.organizations.map((organization) => (
                  <button
                    key={organization.workosOrganizationId}
                    type="button"
                    onClick={() => handleOrganizationSelect(organization.workosOrganizationId)}
                    disabled={isSubmitting}
                    className="w-full rounded-lg border border-gray-200 px-4 py-3 text-left text-sm font-medium text-gray-900 transition-colors hover:border-primary-300 hover:bg-primary-50 disabled:opacity-60"
                  >
                    {organization.displayName}
                  </button>
                ))}
                {submitError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {submitError}
                  </div>
                )}
              </div>
            )}

            {isResumingSession && (
              <p className="text-center text-sm text-gray-600">Please wait...</p>
            )}

            {!organizationSelection && !isResumingSession && (
              <>
                <button
                  type="button"
                  onClick={() => authService.startGoogleLogin(returnTo)}
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
                  onSubmit={handleLogin}
                  isSubmitting={isSubmitting}
                  submitError={submitError}
                  onErrorClear={() => setSubmitError("")}
                  registerHref={ROUTES.SIGNUP}
                  registerLabel="Create an account"
                />
              </>
            )}
          </div>
        </div>
        {!organizationSelection && !isResumingSession && (
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
        )}
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
