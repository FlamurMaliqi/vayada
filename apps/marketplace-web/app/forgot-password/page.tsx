"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { ROUTES } from "@/lib/constants/routes";
import { authService } from "@/services/auth";
import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import ForgotPasswordForm from "@/components/auth/ForgotPasswordForm";

export default function ForgotPasswordPage() {
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleForgotPassword = async (email: string) => {
    setIsSubmitting(true);
    try {
      await authService.forgotPassword(email);
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

          <h1 className="text-4xl font-bold text-gray-900 mb-2">Forgot password?</h1>
          <p className="text-gray-600 mb-8">
            No worries! Enter your email address and we&apos;ll send you a link to reset your
            password.
          </p>

          <ForgotPasswordForm
            onSubmit={handleForgotPassword}
            isSubmitting={isSubmitting}
            loginHref={ROUTES.LOGIN}
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
