"use client";

import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import type { FormEventHandler, ReactNode } from "react";

export function OperationFormShell({
  children,
  error,
  notice,
  onBack,
  onSubmit,
  secondaryAction,
  submitLabel,
  submitting,
  submittingLabel = "Saving...",
}: {
  children: ReactNode;
  error?: string;
  notice?: ReactNode;
  onBack: (() => void) | null;
  onSubmit: FormEventHandler<HTMLFormElement>;
  secondaryAction?: { label: string; onClick: () => void };
  submitLabel: string;
  submitting: boolean;
  submittingLabel?: string;
}) {
  return (
    <form className="space-y-6" onSubmit={onSubmit}>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">{children}</div>

      {error ? (
        <div
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
          role="alert"
        >
          {error}
        </div>
      ) : null}
      {notice ? (
        <div
          className="rounded-xl border border-primary-200 bg-primary-50 px-4 py-3 text-sm text-primary-900"
          role="status"
        >
          {notice}
        </div>
      ) : null}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        {onBack ? (
          <button
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-gray-300 bg-white px-5 py-2.5 text-sm font-semibold text-gray-800 transition hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-600 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={submitting}
            onClick={onBack}
            type="button"
          >
            <ArrowLeftIcon aria-hidden="true" className="h-4 w-4" />
            Back
          </button>
        ) : (
          <span />
        )}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          {secondaryAction ? (
            <button
              className="min-h-11 rounded-full border border-primary-300 bg-white px-6 py-2.5 text-sm font-semibold text-primary-700 transition hover:bg-primary-50 focus:outline-none focus:ring-2 focus:ring-primary-600 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={submitting}
              onClick={secondaryAction.onClick}
              type="button"
            >
              {secondaryAction.label}
            </button>
          ) : null}
          <button
            className="min-h-11 rounded-full bg-primary-600 px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-600 focus:ring-offset-2 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
            disabled={submitting}
            type="submit"
          >
            {submitting ? submittingLabel : submitLabel}
          </button>
        </div>
      </div>
    </form>
  );
}

export function OperationField({
  children,
  className = "",
  hint,
  label,
}: {
  children: ReactNode;
  className?: string;
  hint?: string;
  label: string;
}) {
  return (
    <label className={`block space-y-2 ${className}`}>
      <span className="block text-sm font-semibold text-gray-900">{label}</span>
      {children}
      {hint ? <span className="block text-xs leading-5 text-gray-600">{hint}</span> : null}
    </label>
  );
}

export const operationInputClassName =
  "min-h-11 w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-950 outline-none transition placeholder:text-gray-500 focus:border-primary-600 focus:ring-2 focus:ring-primary-100 disabled:cursor-not-allowed disabled:bg-gray-100";

export function OperationFormLoading() {
  return (
    <div aria-live="polite" className="space-y-5">
      <span className="sr-only">Loading setup form</span>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <div className="h-20 animate-pulse rounded-xl bg-gray-100" />
        <div className="h-20 animate-pulse rounded-xl bg-gray-100" />
        <div className="h-28 animate-pulse rounded-xl bg-gray-100 sm:col-span-2" />
      </div>
    </div>
  );
}

export function OperationFormLoadError({
  message,
  onBack,
  onRetry,
}: {
  message: string;
  onBack: (() => void) | null;
  onRetry: () => void;
}) {
  return (
    <div className="space-y-4">
      <div
        className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        role="alert"
      >
        {message}
      </div>
      <div className="flex flex-wrap gap-3">
        {onBack ? (
          <button
            className="min-h-11 rounded-full border border-gray-300 bg-white px-5 py-2.5 text-sm font-semibold text-gray-800 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-600 focus:ring-offset-2"
            onClick={onBack}
            type="button"
          >
            Back
          </button>
        ) : null}
        <button
          className="min-h-11 rounded-full bg-primary-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-600 focus:ring-offset-2"
          onClick={onRetry}
          type="button"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
