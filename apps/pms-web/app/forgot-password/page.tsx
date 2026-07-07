"use client";

import { useState } from "react";
import Image from "next/image";
import { authService } from "@/services/auth";

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEmailError("");
    if (!isValidEmail(email)) {
      setEmailError("Please enter a valid email address");
      return;
    }

    setIsSubmitting(true);
    try {
      await authService.forgotPassword(email);
    } finally {
      setIsSubmitting(false);
      setSent(true);
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
              <h1 className="text-xl font-bold text-gray-900">Forgot password?</h1>
              <p className="mt-1 text-[13px] text-gray-500">
                Enter your email and we will send you a reset link.
              </p>
            </div>

            {sent ? (
              <div className="space-y-5 text-center">
                <div className="rounded-lg border border-green-200 bg-green-50 p-4">
                  <p className="text-sm font-medium text-green-700">
                    If an account exists with that email, you will receive instructions shortly.
                  </p>
                </div>
                <a
                  href="/login"
                  className="inline-block w-full rounded-lg bg-primary-600 px-4 py-2.5 text-center text-sm font-medium text-white transition-colors hover:bg-primary-700"
                >
                  Back to Sign In
                </a>
                <button
                  type="button"
                  onClick={() => {
                    setEmail("");
                    setSent(false);
                  }}
                  className="text-sm font-medium text-primary-600 hover:text-primary-700"
                >
                  Try a different email
                </button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-5" noValidate>
                <div>
                  <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-gray-700">
                    Email address
                  </label>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    value={email}
                    onChange={(event) => {
                      setEmail(event.target.value);
                      if (emailError) setEmailError("");
                    }}
                    required
                    disabled={isSubmitting}
                    placeholder="admin@example.com"
                    autoComplete="email"
                    className={`w-full rounded-lg border px-4 py-2.5 text-sm text-gray-900 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-50 ${
                      emailError ? "border-red-300 ring-1 ring-red-300" : "border-gray-300"
                    }`}
                  />
                  {emailError && <p className="mt-1 text-sm text-red-600">{emailError}</p>}
                </div>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full rounded-lg bg-primary-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSubmitting ? "Sending..." : "Send Reset Link"}
                </button>
                <p className="text-center text-sm text-gray-600">
                  Remember your password?{" "}
                  <a href="/login" className="font-medium text-primary-600 hover:text-primary-700">
                    Sign in
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
