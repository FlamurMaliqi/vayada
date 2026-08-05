"use client";

import type { ReactNode } from "react";
import { ArrowLeftIcon } from "@heroicons/react/24/outline";

export type AdaptiveHotelSetupShellProps = {
  brandMark: ReactNode;
  currentStep: number;
  totalSteps: number;
  title: string;
  subtitle: string;
  children: ReactNode;
  onBack?: (() => void) | null;
  onExit: () => void;
  backDisabled?: boolean;
  exitDisabled?: boolean;
  loading?: boolean;
  routeError?: string | null;
  routeErrorTitle?: string;
  onRetry?: (() => void) | null;
  staleDraftMessage?: string | null;
  onRefresh?: (() => void) | null;
  refreshing?: boolean;
};

export function AdaptiveHotelSetupShell({
  brandMark,
  currentStep,
  totalSteps,
  title,
  subtitle,
  children,
  onBack,
  onExit,
  backDisabled = false,
  exitDisabled = false,
  loading = false,
  routeError,
  routeErrorTitle = "Setup could not be loaded",
  onRetry,
  staleDraftMessage,
  onRefresh,
  refreshing = false,
}: AdaptiveHotelSetupShellProps) {
  const normalizedTotal = Math.max(1, totalSteps);
  const normalizedCurrent = Math.min(normalizedTotal, Math.max(1, currentStep));

  return (
    <main
      className="min-h-[100dvh] bg-gray-50 text-gray-950"
      aria-labelledby="adaptive-setup-heading"
    >
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto grid w-full max-w-7xl grid-cols-[1fr_auto] items-start gap-x-4 gap-y-3 px-4 py-4 sm:grid-cols-[1fr_auto_1fr] sm:items-center sm:px-6 lg:px-8">
          <button
            type="button"
            onClick={onBack ?? undefined}
            disabled={!onBack || backDisabled}
            className="row-start-1 inline-flex min-h-10 items-center gap-2 justify-self-start whitespace-nowrap rounded-lg px-2 text-sm font-semibold text-gray-600 outline-none hover:bg-gray-100 hover:text-gray-950 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ArrowLeftIcon className="h-4 w-4" aria-hidden="true" />
            Back
          </button>

          <div className="col-span-2 row-start-2 flex min-w-0 flex-col items-center justify-self-center sm:col-span-1 sm:col-start-2 sm:row-start-1">
            <div className="flex min-h-8 items-center justify-center">{brandMark}</div>
            <p className="mt-1 whitespace-nowrap text-sm font-semibold text-gray-600">
              Step {normalizedCurrent} of {normalizedTotal}
            </p>
            <div
              className="mt-2 flex w-64 items-center justify-center gap-1.5 sm:w-80"
              role="progressbar"
              aria-label="Hotel setup progress"
              aria-valuemin={1}
              aria-valuemax={normalizedTotal}
              aria-valuenow={normalizedCurrent}
              aria-valuetext={`Step ${normalizedCurrent} of ${normalizedTotal}`}
            >
              {Array.from({ length: normalizedTotal }, (_, index) => (
                <span
                  key={index}
                  aria-hidden="true"
                  className={`h-1.5 flex-1 rounded-full ${
                    index < normalizedCurrent ? "bg-primary-600" : "bg-primary-100"
                  }`}
                />
              ))}
            </div>
          </div>

          <button
            type="button"
            onClick={onExit}
            disabled={exitDisabled}
            className="col-start-2 row-start-1 min-h-10 justify-self-end whitespace-nowrap rounded-lg px-2 text-sm font-semibold text-gray-600 outline-none hover:bg-gray-100 hover:text-gray-950 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40 sm:col-start-3"
          >
            Exit setup
          </button>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-7xl flex-col px-4 pb-12 pt-8 sm:px-6 sm:pt-10 lg:px-8">
        <header className="mx-auto w-full max-w-3xl text-center">
          <h1
            id="adaptive-setup-heading"
            tabIndex={-1}
            className="text-2xl font-semibold tracking-tight text-gray-950 outline-none sm:text-3xl"
          >
            {title}
          </h1>
          <p className="mx-auto mt-2 max-w-2xl text-sm leading-6 text-gray-600 sm:text-base">
            {subtitle}
          </p>
        </header>

        <section
          className="mx-auto mt-8 w-full max-w-6xl"
          aria-busy={loading || refreshing || undefined}
        >
          {routeError ? (
            <RecoveryMessage
              title={routeErrorTitle}
              message={routeError}
              actionLabel="Retry"
              onAction={onRetry}
            />
          ) : staleDraftMessage ? (
            <RecoveryMessage
              title="This setup draft is out of date"
              message={staleDraftMessage}
              actionLabel={refreshing ? "Refreshing…" : "Refresh"}
              onAction={onRefresh}
              disabled={refreshing}
            />
          ) : null}
          {loading ? (
            <div
              className="rounded-2xl border border-gray-200 bg-white px-6 py-12 text-center sm:px-10"
              role="status"
              aria-live="polite"
            >
              <p className="text-sm font-medium text-gray-700">Loading setup…</p>
            </div>
          ) : (
            <div className={routeError || staleDraftMessage ? "mt-6" : undefined}>{children}</div>
          )}
        </section>
      </div>
    </main>
  );
}

function RecoveryMessage({
  title,
  message,
  actionLabel,
  onAction,
  disabled = false,
}: {
  title: string;
  message: string;
  actionLabel: string;
  onAction?: (() => void) | null;
  disabled?: boolean;
}) {
  return (
    <div
      className="rounded-2xl border border-red-200 bg-white px-6 py-8 text-center sm:px-10"
      role="alert"
    >
      <h2 className="text-base font-semibold text-gray-950">{title}</h2>
      <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-gray-600">{message}</p>
      {onAction && (
        <button
          type="button"
          onClick={onAction}
          disabled={disabled}
          className="mt-5 min-h-10 whitespace-nowrap rounded-full bg-primary-600 px-5 py-2 text-sm font-semibold text-white outline-none hover:bg-primary-700 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-primary-300"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
