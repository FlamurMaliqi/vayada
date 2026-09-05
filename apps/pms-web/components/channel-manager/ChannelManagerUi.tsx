import {
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import { terminalChannexStatuses } from "@/lib/channel-manager/useChannexManager";
import type { ChannexCapabilityMode, ChannexOperation, ChannexSnapshot } from "@/services/channex";
import { useTranslation } from "@/lib/i18n";

export const channelManagerButtonClass =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45";

export function modeAllowsChanges(mode: ChannexCapabilityMode) {
  return mode === "mutating";
}

export function ConnectionBadge({ status }: { status: ChannexSnapshot["connection"]["status"] }) {
  const { t } = useTranslation();
  const connected = status === "connected";
  const degraded = status === "degraded";
  return (
    <span
      className={`inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold capitalize ${connected ? "border-green-200 bg-green-50 text-green-700" : degraded ? "border-amber-200 bg-amber-50 text-amber-700" : "border-gray-200 bg-white text-gray-600"}`}
    >
      <span
        className={`h-2 w-2 rounded-full ${connected ? "bg-green-500" : degraded ? "bg-amber-500" : "bg-gray-400"}`}
      />
      {translateEnum(t, "channels.status", status)}
    </span>
  );
}

export function OperationBanner({ operation }: { operation: ChannexOperation }) {
  const { t } = useTranslation();
  const failed = ["failed", "dead_lettered"].includes(operation.status);
  const succeeded = operation.status === "succeeded";
  return (
    <div
      className={`mt-5 flex gap-3 rounded-xl border p-4 text-sm ${failed ? "border-red-200 bg-red-50 text-red-800" : succeeded ? "border-green-200 bg-green-50 text-green-800" : "border-blue-200 bg-blue-50 text-blue-800"}`}
      role="status"
    >
      {failed ? (
        <ExclamationTriangleIcon className="h-5 w-5 shrink-0" />
      ) : succeeded ? (
        <CheckCircleIcon className="h-5 w-5 shrink-0" />
      ) : (
        <ArrowPathIcon className="h-5 w-5 shrink-0 animate-spin" />
      )}
      <div>
        <p className="font-semibold capitalize">
          {translateEnum(t, "channels.operation", operation.operationType)}:{" "}
          {translateEnum(t, "channels.status", operation.status)}
        </p>
        {operation.lastError && <p className="mt-1">{operation.lastError.message}</p>}
        {!terminalChannexStatuses.has(operation.status) && (
          <p className="mt-1">
            {t("channels.attemptOf", {
              attempt:
                operation.status === "running"
                  ? operation.attemptsMade
                  : operation.attemptsMade + 1,
              total: operation.maxAttempts,
            })}
          </p>
        )}
      </div>
    </div>
  );
}

export function MappingMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-gray-50 p-4">
      <p className="text-2xl font-semibold text-gray-950">{value}</p>
      <p className="mt-1 text-xs font-medium text-gray-500">{label}</p>
    </div>
  );
}

export function SyncAction({
  icon: Icon,
  title,
  state,
  disabled,
  onClick,
  actionLabel,
}: {
  icon: typeof ArrowPathIcon;
  title: string;
  state: ChannexSnapshot["sync"]["ari"];
  disabled: boolean;
  onClick: () => void;
  actionLabel?: string;
}) {
  const { t, locale } = useTranslation();
  return (
    <div className="rounded-lg border border-gray-200 p-4">
      <div className="flex items-start gap-3">
        <Icon className="h-5 w-5 shrink-0 text-gray-500" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-gray-900">{title}</p>
            <span className="text-xs font-medium capitalize text-gray-500">
              {translateEnum(t, "channels.status", state.status)}
            </span>
          </div>
          <p className="mt-1 text-xs text-gray-500">
            {t("channels.lastSuccess", {
              time: formatTime(state.lastSuccessAt, locale, t("common.never")),
            })}
          </p>
          {state.lastErrorMessage && (
            <p className="mt-1 text-xs text-red-600">{state.lastErrorMessage}</p>
          )}
          <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className="mt-3 text-xs font-semibold text-primary-700 hover:text-primary-800 disabled:cursor-not-allowed disabled:text-gray-400"
          >
            {actionLabel ?? t("channels.syncNow")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ChannelManagerSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="p-4 md:p-6" aria-label={t("channels.loading")} role="status">
      <div className="mx-auto max-w-6xl animate-pulse">
        <div className="h-7 w-52 rounded bg-gray-200" />
        <div className="mt-3 h-4 w-full max-w-xl rounded bg-gray-200" />
        <div className="mt-7 grid gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(300px,0.75fr)]">
          <div className="space-y-5">
            <div className="h-44 rounded-xl bg-gray-200" />
            <div className="h-72 rounded-xl bg-gray-200" />
          </div>
          <div className="space-y-5">
            <div className="h-72 rounded-xl bg-gray-200" />
            <div className="h-40 rounded-xl bg-gray-200" />
          </div>
        </div>
      </div>
    </div>
  );
}

function formatTime(value: string | null, locale: string, never: string) {
  if (!value) return never;
  return new Date(value).toLocaleString(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function translateEnum(t: (key: string) => string, prefix: string, value: string): string {
  const key = `${prefix}.${value}`;
  const translated = t(key);
  return translated === key ? value.replaceAll("_", " ") : translated;
}
