"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import SharedSignupPage from "@vayada/product-onboarding/SharedSignupPage";
import { useTranslation } from "@/lib/i18n";
import { resolveBookingSetupGuard } from "@/lib/utils/sharedSetupGuard";
import { authService } from "@/services/auth";

export default function SignupPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const [submitError, setSubmitError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("auth_error"))
      setSubmitError(t("auth.register.errorUnexpected"));
  }, [t]);

  async function handleSignup(data: { email: string; password: string }) {
    setSubmitError("");
    setIsSubmitting(true);
    try {
      await authService.signup(data);
      const decision = await resolveBookingSetupGuard("/dashboard");
      if (decision.action === "redirect_to_setup") {
        window.location.replace(decision.redirectPath);
        return;
      }
      router.push("/dashboard");
    } catch {
      setSubmitError(t("auth.register.errorUnexpected"));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <SharedSignupPage
      translate={t}
      onSubmit={handleSignup}
      isSubmitting={isSubmitting}
      submitError={submitError}
      onErrorClear={() => setSubmitError("")}
      onGoogleSignup={() => authService.startGoogleSignup("/dashboard")}
    />
  );
}
