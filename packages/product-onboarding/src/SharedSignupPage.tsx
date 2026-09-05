"use client";

import { useState } from "react";
import Image from "next/image";
import { EyeIcon, EyeSlashIcon } from "@heroicons/react/24/outline";

export type SharedSignupPageProps = {
  isSubmitting: boolean;
  submitError: string;
  onErrorClear: () => void;
  onSubmit: (input: { email: string; password: string }) => Promise<void>;
  loginHref?: string;
  termsUrl?: string;
  privacyUrl?: string;
  onGoogleSignup?: () => void;
};

const MARKETING_BASE_URL = process.env.NEXT_PUBLIC_MARKETING_URL || "https://vayada.com";
const PASSWORD_MIN_LENGTH = 10;

export default function SharedSignupPage({
  isSubmitting,
  submitError,
  onErrorClear,
  onSubmit,
  loginHref = "/login",
  termsUrl = `${MARKETING_BASE_URL}/terms`,
  privacyUrl = `${MARKETING_BASE_URL}/privacy`,
  onGoogleSignup,
}: SharedSignupPageProps) {
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
    if (password.length < PASSWORD_MIN_LENGTH) {
      setPasswordError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
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
              <Image
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

            {onGoogleSignup && (
              <>
                <button
                  type="button"
                  onClick={onGoogleSignup}
                  disabled={isSubmitting}
                  className="mb-5 flex w-full items-center justify-center gap-2 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-900 transition-colors hover:bg-gray-50 disabled:opacity-60"
                >
                  <GoogleIcon />
                  Continue with Google
                </button>
                <div className="mb-5 flex items-center gap-3 text-xs text-gray-400">
                  <span className="h-px flex-1 bg-gray-200" />
                  <span>or</span>
                  <span className="h-px flex-1 bg-gray-200" />
                </div>
              </>
            )}

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
                    minLength={PASSWORD_MIN_LENGTH}
                    aria-describedby={`password-requirements${passwordError ? " password-error" : ""}`}
                    aria-invalid={Boolean(passwordError)}
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
                {passwordError && (
                  <p id="password-error" role="alert" className="mt-1 text-sm text-red-600">
                    {passwordError}
                  </p>
                )}
                <div id="password-requirements" className="mt-2 text-xs leading-5 text-gray-500">
                  <p className="font-medium text-gray-700">Password requirements</p>
                  <ul className="list-disc pl-4">
                    <li>At least {PASSWORD_MIN_LENGTH} characters.</li>
                    <li>Hard to guess: avoid names, common passwords, and sequences like 12345.</li>
                    <li>Must not have appeared in a data breach.</li>
                  </ul>
                  <p className="mt-1">Try several unrelated words or use a password manager.</p>
                </div>
              </div>

              {submitError && (
                <div role="alert" className="rounded-lg border-2 border-red-300 bg-red-50 p-4">
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

function GoogleIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72A5.4 5.4 0 0 1 3.69 9c0-.6.1-1.18.28-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.05l3.01-2.33z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  );
}
