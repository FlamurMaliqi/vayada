import { FormEvent } from "react";
import { MagnifyingGlassIcon, UserGroupIcon } from "@heroicons/react/24/outline";
import type {
  Affiliate,
  AffiliateDetail,
  AffiliateLifecycleAction,
  AffiliateLifecycleStatus,
  AffiliateListResponse,
} from "@/services/affiliates";

const STATUS_OPTIONS: Array<{ value: "" | AffiliateLifecycleStatus; label: string }> = [
  { value: "", label: "All applications" },
  { value: "pending", label: "Pending review" },
  { value: "approved", label: "Approved" },
  { value: "suspended", label: "Suspended" },
  { value: "rejected", label: "Rejected" },
];

const STATUS_STYLES: Record<AffiliateLifecycleStatus, string> = {
  pending: "border-amber-200 bg-amber-50 text-amber-700",
  approved: "border-emerald-200 bg-emerald-50 text-emerald-700",
  rejected: "border-red-200 bg-red-50 text-red-700",
  suspended: "border-violet-200 bg-violet-50 text-violet-700",
};

const STATUS_RAILS: Record<AffiliateLifecycleStatus, string> = {
  pending: "border-l-amber-400",
  approved: "border-l-emerald-500",
  rejected: "border-l-red-400",
  suspended: "border-l-violet-500",
};

interface AffiliateWorkspaceProps {
  applications: AffiliateListResponse | null;
  selectedId: string | null;
  detail: AffiliateDetail | null;
  status: "" | AffiliateLifecycleStatus;
  searchDraft: string;
  overrideDraft: string;
  loading: boolean;
  busy: string | null;
  onSearchDraftChange: (value: string) => void;
  onSearch: (event: FormEvent) => void;
  onStatusChange: (value: "" | AffiliateLifecycleStatus) => void;
  onSelect: (affiliateId: string) => void;
  onOverrideChange: (value: string) => void;
  onLifecycle: (action: AffiliateLifecycleAction) => void;
  onSaveOverride: (inherit?: boolean) => void;
}

export function AffiliateWorkspace(props: AffiliateWorkspaceProps) {
  const selected = props.applications?.affiliates.some(
    (item) => item.affiliateId === props.selectedId,
  );
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(340px,0.9fr)]">
      <section className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <form
          onSubmit={props.onSearch}
          className="grid gap-2 border-b border-gray-200 p-3 sm:grid-cols-[1fr_170px_auto]"
        >
          <label className="relative">
            <span className="sr-only">Search affiliates</span>
            <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              value={props.searchDraft}
              onChange={(event) => props.onSearchDraftChange(event.target.value)}
              placeholder="Name, email, or referral code"
              className="h-9 w-full rounded-md border border-gray-200 pl-9 pr-3 text-[13px] focus:border-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-100"
            />
          </label>
          <select
            aria-label="Affiliate status"
            value={props.status}
            onChange={(event) =>
              props.onStatusChange(event.target.value as "" | AffiliateLifecycleStatus)
            }
            className="h-9 rounded-md border border-gray-200 bg-white px-3 text-[13px] text-gray-700"
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button className="h-9 rounded-md bg-primary-600 px-4 text-[13px] font-medium text-white hover:bg-primary-700">
            Search
          </button>
        </form>
        <p className="border-b border-gray-100 px-3 py-2 text-xs text-gray-500">
          {props.applications
            ? `${props.applications.total} application${props.applications.total === 1 ? "" : "s"}`
            : "Applications"}
        </p>
        <div className="max-h-[560px] divide-y divide-gray-100 overflow-y-auto">
          {props.loading && !props.applications && (
            <p className="p-6 text-center text-sm text-gray-500">Loading applications…</p>
          )}
          {!props.loading && props.applications?.affiliates.length === 0 && <EmptyState />}
          {props.applications?.affiliates.map((affiliate) => (
            <ApplicationRow
              key={affiliate.affiliateId}
              affiliate={affiliate}
              selected={affiliate.affiliateId === props.selectedId}
              onSelect={() => props.onSelect(affiliate.affiliateId)}
            />
          ))}
        </div>
      </section>

      <aside
        className="rounded-lg border border-gray-200 bg-white p-4"
        aria-label="Affiliate detail"
      >
        {!selected && <SelectPrompt />}
        {selected && !props.detail && (
          <p className="py-16 text-center text-sm text-gray-500">Loading applicant…</p>
        )}
        {props.detail && (
          <AffiliateDossier
            detail={props.detail}
            overrideDraft={props.overrideDraft}
            onOverrideChange={props.onOverrideChange}
            busy={props.busy}
            onLifecycle={props.onLifecycle}
            onSaveOverride={props.onSaveOverride}
          />
        )}
      </aside>
    </div>
  );
}

