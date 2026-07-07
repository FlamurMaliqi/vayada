"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import SharedSignupPage from "@vayada/product-onboarding/SharedSignupPage";
import { useTranslation } from "@/lib/i18n";
import { resolvePmsSetupGuard } from "@/lib/utils/sharedSetupGuard";
import { AuthStateError, authService, storePendingEmailVerification } from "@/services/auth";

export default function SignupPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const [submitError, setSubmitError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    setSubmitError(new URLSearchParams(window.location.search).get("auth_error") ?? "");
  }, []);

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
      if (
        error instanceof AuthStateError &&
        error.state === "email_verification_required" &&
        storePendingEmailVerification({ ...error, flow: "signup", intent: "hotel" })
      ) {
        router.push("/verify-email");
        return;
      }
      setSubmitError(error instanceof Error ? error.message : t("auth.register.unexpectedError"));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <SharedSignupPage
      onSubmit={handleSignup}
      isSubmitting={isSubmitting}
      submitError={submitError}
      onErrorClear={() => setSubmitError("")}
      onGoogleSignup={() => authService.startGoogleSignup("/dashboard")}
    />
  );
}
