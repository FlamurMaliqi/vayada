"use client";

import { Suspense, useEffect, useState } from "react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { EyeIcon, EyeSlashIcon } from "@heroicons/react/24/outline";
import { authService } from "@/services/auth";
import { useTranslation } from "@/lib/i18n";

function ResetPasswordContent() {
  const { t } = useTranslation();
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [confirmPasswordError, setConfirmPasswordError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  useEffect(() => {
    if (!isSuccess) return;
    const timer = window.setTimeout(() => router.push("/login"), 3000);
    return () => window.clearTimeout(timer);
  }, [isSuccess, router]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError("");
    setPasswordError("");
    setConfirmPasswordError("");

    if (password.length < 8) {
      setPasswordError(t("auth.register.passwordMinLength"));
      return;
    }
    if (password !== confirmPassword) {
      setConfirmPasswordError(t("auth.register.passwordsMismatch"));
      return;
    }

    setIsSubmitting(true);
    try {
      await authService.resetPassword(token, password);
      setIsSuccess(true);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t("auth.password.resetError"));
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
              />
              <h1 className="text-xl font-bold text-gray-900">{t("auth.password.resetTitle")}</h1>
              <p className="mt-1 text-[13px] text-gray-500">
                {t("auth.password.resetDescription")}
              </p>
            </div>

            {!token ? (
              <div className="space-y-5 text-center">
                <div className="rounded-lg border border-red-200 bg-red-50 p-4">
                  <p className="text-sm font-medium text-red-700">
                    {t("auth.password.invalidToken")}
                  </p>
                </div>
                <a
                  href="/forgot-password"
                  className="inline-block w-full rounded-lg bg-primary-600 px-4 py-2.5 text-center text-sm font-medium text-white transition-colors hover:bg-primary-700"
                >
                  {t("auth.password.requestNewLink")}
                </a>
              </div>
            ) : isSuccess ? (
              <div className="space-y-5 text-center">
                <div className="rounded-lg border border-green-200 bg-green-50 p-4">
                  <p className="text-sm font-medium text-green-700">
                    {t("auth.password.resetSuccess")}
                  </p>
                </div>
                <a
                  href="/login"
                  className="inline-block w-full rounded-lg bg-primary-600 px-4 py-2.5 text-center text-sm font-medium text-white transition-colors hover:bg-primary-700"
                >
                  {t("auth.password.backToSignIn")}
                </a>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-5">
                <div>
                  <label
                    htmlFor="password"
                    className="mb-1.5 block text-sm font-medium text-gray-700"
                  >
                    {t("auth.password.newPassword")}
                  </label>
                  <div className="relative">
                    <input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(event) => {
                        setPassword(event.target.value);
                        if (passwordError) setPasswordError("");
                      }}
                      required
                      placeholder={t("auth.register.passwordPlaceholder")}
                      autoComplete="new-password"
                      className={`w-full rounded-lg border px-4 py-2.5 pr-12 text-sm text-gray-900 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500 ${
                        passwordError ? "border-red-300 ring-1 ring-red-300" : "border-gray-300"
                      }`}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700"
                      aria-label={showPassword ? t("auth.password.hide") : t("auth.password.show")}
                    >
                      {showPassword ? (
                        <EyeSlashIcon className="h-5 w-5" />
                      ) : (
                        <EyeIcon className="h-5 w-5" />
                      )}
                    </button>
                  </div>
                  {passwordError && <p className="mt-1 text-sm text-red-600">{passwordError}</p>}
                </div>
                <div>
                  <label
                    htmlFor="confirmPassword"
                    className="mb-1.5 block text-sm font-medium text-gray-700"
                  >
                    {t("auth.register.confirmPasswordLabel")}
                  </label>
                  <div className="relative">
                    <input
                      id="confirmPassword"
                      type={showConfirmPassword ? "text" : "password"}
                      value={confirmPassword}
                      onChange={(event) => {
                        setConfirmPassword(event.target.value);
                        if (confirmPasswordError) setConfirmPasswordError("");
                      }}
                      required
                      placeholder={t("auth.register.confirmPasswordPlaceholder")}
                      autoComplete="new-password"
                      className={`w-full rounded-lg border px-4 py-2.5 pr-12 text-sm text-gray-900 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500 ${
                        confirmPasswordError
                          ? "border-red-300 ring-1 ring-red-300"
                          : "border-gray-300"
                      }`}
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700"
                      aria-label={
                        showConfirmPassword ? t("auth.password.hide") : t("auth.password.show")
                      }
                    >
                      {showConfirmPassword ? (
                        <EyeSlashIcon className="h-5 w-5" />
                      ) : (
                        <EyeIcon className="h-5 w-5" />
                      )}
                    </button>
                  </div>
                  {confirmPasswordError && (
                    <p className="mt-1 text-sm text-red-600">{confirmPasswordError}</p>
                  )}
                </div>
                {submitError && (
                  <div className="rounded-lg border-2 border-red-300 bg-red-50 p-4">
                    <p className="text-sm font-semibold text-red-800">{submitError}</p>
                  </div>
                )}
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full rounded-lg bg-primary-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSubmitting ? t("auth.password.resetting") : t("auth.password.resetButton")}
                </button>
                <p className="text-center text-sm text-gray-600">
                  {t("auth.password.rememberPassword")}{" "}
                  <a href="/login" className="font-medium text-primary-600 hover:text-primary-700">
                    {t("auth.register.signIn")}
                  </a>
                </p>
              </form>
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

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-50" />}>
      <ResetPasswordContent />
    </Suspense>
  );
}