function ApplicationRow({
  affiliate,
  selected,
  onSelect,
}: {
  affiliate: Affiliate;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full border-l-4 px-3 py-3 text-left transition-colors ${STATUS_RAILS[affiliate.lifecycleStatus]} ${selected ? "bg-primary-50/60" : "hover:bg-gray-50"}`}
    >
      <span className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-gray-900">
            {affiliateName(affiliate)}
          </span>
          <span className="mt-0.5 block truncate text-xs text-gray-500">
            {affiliate.contactEmail ?? affiliate.referralCode}
          </span>
        </span>
        <StatusBadge status={affiliate.lifecycleStatus} />
      </span>
      <span className="mt-2 block text-[11px] text-gray-400">
        {affiliate.affiliateType === "creator" ? "Creator" : "Guest"} ·{" "}
        {formatDate(affiliate.appliedAt)}
      </span>
    </button>
  );
}

function AffiliateDossier({
  detail,
  overrideDraft,
  onOverrideChange,
  busy,
  onLifecycle,
  onSaveOverride,
}: Pick<
  AffiliateWorkspaceProps,
  "detail" | "overrideDraft" | "onOverrideChange" | "busy" | "onLifecycle" | "onSaveOverride"
> & { detail: AffiliateDetail }) {
  const { affiliate, commission } = detail;
  const actions = lifecycleActions(affiliate.lifecycleStatus);
  return (
    <div className="space-y-5">
      <div className="border-b border-gray-100 pb-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-lg font-bold text-gray-900">{affiliateName(affiliate)}</p>
            <p className="mt-1 text-xs text-gray-500">
              {affiliate.contactEmail ?? "No contact email"}
            </p>
          </div>
          <StatusBadge status={affiliate.lifecycleStatus} />
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
          <Detail label="Referral code" value={affiliate.referralCode} />
          <Detail
            label="Applicant type"
            value={affiliate.affiliateType === "creator" ? "Creator" : "Guest"}
          />
          <Detail label="Applied" value={formatDate(affiliate.appliedAt)} />
          <Detail label="Social profile" value={affiliate.socialMedia ?? "Not provided"} />
        </dl>
      </div>
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          Application access
        </h3>
        <div className="mt-2 flex flex-wrap gap-2">
          {actions.length ? (
            actions.map((action) => (
              <button
                key={action}
                type="button"
                onClick={() => onLifecycle(action)}
                disabled={Boolean(busy)}
                className={`h-8 rounded-md px-3 text-xs font-semibold disabled:opacity-50 ${actionStyle(action)}`}
              >
                {actionLabel(action)}
              </button>
            ))
          ) : (
            <p className="text-xs text-gray-500">
              No lifecycle action is available for this status.
            </p>
          )}
        </div>
      </div>
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
        <h3 className="text-sm font-semibold text-gray-900">Commission override</h3>
        <p className="mt-1 text-xs text-gray-500">
          Effective rate:{" "}
          <strong className="text-gray-800">{commission.effectivePercentageRate}%</strong> · Default{" "}
          {commission.defaultPercentageRate}%
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-xs font-medium text-gray-600">
            Override %
            <input
              aria-label="Affiliate commission override"
              value={overrideDraft}
              onChange={(event) => onOverrideChange(event.target.value)}
              placeholder={commission.defaultPercentageRate}
              inputMode="decimal"
              className="mt-1 block h-9 w-28 rounded-md border border-gray-200 bg-white px-3 text-sm focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-100"
            />
          </label>
          <button
            type="button"
            onClick={() => onSaveOverride()}
            disabled={busy === "commission"}
            className="h-9 rounded-md bg-gray-900 px-3 text-xs font-medium text-white disabled:opacity-50"
          >
            Save override
          </button>
          <button
            type="button"
            onClick={() => onSaveOverride(true)}
            disabled={busy === "commission" || commission.overridePercentageRate === null}
            className="h-9 rounded-md border border-gray-200 bg-white px-3 text-xs font-medium text-gray-700 disabled:opacity-50"
          >
            Use default
          </button>
        </div>
        <p className="mt-3 text-[11px] text-gray-400">
          Lifecycle and commission changes are recorded in the property audit trail.
        </p>
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-gray-400">{label}</dt>
      <dd className="mt-1 break-words font-medium text-gray-700">{value}</dd>
    </div>
  );
}

function StatusBadge({ status }: { status: AffiliateLifecycleStatus }) {
  return (
    <span
      className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold capitalize ${STATUS_STYLES[status]}`}
    >
      {status}
    </span>
  );
}

function EmptyState() {
  return (
    <div className="p-8 text-center">
      <UserGroupIcon className="mx-auto h-7 w-7 text-gray-300" />
      <p className="mt-2 text-sm font-medium text-gray-700">No matching applications</p>
      <p className="mt-1 text-xs text-gray-500">Try another status or clear the search.</p>
    </div>
  );
}

function SelectPrompt() {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center text-center">
      <UserGroupIcon className="h-8 w-8 text-gray-300" />
      <p className="mt-3 text-sm font-medium text-gray-700">Select an application</p>
      <p className="mt-1 max-w-xs text-xs text-gray-500">
        Applicant details and available actions appear here.
      </p>
    </div>
  );
}

export function affiliateName(affiliate: Affiliate) {
  return affiliate.displayName ?? affiliate.contactEmail ?? affiliate.referralCode;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

function lifecycleActions(status: AffiliateLifecycleStatus): AffiliateLifecycleAction[] {
  if (status === "pending") return ["approve", "reject"];
  if (status === "approved") return ["suspend"];
  if (status === "suspended") return ["restore"];
  return [];
}

function actionLabel(action: AffiliateLifecycleAction) {
  return action === "restore"
    ? "Restore access"
    : action === "suspend"
      ? "Suspend access"
      : action === "approve"
        ? "Approve"
        : "Reject";
}

function actionStyle(action: AffiliateLifecycleAction) {
  if (action === "approve" || action === "restore")
    return "bg-emerald-600 text-white hover:bg-emerald-700";
  if (action === "reject") return "border border-red-200 bg-white text-red-700 hover:bg-red-50";
  return "border border-violet-200 bg-white text-violet-700 hover:bg-violet-50";
}
