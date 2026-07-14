"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRightIcon, CameraIcon, UserCircleIcon, XMarkIcon } from "@heroicons/react/24/outline";

import {
  normalizeSharedAccountName,
  splitSharedAccountName,
  type SharedAccountDetailsInput,
} from "./sharedAccountDetails";
import {
  sharedAccountProfileImageError,
  type SharedAccountProfileImageUpload,
} from "./sharedAccountProfileImage";

const ACCOUNT_INPUT_CLASS =
  "mt-2 h-12 w-full rounded-xl border border-gray-200 bg-white px-3 text-base text-gray-950 outline-none transition placeholder:text-gray-400 focus:border-primary-500 focus:ring-2 focus:ring-primary-100 sm:text-sm";

export type SharedAccountDetailsStepProps = {
  email: string;
  initialName?: string | null;
  initialPhone?: string | null;
  onUploadProfileImage: (file: File) => Promise<SharedAccountProfileImageUpload>;
  onSubmit: (input: SharedAccountDetailsInput) => Promise<void>;
};

export default function SharedAccountDetailsStep({
  email,
  initialName,
  initialPhone,
  onUploadProfileImage,
  onSubmit,
}: SharedAccountDetailsStepProps) {
  const initial = splitSharedAccountName(initialName);
  const profileImageInputRef = useRef<HTMLInputElement>(null);
  const [firstName, setFirstName] = useState(initial.firstName);
  const [lastName, setLastName] = useState(initial.lastName);
  const [phone, setPhone] = useState(initialPhone ?? "");
  const [profileImage, setProfileImage] = useState<File | null>(null);
  const [profileImageError, setProfileImageError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const profileImagePreviewUrl = useMemo(
    () => (profileImage ? URL.createObjectURL(profileImage) : null),
    [profileImage],
  );

  useEffect(
    () => () => {
      if (profileImagePreviewUrl) URL.revokeObjectURL(profileImagePreviewUrl);
    },
    [profileImagePreviewUrl],
  );

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError("");
    const errors = accountDetailsErrors({ firstName, lastName, phone });
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    try {
      const normalizedPhone = phone.trim();
      const uploadedProfileImage = profileImage
        ? await onUploadProfileImage(profileImage)
        : undefined;
      await onSubmit({
        firstName: firstName.trim().replace(/\s+/g, " "),
        lastName: lastName.trim().replace(/\s+/g, " "),
        phone: normalizedPhone,
        ...uploadedProfileImage,
      });
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : "We couldn't save your account details.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center bg-white px-4 py-8 text-gray-900 sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-4xl">
        <header className="mx-auto mb-6 max-w-xl text-center">
          <p className="text-xs font-semibold uppercase tracking-wide text-primary-700">
            Personal account
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-normal text-gray-950">
            Tell us about you
          </h1>
          <p className="mt-2 text-sm text-gray-500">
            Add your details once. We’ll use them across Marketplace, Booking Admin, and PMS.
          </p>
        </header>

        <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,32rem)_1fr] lg:items-center">
          <form
            onSubmit={handleSubmit}
            noValidate
            className="rounded-2xl border border-gray-200 bg-white p-5 text-left shadow-sm sm:p-6"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <AccountField
                id="account-first-name"
                label="First name"
                value={firstName}
                autoComplete="given-name"
                maxLength={60}
                required
                error={fieldErrors.firstName}
                onChange={(value) => {
                  setFirstName(value);
                  setFieldErrors((current) => ({ ...current, firstName: "" }));
                }}
              />
              <AccountField
                id="account-last-name"
                label="Last name"
                value={lastName}
                autoComplete="family-name"
                maxLength={60}
                required
                error={fieldErrors.lastName}
                onChange={(value) => {
                  setLastName(value);
                  setFieldErrors((current) => ({ ...current, lastName: "" }));
                }}
              />
              <div className="sm:col-span-2">
                <label htmlFor="account-email" className="block text-sm font-medium text-gray-800">
                  Email address
                </label>
                <input
                  id="account-email"
                  type="email"
                  value={email}
                  readOnly
                  autoComplete="email"
                  className={`${ACCOUNT_INPUT_CLASS} cursor-not-allowed bg-gray-50 text-gray-500`}
                />
                <p className="mt-2 text-xs text-gray-500">This comes from your sign-in account.</p>
              </div>
              <div className="sm:col-span-2">
                <AccountField
                  id="account-phone"
                  label="Phone number"
                  optional
                  type="tel"
                  value={phone}
                  autoComplete="tel"
                  maxLength={64}
                  placeholder="+49 89 123456"
                  error={fieldErrors.phone}
                  onChange={(value) => {
                    setPhone(value);
                    setFieldErrors((current) => ({ ...current, phone: "" }));
                  }}
                />
              </div>
            </div>

            {submitError && (
              <div
                className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
                role="alert"
              >
                {submitError}
              </div>
            )}

            <div className="mt-5 flex justify-end">
              <button
                type="submit"
                disabled={submitting}
                className="inline-flex items-center justify-center gap-2 rounded-full bg-primary-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? "Saving..." : "Save and continue"}
                {!submitting && <ArrowRightIcon className="h-4 w-4" aria-hidden="true" />}
              </button>
            </div>
          </form>

          <div className="order-first flex flex-col items-center justify-center text-center lg:order-last">
            <p className="text-sm font-semibold text-gray-900">
              Profile photo <span className="font-normal text-gray-400">Optional</span>
            </p>
            <button
              type="button"
              onClick={() => profileImageInputRef.current?.click()}
              disabled={submitting}
              aria-label={profileImage ? "Change profile photo" : "Upload profile photo"}
              className="group relative mt-4 flex h-48 w-48 items-center justify-center overflow-hidden rounded-full bg-primary-50 text-primary-600 outline-none ring-offset-4 transition hover:bg-primary-100 focus-visible:ring-2 focus-visible:ring-primary-600 disabled:cursor-not-allowed disabled:opacity-60 sm:h-52 sm:w-52"
            >
              {profileImagePreviewUrl ? (
                <img
                  src={profileImagePreviewUrl}
                  alt="Selected profile preview"
                  className="h-full w-full object-cover"
                />
              ) : (
                <UserCircleIcon className="h-32 w-32" strokeWidth={1.25} />
              )}
              <span className="absolute bottom-3 right-3 flex h-10 w-10 items-center justify-center rounded-full border-4 border-white bg-primary-600 text-white shadow-sm transition group-hover:bg-primary-700">
                <CameraIcon className="h-5 w-5" aria-hidden="true" />
              </span>
            </button>
            <input
              ref={profileImageInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="sr-only"
              aria-label="Profile photo file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                const error = sharedAccountProfileImageError(file);
                if (error) {
                  setProfileImage(null);
                  setProfileImageError(error);
                  event.target.value = "";
                  return;
                }
                setProfileImage(file);
                setProfileImageError("");
              }}
            />
            <div className="mt-4 flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => profileImageInputRef.current?.click()}
                disabled={submitting}
                className="text-sm font-semibold text-primary-700 hover:text-primary-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {profileImage ? "Change photo" : "Upload photo"}
              </button>
              {profileImage && (
                <button
                  type="button"
                  onClick={() => {
                    setProfileImage(null);
                    setProfileImageError("");
                    if (profileImageInputRef.current) profileImageInputRef.current.value = "";
                  }}
                  disabled={submitting}
                  className="inline-flex items-center gap-1 text-sm font-medium text-gray-500 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <XMarkIcon className="h-4 w-4" aria-hidden="true" />
                  Remove
                </button>
              )}
            </div>
            <p className="mt-2 text-xs text-gray-500">JPG, PNG, or WebP. Max 5 MB.</p>
            {profileImageError && (
              <p className="mt-2 text-sm text-red-600" role="alert">
                {profileImageError}
              </p>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

function AccountField({
  id,
  label,
  optional = false,
  type = "text",
  value,
  autoComplete,
  maxLength,
  placeholder,
  required = false,
  error,
  onChange,
}: {
  id: string;
  label: string;
  optional?: boolean;
  type?: "text" | "tel";
  value: string;
  autoComplete: string;
  maxLength: number;
  placeholder?: string;
  required?: boolean;
  error?: string;
  onChange: (value: string) => void;
}) {
  const errorId = `${id}-error`;
  return (
    <label htmlFor={id} className="block text-sm font-medium text-gray-800">
      {label} {optional && <span className="font-normal text-gray-400">Optional</span>}
      <input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        maxLength={maxLength}
        placeholder={placeholder}
        required={required}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        className={ACCOUNT_INPUT_CLASS}
      />
      {error && (
        <span id={errorId} className="mt-1 block text-xs text-red-600" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

function accountDetailsErrors(input: {
  firstName: string;
  lastName: string;
  phone: string;
}): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!input.firstName.trim()) errors.firstName = "Enter your first name.";
  if (!input.lastName.trim()) errors.lastName = "Enter your last name.";
  if (normalizeSharedAccountName(input.firstName, input.lastName).length > 120) {
    errors.lastName = "Enter a shorter name.";
  }
  if (input.phone.trim() && input.phone.trim().length < 5) {
    errors.phone = "Enter a valid phone number.";
  }
  return errors;
}
