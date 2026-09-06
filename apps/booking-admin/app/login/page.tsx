"use client";

import { Suspense, useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import SharedHotelLoginForm from "@vayada/product-onboarding/SharedHotelLoginForm";
import { safeRelativeReturnTo } from "@vayada/product-onboarding/returnTo";
import { authService } from "@/services/auth";
import {
  isAuthOrganizationSelectionResponse,
  type AuthOrganizationSelectionResponse,
} from "@/services/auth/sessionStore";
import { resolveBookingSetupGuard } from "@/lib/utils/sharedSetupGuard";
import { useTranslation } from "@/lib/i18n";

function LoginContent() {
  const { t } = useTranslation();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitError, setSubmitError] = useState(
    searchParams.get("auth_error") ??
      (searchParams.get("expired") === "true" ? t("auth.login.errorSessionExpired") : ""),
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [organizationSelection, setOrganizationSelection] =
    useState<AuthOrganizationSelectionResponse | null>(null);
  const returnTo = safeRelativeReturnTo(searchParams.get("returnTo"), "/dashboard");

  const redirectAfterLogin = useCallback(async () => {
    if (new URL(returnTo, "https://vayada.local").pathname === "/handoff") {
      router.replace(returnTo);
      return;
    }
    const decision = await resolveBookingSetupGuard(returnTo);
    if (decision.action === "redirect_to_setup") {
      window.location.replace(decision.redirectPath);
      return;
    }
    router.push(returnTo);
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
      } catch {
        setSubmitError(t("auth.login.errorUnexpected"));
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
      } catch {
        setSubmitError(t("auth.login.errorUnexpected"));
      } finally {
        setIsSubmitting(false);
      }
    },
    [email, password, redirectAfterLogin, t],
  );

  useEffect(() => {
    if (searchParams.get("auth") !== "callback" || !authService.isAuthKitEnabled()) return;
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
      .catch(() => {
        if (cancelled) return;
        setSubmitError(t("auth.login.errorUnexpected"));
      })
      .finally(() => {
        if (!cancelled) {
          setIsSubmitting(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [redirectAfterLogin, returnTo, searchParams, t]);

  return (
    <SharedHotelLoginForm
      copy={{
        showPasswordLabel: t("admin.showPassword"),
        hidePasswordLabel: t("admin.hidePassword"),
        legalPrefix: t("admin.byContinuingYouAgreeToOur"),
        termsLabel: t("admin.termsOfService"),
        legalConnector: t("admin.and"),
        privacyLabel: t("admin.privacyPolicy"),

        title: t("admin.signInToVayada"),
        subtitle: t("admin.useYourEmailAndPasswordToContinue"),
        chooseOrganizationTitle: t("auth.login.chooseHotelGroup"),
        chooseOrganizationSubtitle: t("auth.login.chooseHotelGroupSubtitle"),
        emailLabel: t("auth.login.emailLabel"),
        passwordLabel: t("auth.login.passwordLabel"),
        forgotPassword: t("auth.login.forgotPassword"),
        googleLogin: t("admin.continueWithGoogle"),
        or: t("setup.welcome.or"),
        submitLabel: t("auth.login.submit"),
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

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-50" />}>
      <LoginContent />
    </Suspense>
  );
}
