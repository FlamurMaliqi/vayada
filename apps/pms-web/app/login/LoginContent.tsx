"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import SharedHotelLoginForm from "@vayada/product-onboarding/SharedHotelLoginForm";
import { authService } from "@/services/auth";
import {
  isAuthOrganizationSelectionResponse,
  type AuthOrganizationSelectionResponse,
} from "@/services/auth/sessionStore";
import { resolvePmsSetupGuard } from "@/lib/utils/sharedSetupGuard";
import { useTranslation } from "@/lib/i18n";

type LoginContentProps = {
  returnTo?: string;
  resumeSession?: boolean;
  authError?: string;
};

export function LoginContent({
  returnTo = "/dashboard",
  resumeSession = false,
  authError,
}: LoginContentProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitError, setSubmitError] = useState(authError ?? "");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [organizationSelection, setOrganizationSelection] =
    useState<AuthOrganizationSelectionResponse | null>(null);

  const redirectAfterLogin = useCallback(async () => {
    const decision = await resolvePmsSetupGuard(returnTo);
    localStorage.setItem(
      "pmsSetupComplete",
      decision.action === "enter_product" ? "true" : "false",
    );
    router.push(decision.action === "enter_product" ? returnTo : decision.redirectPath);
  }, [returnTo, router]);

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
        setSubmitError(error instanceof Error ? error.message : t("auth.login.unexpectedError"));
      } finally {
        setIsSubmitting(false);
      }
    },
    [redirectAfterLogin, t],
  );

  const handleLogin = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
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
        setSubmitError(error instanceof Error ? error.message : t("auth.login.unexpectedError"));
      } finally {
        setIsSubmitting(false);
      }
    },
    [email, password, redirectAfterLogin, t],
  );

  useEffect(() => {
    if (!resumeSession) return;
    let cancelled = false;
    setIsSubmitting(true);
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
        setSubmitError(error instanceof Error ? error.message : t("auth.login.unexpectedError"));
      })
      .finally(() => {
        if (!cancelled) {
          setIsSubmitting(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [redirectAfterLogin, resumeSession, t]);

  return (
    <SharedHotelLoginForm
      copy={{
        title: "Sign in to vayada",
        subtitle: "Use your email and password to continue.",
        chooseOrganizationTitle: t("auth.login.chooseHotelGroup"),
        chooseOrganizationSubtitle: t("auth.login.chooseHotelGroupSubtitle"),
        emailLabel: t("auth.login.emailLabel"),
        passwordLabel: t("auth.login.passwordLabel"),
        forgotPassword: t("auth.login.forgotPassword"),
        googleLogin: "Continue with Google",
        or: "or",
        submitLabel: t("auth.login.submitButton"),
        submittingLabel: t("auth.login.submitting"),
        noAccount: t("auth.login.noAccount"),
        signUp: t("auth.login.signUp"),
      }}
      email={email}
      password={password}
      isSubmitting={isSubmitting}
      submitError={submitError}
      organizations={organizationSelection?.organizations ?? null}
      forgotPasswordHref="/forgot-password"
      onEmailChange={setEmail}
      onPasswordChange={setPassword}
      onSubmit={handleLogin}
      onGoogleLogin={() => authService.startGoogleLogin(returnTo)}
      onOrganizationSelect={handleOrganizationSelect}
    />
  );
}
