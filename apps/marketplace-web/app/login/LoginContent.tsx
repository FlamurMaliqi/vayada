"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import LoginForm from "@/components/auth/LoginForm";
import { ROUTES } from "@/lib/constants";
import { getMarketplacePostLoginRedirect } from "@/lib/utils/postLoginRedirect";
import { AuthStateError, authService, storePendingEmailVerification } from "@/services/auth";
import {
  isAuthOrganizationSelectionResponse,
  type AuthOrganizationSelectionResponse,
} from "@/services/auth/sessionStore";

type LoginContentProps = {
  returnTo?: string;
  resumeSession?: boolean;
};

export function LoginContent({
  returnTo = ROUTES.MARKETPLACE,
  resumeSession = false,
}: LoginContentProps) {
  const router = useRouter();
  const [submitError, setSubmitError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const [organizationSelection, setOrganizationSelection] =
    useState<AuthOrganizationSelectionResponse | null>(null);

  const redirectAfterLogin = useCallback(async () => {
    router.push(await getMarketplacePostLoginRedirect(returnTo));
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

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm bg-white rounded-lg shadow-lg p-8">
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

        {isResumingSession && <p className="text-center text-sm text-gray-600">Please wait...</p>}

        {!organizationSelection && !isResumingSession && (
          <LoginForm
            onSubmit={handleLogin}
            isSubmitting={isSubmitting}
            submitError={submitError}
            onErrorClear={() => setSubmitError("")}
            showRegister={false}
          />
        )}
      </div>
    </div>
  );
}
