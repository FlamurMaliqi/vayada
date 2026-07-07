"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import SharedSignupPage from "@vayada/product-onboarding/SharedSignupPage";
import { ROUTES } from "@/lib/constants";
import { AuthStateError, authService, storePendingEmailVerification } from "@/services/auth";

type SignupContentProps = {
  authError?: string;
};

export function SignupContent({ authError }: SignupContentProps) {
  const router = useRouter();
  const [submitError, setSubmitError] = useState(authError ?? "");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit({ email, password }: { email: string; password: string }) {
    setSubmitError("");
    setIsSubmitting(true);
    try {
      await authService.signup({
        email,
        password,
      });
      router.push(ROUTES.ONBOARDING);
    } catch (error) {
      if (
        error instanceof AuthStateError &&
        error.state === "email_verification_required" &&
        storePendingEmailVerification({ ...error, flow: "signup" })
      ) {
        router.push(ROUTES.VERIFY_EMAIL);
        return;
      }
      setSubmitError(error instanceof Error ? error.message : "Signup failed. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <SharedSignupPage
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      submitError={submitError}
      onErrorClear={() => setSubmitError("")}
      onGoogleSignup={() => authService.startGoogleSignup(ROUTES.ONBOARDING)}
    />
  );
}
