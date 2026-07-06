"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import RegisterForm from "@/components/auth/RegisterForm";
import { useTranslation } from "@/lib/i18n";
import { resolveBookingSetupGuard } from "@/lib/utils/sharedSetupGuard";
import { authService } from "@/services/auth";

export default function SignupPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const [submitError, setSubmitError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSignup(data: { name: string; email: string; password: string }) {
    setSubmitError("");
    setIsSubmitting(true);
    try {
      await authService.signup(data);
      const decision = await resolveBookingSetupGuard("/dashboard");
      localStorage.setItem("setupComplete", decision.action === "enter_product" ? "true" : "false");
      router.push(decision.action === "enter_product" ? "/dashboard" : decision.redirectPath);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t("auth.register.errorUnexpected"));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm rounded-lg bg-white p-8 shadow-lg">
        <div className="mb-6 text-center">
          <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-primary-600">
            <span className="text-[16px] font-bold text-white">B</span>
          </div>
          <h1 className="text-xl font-bold text-gray-900">{t("auth.register.title")}</h1>
          <p className="mt-1 text-[13px] text-gray-500">{t("auth.register.subtitle")}</p>
        </div>
        <RegisterForm
          onSubmit={handleSignup}
          isSubmitting={isSubmitting}
          submitError={submitError}
          onErrorClear={() => setSubmitError("")}
        />
      </div>
    </div>
  );
}
