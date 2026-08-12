"use client";

import type { ReactNode } from "react";

export const adaptivePrimaryButtonClass =
  "inline-flex min-h-11 items-center justify-center rounded-full bg-primary-600 px-6 py-2.5 text-sm font-semibold text-white outline-none transition hover:bg-primary-700 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-primary-300";

export const adaptiveSecondaryButtonClass =
  "inline-flex min-h-11 items-center justify-center rounded-full border border-gray-300 bg-white px-5 py-2.5 text-sm font-semibold text-gray-800 outline-none transition hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

export function AdaptiveStepCard({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl border border-gray-200 bg-white p-5 shadow-sm sm:p-8 ${className}`}
    >
      {children}
    </div>
  );
}

export function AdaptiveSaveError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3" role="alert">
      <p className="text-sm font-semibold text-red-900">Your changes were not saved</p>
      <p className="mt-1 text-sm leading-5 text-red-800">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 rounded-md text-sm font-semibold text-red-900 underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-red-700"
        >
          Retry
        </button>
      )}
    </div>
  );
}

export function AdaptiveStepSkeleton({ columns = false }: { columns?: boolean }) {
  return (
    <div
      className={columns ? "grid gap-6 lg:grid-cols-[23rem_1fr]" : "mx-auto max-w-5xl"}
      role="status"
      aria-label="Loading step"
    >
      {[0, ...(columns ? [1] : [])].map((key) => (
        <div
          key={key}
          className="h-72 animate-pulse rounded-2xl border border-gray-200 bg-white p-8"
        >
          <div className="h-4 w-1/3 rounded bg-gray-200" />
          <div className="mt-7 h-11 rounded bg-gray-100" />
          <div className="mt-5 h-24 rounded bg-gray-100" />
        </div>
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}
