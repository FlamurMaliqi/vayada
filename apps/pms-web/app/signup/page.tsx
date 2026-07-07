"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import SharedHotelSignupPage from "@vayada/hotel-setup-wizard/SharedHotelSignupPage";
import { useTranslation } from "@/lib/i18n";
import { resolvePmsSetupGuard } from "@/lib/utils/sharedSetupGuard";
import { authService } from "@/services/auth";

export default function SignupPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const [submitError, setSubmitError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSignup(data: { email: string; password: string }) {
    setSubmitError("");
    setIsSubmitting(true);
    try {
      await authService.signup(data);
      const decision = await resolvePmsSetupGuard("/dashboard");
      localStorage.setItem(
        "pmsSetupComplete",
        decision.action === "enter_product" ? "true" : "false",
      );
      router.push(decision.action === "enter_product" ? "/dashboard" : decision.redirectPath);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t("auth.register.unexpectedError"));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <SharedHotelSignupPage
      onSubmit={handleSignup}
      isSubmitting={isSubmitting}
      submitError={submitError}
      onErrorClear={() => setSubmitError("")}
    />
  );
}
