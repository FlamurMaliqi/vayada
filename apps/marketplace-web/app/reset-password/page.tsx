"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { ROUTES } from "@/lib/constants/routes";
import { authService } from "@/services/auth";
import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import ResetPasswordForm from "@/components/auth/ResetPasswordForm";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [submitError, setSubmitError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleResetPassword = async (token: string, password: string) => {
    setSubmitError("");
    setIsSubmitting(true);

    try {
      await authService.resetPassword(token, password);
    } catch (error) {
      setIsSubmitting(false);

      if (error instanceof Error) {
        setSubmitError(error.message);
      } else {
        setSubmitError("Something went wrong. Please try again or request a new reset link.");
      }

      throw error;
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen bg-white">
      <div className="relative flex w-full items-center justify-center p-8 lg:w-[40%]">
        <Link
          href={ROUTES.HOME}
          className="absolute top-6 left-6 flex items-center gap-2 text-gray-600 hover:text-primary-600 transition-colors"
        >
          <ArrowLeftIcon className="w-5 h-5" />
          <span className="text-sm font-medium">Back to Home</span>
        </Link>

        <div className="w-full max-w-md">
          <div className="mb-6">
            <Image
              src="/vayada-logo.png"
              alt="vayada"
              width={120}
              height={40}
              className="mb-4 h-10 w-auto"
              priority
            />
          </div>

          <h1 className="text-4xl font-bold text-gray-900 mb-2">Reset password</h1>
          <p className="text-gray-600 mb-8">
            Enter your new password below. Make sure it&apos;s strong and secure.
          </p>

          <ResetPasswordForm
            onSubmit={handleResetPassword}
            isSubmitting={isSubmitting}
            submitError={submitError}
            onErrorClear={() => setSubmitError("")}
            loginHref={ROUTES.LOGIN}
            forgotPasswordHref={ROUTES.FORGOT_PASSWORD}
            onSuccess={() => router.push(ROUTES.LOGIN)}
          />
        </div>
      </div>

      <div className="relative hidden min-h-screen flex-1 overflow-hidden bg-gray-900 lg:block">
        <Image
          src="/hotel-hero.JPG"
          alt=""
          fill
          sizes="60vw"
          className="object-cover"
          aria-hidden="true"
        />
        <div className="absolute inset-0 bg-gray-950/20" />
      </div>
    </div>
  );
}
