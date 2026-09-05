"use client";

import { useEffect, useState, type FormEvent } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircleIcon, XCircleIcon } from "@heroicons/react/24/outline";
import { resolvePmsSetupGuard } from "@/lib/utils/sharedSetupGuard";
import {
  authService,
  clearPendingEmailVerification,
  getPendingEmailVerification,
  type PendingEmailVerification,
} from "@/services/auth";
import {
  isAuthOrganizationSelectionResponse,
  type AuthOrganizationSelectionResponse,
} from "@/services/auth/sessionStore";
import { useTranslation } from "@/lib/i18n";

export default function VerifyEmailPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const [pending, setPending] = useState<PendingEmailVerification | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [code, setCode] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [resendMessage, setResendMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [verified, setVerified] = useState(false);
  const [organizationSelection, setOrganizationSelection] =
    useState<AuthOrganizationSelectionResponse | null>(null);

  useEffect(() => {
    setPending(getPendingEmailVerification());
    setLoaded(true);
  }, []);

  async function redirectAfterVerifiedSession() {
    const decision = await resolvePmsSetupGuard("/dashboard");
    clearPendingEmailVerification();
    setVerified(true);
    setTimeout(() => {
      if (decision.action === "redirect_to_setup") {
        window.location.replace(decision.redirectPath);
        return;
      }
      router.push("/dashboard");
    }, 1200);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError("");
    setResendMessage("");
    if (!code.trim()) {
      setSubmitError(t("auth.verify.enterCode"));
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await authService.confirmEmailVerification(code.trim());
      if (isAuthOrganizationSelectionResponse(response)) {
        setOrganizationSelection(response);
        return;
      }
      await redirectAfterVerifiedSession();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t("auth.verify.failed"));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleOrganizationSelect(workosOrganizationId: string) {
    setSubmitError("");
    setResendMessage("");
    setIsSubmitting(true);
    try {
      const response = await authService.refreshSession(workosOrganizationId);
      if (isAuthOrganizationSelectionResponse(response)) {
        setOrganizationSelection(response);
        return;
      }
      await redirectAfterVerifiedSession();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t("auth.verify.failed"));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleResend() {
    setSubmitError("");
    setResendMessage("");
    setIsResending(true);
    try {
      const response = await authService.resendEmailVerification();
      setResendMessage(response.message);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t("auth.verify.resendFailed"));
    } finally {
      setIsResending(false);
    }
  }

  function handleBackToLogin() {
    clearPendingEmailVerification();
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
                className="mx-auto mb-4"
              />
              <h1 className="text-xl font-bold text-gray-900">
                {organizationSelection ? t("auth.verify.chooseWorkspace") : t("auth.verify.title")}
              </h1>
              <p className="mt-1 text-[13px] text-gray-500">
                {organizationSelection
                  ? t("auth.verify.chooseWorkspaceDescription")
                  : pending?.email
                    ? t("auth.verify.codeSentTo", { email: pending.email })
                    : t("auth.verify.enterCode")}
              </p>
            </div>

            {!loaded && <p className="text-center text-sm text-gray-600">{t("common.loading")}</p>}

            {loaded && !pending && (
              <div className="space-y-5 text-center">
                <div className="rounded-lg border border-red-200 bg-red-50 p-4">
                  <XCircleIcon className="mx-auto mb-3 h-10 w-10 text-red-600" />
                  <p className="text-sm font-medium text-red-700">{t("auth.verify.expired")}</p>
                </div>
                <Link
                  href="/login"
                  className="block rounded-lg bg-primary-600 px-4 py-2.5 text-center text-sm font-medium text-white transition-colors hover:bg-primary-700"
                >
                  {t("auth.password.backToSignIn")}
                </Link>
              </div>
            )}

            {loaded && pending && verified && (
              <div className="space-y-5 text-center">
                <div className="rounded-lg border border-green-200 bg-green-50 p-4">
                  <CheckCircleIcon className="mx-auto mb-3 h-10 w-10 text-green-600" />
                  <p className="text-sm font-medium text-green-700">{t("auth.verify.success")}</p>
                </div>
              </div>
            )}

            {loaded && pending && organizationSelection && !verified && (
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

            {loaded && pending && !verified && !organizationSelection && (
              <>
                <form onSubmit={handleSubmit} className="space-y-5">
                  <div>
                    <label
                      htmlFor="verification-code"
                      className="mb-1.5 block text-sm font-medium text-gray-700"
                    >
                      {t("auth.verify.codeLabel")}
                    </label>
                    <input
                      id="verification-code"
                      name="verification-code"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      value={code}
                      onChange={(event) => {
                        setCode(event.target.value);
                        if (submitError) setSubmitError("");
                      }}
                      disabled={isSubmitting}
                      className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-50"
                    />
                  </div>

                  {submitError && (
                    <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                      {submitError}
                    </div>
                  )}

                  {resendMessage && (
                    <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
                      {resendMessage}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="w-full rounded-lg bg-primary-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isSubmitting ? t("auth.verify.verifying") : t("auth.verify.button")}
                  </button>

                  <button
                    type="button"
                    onClick={handleResend}
                    disabled={isResending || !pending.emailVerificationId}
                    className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isResending ? t("auth.password.sending") : t("auth.verify.sendNewCode")}
                  </button>
                </form>

                <p className="mt-5 text-center text-sm text-gray-600">
                  {t("auth.verify.wrongEmail")}{" "}
                  <Link
                    href="/login"
                    onClick={handleBackToLogin}
                    className="font-medium text-primary-600 hover:text-primary-700"
                  >
                    {t("auth.password.backToSignIn")}
                  </Link>
                </p>
              </>
            )}
          </div>
        </div>
      </div>
      <div
        className="relative hidden min-h-screen flex-1 overflow-hidden bg-cover bg-center lg:block"
        style={{ backgroundImage: "url('/hotel-hero.JPG')" }}
        aria-hidden="true"
      >
        <div className="absolute inset-0 bg-gray-950/20" />
      </div>
    </div>
  );
}
