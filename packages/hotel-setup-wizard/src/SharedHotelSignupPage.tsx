"use client";

import { useState } from "react";
import { EyeIcon, EyeSlashIcon } from "@heroicons/react/24/outline";

export type SharedHotelSignupPageProps = {
  isSubmitting: boolean;
  submitError: string;
  onErrorClear: () => void;
  onSubmit: (input: { email: string; password: string }) => Promise<void>;
  loginHref?: string;
  termsUrl?: string;
  privacyUrl?: string;
};

const MARKETING_BASE_URL = process.env.NEXT_PUBLIC_MARKETING_URL || "https://vayada.com";

export default function SharedHotelSignupPage({
  isSubmitting,
  submitError,
  onErrorClear,
  onSubmit,
  loginHref = "/login",
  termsUrl = `${MARKETING_BASE_URL}/terms`,
  privacyUrl = `${MARKETING_BASE_URL}/privacy`,
}: SharedHotelSignupPageProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [emailError, setEmailError] = useState("");
  const [passwordError, setPasswordError] = useState("");

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEmailError("");
    setPasswordError("");
    onErrorClear();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setEmailError("Please enter a valid email address");
      return;
    }
    if (!password) {
      setPasswordError("Password is required");
      return;
    }

    await onSubmit({ email, password });
  }

  return (
    <div className="flex min-h-screen bg-gray-50">
      <div className="flex min-h-screen w-full flex-col px-4 lg:w-[40%]">
        <div className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-sm">
            <div className="mb-6 text-center">
              <img
                src="/vayada-logo.png"
                alt="vayada"
                width={120}
                height={40}
                className="mx-auto mb-4 h-10 w-auto"
              />
              <h1 className="text-xl font-bold text-gray-900">Create your vayada account</h1>
              <p className="mt-1 text-[13px] text-gray-500">
                Use your email and password to continue.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5" noValidate>
              <div>
                <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-gray-700">
                  Email address
                </label>
                <input
                  id="email"
                  type="email"
                  name="email"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    if (emailError) setEmailError("");
                    onErrorClear();
                  }}
                  required
                  placeholder="admin@example.com"
                  autoComplete="email"
                  className={`w-full rounded-lg border px-4 py-2.5 text-sm text-gray-900 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500 ${
                    emailError ? "border-red-300 ring-1 ring-red-300" : "border-gray-300"
                  }`}
                />
                {emailError && <p className="mt-1 text-sm text-red-600">{emailError}</p>}
              </div>

              <div>
                <label
                  htmlFor="password"
                  className="mb-1.5 block text-sm font-medium text-gray-700"
                >
                  Password
                </label>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    name="password"
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      if (passwordError) setPasswordError("");
                      onErrorClear();
                    }}
                    required
                    placeholder="Enter your password"
                    autoComplete="new-password"
                    className={`w-full rounded-lg border px-4 py-2.5 pr-12 text-sm text-gray-900 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500 ${
                      passwordError ? "border-red-300 ring-1 ring-red-300" : "border-gray-300"
                    }`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700"
                    aria-label={showPassword ? "Hide password" : "Show password"}
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
                {isSubmitting ? "Creating account..." : "Create account"}
              </button>

              <div className="text-center">
                <p className="text-sm text-gray-600">
                  Already have an account?{" "}
                  <a
                    href={loginHref}
                    className="font-medium text-primary-600 hover:text-primary-700"
                  >
                    Sign in
                  </a>
                </p>
              </div>
            </form>
          </div>
        </div>
        <p className="pb-8 text-center text-xs leading-5 text-gray-500">
          By continuing, you agree to our{" "}
          <a href={termsUrl} className="font-medium text-primary-600 hover:text-primary-700">
            Terms
          </a>{" "}
          and acknowledge our{" "}
          <a href={privacyUrl} className="font-medium text-primary-600 hover:text-primary-700">
            Privacy Policy
          </a>
          .
        </p>
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
