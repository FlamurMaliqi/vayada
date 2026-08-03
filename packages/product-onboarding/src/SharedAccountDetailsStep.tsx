"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRightIcon, CameraIcon, UserCircleIcon } from "@heroicons/react/24/outline";

import {
  isValidSharedAccountPhone,
  normalizeSharedAccountName,
  sharedAccountInitials,
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
  accountType: "hotel" | "creator";
  email: string;
  initialName?: string | null;
  initialPhone?: string | null;
  initialProfilePictureUrl?: string | null;
  initialProfilePictureMediaObjectId?: string | null;
  initialProfileImage?: SharedAccountProfileImageUpload | null;
  onUploadProfileImage: (file: File) => Promise<SharedAccountProfileImageUpload>;
  onSubmit: (input: SharedAccountDetailsInput) => Promise<void>;
};

export default function SharedAccountDetailsStep({
  accountType,
  email,
  initialName,
  initialPhone,
  initialProfilePictureUrl,
  initialProfilePictureMediaObjectId,
  initialProfileImage,
  onUploadProfileImage,
  onSubmit,
}: SharedAccountDetailsStepProps) {
  const initial = splitSharedAccountName(initialName);
  const existingProfileImage =
    initialProfileImage ??
    (initialProfilePictureUrl && initialProfilePictureMediaObjectId
      ? {
          profilePictureUrl: initialProfilePictureUrl,
          profilePictureMediaObjectId: initialProfilePictureMediaObjectId,
        }
      : null);
  const hasInitialProfileImage = Boolean(
    existingProfileImage?.profilePictureUrl.trim() &&
    existingProfileImage.profilePictureMediaObjectId.trim(),
  );
  const description =
    accountType === "hotel" ? "Start with your details. Next, we’ll set up your first hotel." : "";
  const submitLabel =
    accountType === "hotel" ? "Continue to hotel setup" : "Continue to creator profile";
  const requiresProfileImage = accountType === "creator";
  const headingRef = useRef<HTMLHeadingElement>(null);
  const profileImageInputRef = useRef<HTMLInputElement>(null);
  const uploadedProfileImageRef = useRef<{
    file: File;
    upload: SharedAccountProfileImageUpload;
  } | null>(null);
  const [firstName, setFirstName] = useState(initial.firstName);
  const [lastName, setLastName] = useState(initial.lastName);
  const [phone, setPhone] = useState(initialPhone ?? "");
  const [profileImage, setProfileImage] = useState<File | null>(null);
  const [profileImageError, setProfileImageError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [profileImagePreviewUrl, setProfileImagePreviewUrl] = useState<string | null>(
    hasInitialProfileImage ? (existingProfileImage?.profilePictureUrl ?? null) : null,
  );

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    uploadedProfileImageRef.current = null;
    if (!profileImage) {
      setProfileImagePreviewUrl(
        hasInitialProfileImage ? (existingProfileImage?.profilePictureUrl ?? null) : null,
      );
      return;
    }
    const previewUrl = URL.createObjectURL(profileImage);
    setProfileImagePreviewUrl(previewUrl);
    return () => URL.revokeObjectURL(previewUrl);
  }, [existingProfileImage?.profilePictureUrl, hasInitialProfileImage, profileImage]);

  async function uploadProfileImage(file: File) {
    const cached = uploadedProfileImageRef.current;
    if (cached?.file === file) return cached.upload;
    const upload = await onUploadProfileImage(file);
    uploadedProfileImageRef.current = { file, upload };
    return upload;
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError("");
    const errors = accountDetailsErrors({ firstName, lastName, phone });
    const missingRequiredProfileImage =
      requiresProfileImage && !profileImage && !hasInitialProfileImage;
    setFieldErrors(errors);
    if (missingRequiredProfileImage && !profileImageError) {
      setProfileImageError("Profile photo is required.");
    }
    if (Object.keys(errors).length > 0 || missingRequiredProfileImage) return;

    setSubmitting(true);
    try {
      const normalizedPhone = phone.trim();
      const uploadedProfileImage =
        requiresProfileImage && profileImage ? await uploadProfileImage(profileImage) : undefined;
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
      <div className="mx-auto w-full max-w-xl">
        <header className="mx-auto mb-6 max-w-xl text-center">
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="mt-2 text-3xl font-semibold tracking-normal text-gray-950 outline-none first:mt-0"
          >
            Let’s create your profile
          </h1>
          {description && <p className="mt-2 text-sm text-gray-500">{description}</p>}
        </header>

        <form
          onSubmit={handleSubmit}
          noValidate
          className="rounded-2xl border border-gray-200 bg-white p-5 text-left shadow-sm sm:p-6"
        >
          {requiresProfileImage ? (
            <div className="mb-4 flex flex-col items-center text-center">
              <p className="text-sm font-semibold text-gray-900">
                Profile photo
                <span className="ml-1 text-red-500" aria-hidden="true">
                  *
                </span>
                <span className="sr-only"> (required)</span>
              </p>
              <button
                type="button"
                onClick={() => profileImageInputRef.current?.click()}
                disabled={submitting}
                aria-label={
                  profileImage || hasInitialProfileImage
                    ? "Change profile photo"
                    : "Upload profile photo"
                }
                title={
                  profileImage || hasInitialProfileImage
                    ? "Change profile photo"
                    : "Upload profile photo"
                }
                aria-invalid={profileImageError ? true : undefined}
                aria-describedby={profileImageError ? "account-profile-image-error" : undefined}
                className="group relative mt-3 flex h-36 w-36 items-center justify-center rounded-full bg-primary-50 text-primary-600 outline-none ring-1 ring-gray-100 transition hover:bg-primary-100 focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 sm:h-40 sm:w-40"
              >
                {profileImagePreviewUrl ? (
                  <img
                    src={profileImagePreviewUrl}
                    alt={profileImage ? "Selected profile preview" : "Existing profile photo"}
                    className="h-full w-full rounded-full object-cover"
                  />
                ) : (
                  <UserCircleIcon
                    className="h-20 w-20 sm:h-24 sm:w-24"
                    strokeWidth={1.25}
                    aria-hidden="true"
                  />
                )}
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute bottom-1 right-1 flex h-11 w-11 items-center justify-center rounded-full border-4 border-white bg-primary-600 text-white shadow-sm transition-colors group-hover:bg-primary-700"
                >
                  <CameraIcon className="h-5 w-5" aria-hidden="true" />
                </span>
              </button>
              <input
                ref={profileImageInputRef}
                type="file"
                accept="image/*"
                required={!hasInitialProfileImage}
                className="hidden"
                aria-label="Profile photo file"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  const error = sharedAccountProfileImageError(file);
                  if (error) {
                    setProfileImageError(error);
                    event.target.value = "";
                    return;
                  }
                  setProfileImage(file);
                  setProfileImageError("");
                }}
              />
              <p className="mt-2 text-xs text-gray-500">JPG, PNG, or WebP. Max 5 MB.</p>
              {profileImageError && (
                <p
                  id="account-profile-image-error"
                  className="mt-2 text-sm text-red-600"
                  role="alert"
                >
                  {profileImageError}
                </p>
              )}
            </div>
          ) : (
            <div className="mb-5 flex flex-col items-center text-center">
              <p className="text-sm font-semibold text-gray-900">Your manager identity</p>
              <div
                className="mt-3 flex h-24 w-24 items-center justify-center rounded-full bg-primary-50 text-2xl font-semibold text-primary-700 ring-1 ring-primary-100"
                role="img"
                aria-label={`Manager initials: ${sharedAccountInitials(firstName, lastName)}`}
              >
                {sharedAccountInitials(firstName, lastName)}
              </div>
              <p className="mt-2 max-w-sm text-xs leading-5 text-gray-500">
                Your initials identify your personal account. Your hotel logo is added separately.
              </p>
            </div>
          )}

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
              <p className="mt-1 text-xs text-gray-500">This comes from your sign-in account.</p>
            </div>
            <div className="sm:col-span-2">
              <AccountField
                id="account-phone"
                label="Phone number"
                type="tel"
                value={phone}
                autoComplete="tel"
                maxLength={64}
                placeholder="+49 89 123456"
                required
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
              {submitting ? "Saving..." : submitLabel}
              {!submitting && <ArrowRightIcon className="h-4 w-4" aria-hidden="true" />}
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}

function AccountField({
  id,
  label,
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
      {label}
      {required ? (
        <>
          <span className="ml-1 text-red-500" aria-hidden="true">
            *
          </span>
          <span className="sr-only"> (required)</span>
        </>
      ) : null}
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
  if (!input.phone.trim()) {
    errors.phone = "Enter your phone number.";
  } else if (!isValidSharedAccountPhone(input.phone)) {
    errors.phone = "Enter a valid phone number.";
  }
  return errors;
}
