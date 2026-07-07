"use client";

import { useState, type FormEvent } from "react";
import { EyeIcon, EyeSlashIcon } from "@heroicons/react/24/outline";

export type SharedHotelLoginOrganization = {
  workosOrganizationId: string;
  displayName: string;
};

export type SharedHotelLoginFormCopy = {
  title: string;
  subtitle: string;
  chooseOrganizationTitle: string;
  chooseOrganizationSubtitle: string;
  emailLabel: string;
  passwordLabel: string;
  submitLabel: string;
  submittingLabel: string;
  noAccount: string;
  signUp: string;
};

export type SharedHotelLoginFormProps = {
  copy: SharedHotelLoginFormCopy;
  email: string;
  password: string;
  isSubmitting: boolean;
  submitError: string;
  organizations?: SharedHotelLoginOrganization[] | null;
  signupHref?: string;
  termsUrl?: string;
  privacyUrl?: string;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onOrganizationSelect: (workosOrganizationId: string) => void;
};

const MARKETING_BASE_URL = process.env.NEXT_PUBLIC_MARKETING_URL || "https://vayada.com";

export default function SharedHotelLoginForm({
  copy,
  email,
  password,
  isSubmitting,
  submitError,
  organizations = null,
  signupHref = "/signup",
  termsUrl = `${MARKETING_BASE_URL}/terms`,
  privacyUrl = `${MARKETING_BASE_URL}/privacy`,
  onEmailChange,
  onPasswordChange,
  onSubmit,
  onOrganizationSelect,
}: SharedHotelLoginFormProps) {
  const [showPassword, setShowPassword] = useState(false);
  const choosingOrganization = organizations !== null;

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
              <h1 className="text-xl font-bold text-gray-900">
                {choosingOrganization ? copy.chooseOrganizationTitle : copy.title}
              </h1>
              <p className="mt-1 text-[13px] text-gray-500">
                {choosingOrganization ? copy.chooseOrganizationSubtitle : copy.subtitle}
              </p>
            </div>

            {choosingOrganization && (
              <div className="mb-5 space-y-2">
                {organizations.map((organization) => (
                  <button
                    key={organization.workosOrganizationId}
                    type="button"
                    onClick={() => onOrganizationSelect(organization.workosOrganizationId)}
                    disabled={isSubmitting}
                    className="w-full rounded-lg border border-gray-200 px-4 py-3 text-left text-sm font-medium text-gray-900 transition-colors hover:border-primary-300 hover:bg-primary-50 disabled:opacity-60"
                  >
                    {organization.displayName}
                  </button>
                ))}
              </div>
            )}

            {!choosingOrganization && (
              <form onSubmit={onSubmit} className="space-y-5">
                <div>
                  <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-gray-700">
                    {copy.emailLabel}
                  </label>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    value={email}
                    onChange={(event) => onEmailChange(event.target.value)}
                    required
                    placeholder="admin@example.com"
                    autoComplete="email"
                    className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                </div>
                <div>
                  <label
                    htmlFor="password"
                    className="mb-1.5 block text-sm font-medium text-gray-700"
                  >
                    {copy.passwordLabel}
                  </label>
                  <div className="relative">
                    <input
                      id="password"
                      name="password"
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(event) => onPasswordChange(event.target.value)}
                      required
                      placeholder="Enter your password"
                      autoComplete="current-password"
                      className="w-full rounded-lg border border-gray-300 px-4 py-2.5 pr-12 text-sm text-gray-900 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500"
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
                </div>
                {submitError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 p-4">
                    <p className="text-sm font-medium text-red-800">{submitError}</p>
                  </div>
                )}
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full rounded-lg bg-primary-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-700 disabled:opacity-60"
                >
                  {isSubmitting ? copy.submittingLabel : copy.submitLabel}
                </button>
                <p className="text-center text-sm text-gray-600">
                  {copy.noAccount}{" "}
                  <a
                    href={signupHref}
                    className="font-medium text-primary-600 hover:text-primary-700"
                  >
                    {copy.signUp}
                  </a>
                </p>
              </form>
            )}

            {choosingOrganization && submitError && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-4">
                <p className="text-sm font-medium text-red-800">{submitError}</p>
              </div>
            )}
          </div>
        </div>
        {!choosingOrganization && (
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
        )}
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
