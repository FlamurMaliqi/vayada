import { ArrowDownTrayIcon, CheckIcon } from "@heroicons/react/24/outline";
import { SettingsCard } from "@vayada/settings-ui";
import type { ComponentType, ReactNode } from "react";

import { formatBillingAmount, formatInvoiceDate } from "@/lib/settings/billing";
import type { BillingOverview } from "@/services/api/financeBillingClient";

export function PlanCard({
  title,
  label,
  price,
  priceSuffix,
  description,
  benefits,
  current,
  disabled,
  onSwitch,
}: {
  title: string;
  label: string;
  price: string;
  priceSuffix: string;
  description: string;
  benefits: string[];
  current: boolean;
  disabled?: boolean;
  onSwitch: () => void;
}) {
  return (
    <div
      className={`relative rounded-xl border p-5 ${current ? "border-primary-500 bg-primary-50/40 ring-1 ring-primary-500" : "border-gray-200 bg-white"}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
          <p className="mt-1 text-xs text-gray-500">{label}</p>
        </div>
        {current && (
          <span className="rounded-full bg-primary-100 px-2.5 py-1 text-[11px] font-semibold text-primary-700">
            CURRENT
          </span>
        )}
      </div>
      <div className="mt-4 flex items-end gap-2">
        <span className="text-3xl font-semibold tracking-tight text-gray-950">{price}</span>
        <span className="pb-1 text-xs text-gray-500">{priceSuffix}</span>
      </div>
      {description && (
        <p className="mt-2 min-h-10 text-[13px] leading-5 text-gray-600">{description}</p>
      )}
      <ul className="mt-5 space-y-2.5">
        {benefits.map((benefit) => (
          <li key={benefit} className="flex gap-2 text-[13px] text-gray-700">
            <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary-600" /> {benefit}
          </li>
        ))}
      </ul>
      <button
        type="button"
        disabled={current || disabled}
        onClick={onSwitch}
        className={`${current ? disabledButton : primaryButton} mt-6 w-full justify-center`}
      >
        {current ? "Your current plan" : disabled ? "Unavailable" : "Switch now"}
      </button>
    </div>
  );
}

export function PaymentChoice({
  selected,
  icon: Icon,
  title,
  description,
  onClick,
}: {
  selected: boolean;
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={`flex min-h-28 items-start gap-3 rounded-lg border p-4 text-left transition ${selected ? "border-primary-500 bg-primary-50/50 ring-1 ring-primary-500" : "border-gray-200 bg-white hover:border-gray-300"}`}
    >
      <span
        className={`rounded-lg p-2 ${selected ? "bg-primary-100 text-primary-700" : "bg-gray-100 text-gray-500"}`}
      >
        <Icon className="h-5 w-5" />
      </span>
      <span>
        <span className="block text-sm font-semibold text-gray-900">{title}</span>
        <span className="mt-1 block text-[13px] leading-5 text-gray-500">{description}</span>
      </span>
    </button>
  );
}

export function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-2 text-[13px] font-medium text-gray-700">
        {label}
        {required && (
          <span className="text-red-500" aria-hidden="true">
            *
          </span>
        )}
        {hint && <span className="font-normal text-gray-400">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export function InvoiceList({ invoices }: { invoices: BillingOverview["invoices"] }) {
  if (!invoices.length) {
    return (
      <SettingsCard>
        <div className="py-8 text-center">
          <p className="text-sm font-medium text-gray-900">No invoices yet</p>
          <p className="mt-1 text-[13px] text-gray-500">
            Your first invoice will appear here after your first billing cycle.
          </p>
        </div>
      </SettingsCard>
    );
  }
  const sorted = [...invoices].sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
  return (
    <SettingsCard contentClassName="!p-0">
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full text-left text-[13px]">
          <thead className="border-b border-gray-100 bg-gray-50/70 text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-5 py-3 font-medium">Invoice</th>
              <th className="px-5 py-3 font-medium">Date</th>
              <th className="px-5 py-3 font-medium">Amount</th>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3 text-right font-medium">PDF</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {sorted.map((invoice) => (
              <tr key={invoice.id}>
                <td className="px-5 py-4 font-medium text-gray-900">{invoice.number}</td>
                <td className="px-5 py-4 text-gray-600">{formatInvoiceDate(invoice.issuedAt)}</td>
                <td className="px-5 py-4 text-gray-900">
                  {formatBillingAmount(invoice.amountMinor, invoice.currency)}
                </td>
                <td className="px-5 py-4">
                  <InvoiceStatus status={invoice.status} />
                </td>
                <td className="px-5 py-4 text-right">
                  <InvoiceLink url={invoice.pdfUrl} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="divide-y divide-gray-100 sm:hidden">
        {sorted.map((invoice) => (
          <div key={invoice.id} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-gray-900">{invoice.number}</p>
                <p className="mt-1 text-xs text-gray-500">{formatInvoiceDate(invoice.issuedAt)}</p>
              </div>
              <InvoiceStatus status={invoice.status} />
            </div>
            <div className="mt-4 flex items-center justify-between">
              <span className="text-sm font-medium text-gray-900">
                {formatBillingAmount(invoice.amountMinor, invoice.currency)}
              </span>
              <InvoiceLink url={invoice.pdfUrl} />
            </div>
          </div>
        ))}
      </div>
    </SettingsCard>
  );
}

function InvoiceStatus({ status }: { status: "paid" | "pending" | "failed" }) {
  const styles =
    status === "paid"
      ? "bg-emerald-50 text-emerald-700"
      : status === "pending"
        ? "bg-amber-50 text-amber-700"
        : "bg-red-50 text-red-700";
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${styles}`}
    >
      {status}
    </span>
  );
}

function InvoiceLink({ url }: { url: string | null }) {
  return url ? (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 font-medium text-primary-700 hover:text-primary-800"
    >
      <ArrowDownTrayIcon className="h-4 w-4" /> PDF
    </a>
  ) : (
    <span className="text-gray-400">—</span>
  );
}

export function BillingSkeleton() {
  return (
    <div aria-label="Loading billing settings" className="animate-pulse space-y-8">
      <div className="h-5 w-48 rounded bg-gray-200" />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="h-72 rounded-xl bg-gray-100" />
        <div className="h-72 rounded-xl bg-gray-100" />
      </div>
      <div className="h-64 rounded-xl bg-gray-100" />
    </div>
  );
}

export const primaryButton =
  "inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50";
export const secondaryButton =
  "inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50";
const disabledButton =
  "inline-flex items-center gap-2 rounded-lg bg-gray-100 px-4 py-2 text-sm font-semibold text-gray-400 disabled:cursor-not-allowed";
export const inputClass =
  "w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-primary-500 focus:ring-2 focus:ring-primary-100";
