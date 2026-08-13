"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import {
  affiliatePayoutsService,
  type AffiliatePayoutDetail,
  type AffiliatePayoutSummary,
} from "@/services/api/affiliatePayouts";

type Selection = { affiliateId: string; currency: string };
type PaymentMethod = "manual" | "bank_transfer";

function formatAmount(amount: string, currency: string) {
  const value = Number(amount);
  return Number.isFinite(value)
    ? new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value)
    : `${currency} ${amount}`;
}

function formatDate(iso: string | null) {
  return iso
    ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
    : "—";
}

function totalsByCurrency(
  rows: AffiliatePayoutSummary[],
  field: "outstandingAmount" | "paidAmount",
) {
  const totals = new Map<string, number>();
  for (const row of rows)
    totals.set(row.currency, (totals.get(row.currency) ?? 0) + Number(row[field]));
  return Array.from(totals.entries()).map(([currency, amount]) =>
    formatAmount(amount.toFixed(2), currency),
  );
}

export default function AffiliatePayoutsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [summaries, setSummaries] = useState<AffiliatePayoutSummary[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"outstanding" | "all">("outstanding");
  const [selected, setSelected] = useState<Selection | null>(null);

  const fetchList = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setSummaries((await affiliatePayoutsService.list()).summaries);
    } catch (reason) {
      setSummaries([]);
      setError(reason instanceof Error ? reason.message : "Could not load affiliate payouts.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchList();
  }, [fetchList]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return summaries.filter((row) => {
      if (filter === "outstanding" && Number(row.outstandingAmount) <= 0) return false;
      return (
        !query ||
        row.affiliateId.toLowerCase().includes(query) ||
        row.organizationId.toLowerCase().includes(query) ||
        row.currency.toLowerCase().includes(query)
      );
    });
  }, [filter, search, summaries]);

  const outstandingTotals = totalsByCurrency(summaries, "outstandingAmount");
  const paidTotals = totalsByCurrency(summaries, "paidAmount");
  const payableCount = summaries.reduce((total, row) => total + row.payableCount, 0);

  return (
    <div className="max-w-[1400px] p-4 md:p-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Affiliate payouts</h1>
        <p className="mt-1 text-[13px] text-gray-500">
          Review Finance ledger state and record externally completed manual payouts.
        </p>
      </header>

      <div className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-3">
        <Metric label="Outstanding by currency" values={outstandingTotals} fallback="No balance" />
        <Metric label="Eligible payout rows" values={[String(payableCount)]} fallback="0" />
        <Metric label="Paid by currency" values={paidTotals} fallback="No payments" />
      </div>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-2">
          {(["outstanding", "all"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              className={`rounded-full border px-3 py-1.5 text-[12px] font-medium ${
                filter === value
                  ? "border-gray-900 bg-gray-900 text-white"
                  : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
              }`}
            >
              {value === "outstanding" ? "Outstanding only" : "All payout scopes"}
            </button>
          ))}
        </div>
        <input
          aria-label="Search payout scopes"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search affiliate or organization ID"
          className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-[13px] sm:w-80"
        />
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-[13px] text-red-700">
          {error}{" "}
          <button
            type="button"
            onClick={() => void fetchList()}
            className="font-semibold underline"
          >
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <div className="h-64 animate-pulse rounded-xl bg-gray-100" />
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white p-12 text-center text-[13px] text-gray-500">
          No matching payout scopes.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="w-full min-w-[920px] text-[13px]">
            <thead className="border-b border-gray-200 bg-gray-50/80 text-[11px] uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Affiliate resource</th>
                <th className="px-4 py-3 text-left font-medium">Method</th>
                <th className="px-4 py-3 text-right font-medium">Outstanding</th>
                <th className="px-4 py-3 text-right font-medium">Payable now</th>
                <th className="px-4 py-3 text-right font-medium">Paid</th>
                <th className="px-4 py-3 text-left font-medium">Last paid</th>
                <th className="px-4 py-3 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((row) => (
                <tr key={`${row.affiliateId}:${row.currency}`} className="hover:bg-gray-50/50">
                  <td className="px-4 py-3">
                    <p className="font-mono text-[12px] font-medium text-gray-900">
                      {row.affiliateId}
                    </p>
                    <p className="font-mono text-[10px] text-gray-400">{row.organizationId}</p>
                    {row.affiliateLifecycleStatus === "inactive" && (
                      <p className="mt-1 text-[10px] font-medium text-amber-700">
                        Affiliate lifecycle inactive · Finance history retained
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded bg-gray-100 px-2 py-0.5 text-[11px] text-gray-700">
                      {row.payoutMethod}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-gray-900">
                    {formatAmount(row.outstandingAmount, row.currency)}
                    <span className="block text-[10px] font-normal text-gray-400">
                      {row.payoutCount} ledger rows
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-gray-700">
                    {formatAmount(row.payableAmount, row.currency)}
                    <span className="block text-[10px] text-gray-400">
                      {row.payableCount} eligible
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600">
                    {formatAmount(row.paidAmount, row.currency)}
                  </td>
                  <td className="px-4 py-3 text-gray-500">{formatDate(row.lastPaidAt)}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() =>
                        setSelected({ affiliateId: row.affiliateId, currency: row.currency })
                      }
                      className="rounded-lg border border-gray-200 px-3 py-1 text-[12px] font-medium text-gray-700 hover:bg-gray-50"
                    >
                      Details
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <PayoutDetailDrawer
          selection={selected}
          onClose={() => setSelected(null)}
          onPaid={() => {
            setSelected(null);
            void fetchList();
          }}
        />
      )}
    </div>
  );
}

function Metric({
  label,
  values,
  fallback,
}: {
  label: string;
  values: string[];
  fallback: string;
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 md:p-5">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
        {label}
      </p>
      <p className="text-xl font-bold text-gray-900">
        {values.length ? values.join(" · ") : fallback}
      </p>
    </div>
  );
}

function PayoutDetailDrawer({
  selection,
  onClose,
  onPaid,
}: {
  selection: Selection;
  onClose: () => void;
  onPaid: () => void;
}) {
  const [detail, setDetail] = useState<AffiliatePayoutDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError("");
    affiliatePayoutsService
      .get(selection.affiliateId, selection.currency)
      .then((value) => active && setDetail(value))
      .catch((reason) => {
        if (active)
          setLoadError(reason instanceof Error ? reason.message : "Could not load payout detail.");
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [selection]);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="h-full w-full max-w-3xl overflow-y-auto bg-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-100 bg-white px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Affiliate payout detail</h2>
            <p className="mt-0.5 font-mono text-[11px] text-gray-500">
              {selection.affiliateId} · {selection.currency}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close payout detail"
            onClick={onClose}
            className="text-2xl text-gray-400 hover:text-gray-700"
          >
            ×
          </button>
        </header>

        {loading ? (
          <div className="m-6 h-40 animate-pulse rounded-lg bg-gray-100" />
        ) : loadError || !detail ? (
          <div className="m-6 rounded-lg border border-red-200 bg-red-50 p-4 text-[13px] text-red-700">
            {loadError || "Payout detail is unavailable."}
          </div>
        ) : (
          <div className="space-y-6 p-6">
            <section className="rounded-lg border border-gray-200 bg-gray-50 p-4">
              <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <Fact
                  label="Outstanding"
                  value={formatAmount(detail.summary.outstandingAmount, detail.summary.currency)}
                />
                <Fact
                  label="Payable now"
                  value={formatAmount(detail.summary.payableAmount, detail.summary.currency)}
                />
                <Fact label="Eligible rows" value={String(detail.summary.payableCount)} />
                <Fact label="Method" value={detail.summary.payoutMethod} />
              </div>
              {detail.summary.payableCount > 0 && !showForm && (
                <button
                  type="button"
                  onClick={() => setShowForm(true)}
                  className="mt-4 rounded-lg bg-emerald-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-emerald-700"
                >
                  Record external payment
                </button>
              )}
            </section>

            {showForm && (
              <MarkPaidForm detail={detail} onCancel={() => setShowForm(false)} onPaid={onPaid} />
            )}

            <section>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                Payout ledger
              </h3>
              <div className="overflow-x-auto rounded-lg border border-gray-200">
                <table className="w-full min-w-[720px] text-[12px]">
                  <thead className="border-b border-gray-200 bg-gray-50 text-[10px] uppercase text-gray-500">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Payout</th>
                      <th className="px-3 py-2 text-left font-medium">Status</th>
                      <th className="px-3 py-2 text-right font-medium">Amount</th>
                      <th className="px-3 py-2 text-left font-medium">Provider / retry</th>
                      <th className="px-3 py-2 text-left font-medium">Evidence</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {detail.payouts.map((payout) => (
                      <tr key={payout.payoutId}>
                        <td className="px-3 py-2 font-mono text-[10px] text-gray-700">
                          {payout.payoutId}
                        </td>
                        <td className="px-3 py-2 text-gray-700">{payout.payoutStatus}</td>
                        <td className="px-3 py-2 text-right font-semibold text-gray-900">
                          {formatAmount(payout.amount, payout.currency)}
                        </td>
                        <td className="px-3 py-2 text-gray-500">
                          {payout.providerPayoutId || "Not dispatched"} · retry {payout.retryCount}
                        </td>
                        <td className="px-3 py-2 font-mono text-[10px] text-gray-500">
                          {payout.paymentEvidenceId || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {detail.history.length > 0 && (
              <section>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                  Immutable payment history
                </h3>
                <div className="divide-y divide-gray-100 rounded-lg border border-gray-200">
                  {detail.history.map((entry) => (
                    <div key={entry.evidenceId} className="px-4 py-3 text-[12px]">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="font-semibold text-gray-900">
                            {formatAmount(entry.amount, entry.currency)} · {entry.paymentMethod}
                          </p>
                          <p className="text-[11px] text-gray-500">
                            Paid {formatDate(entry.paidAt)} · recorded{" "}
                            {formatDate(entry.recordedAt)}
                          </p>
                        </div>
                        <p className="font-mono text-[10px] text-gray-500">
                          {entry.externalReference}
                        </p>
                      </div>
                      <p className="mt-1 font-mono text-[10px] text-gray-400">
                        Evidence: {entry.evidenceReference}
                      </p>
                      {entry.note && <p className="mt-1 text-[11px] text-gray-500">{entry.note}</p>}
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">{label}</p>
      <p className="mt-1 text-[13px] font-semibold text-gray-900">{value}</p>
    </div>
  );
}

function MarkPaidForm({
  detail,
  onCancel,
  onPaid,
}: {
  detail: AffiliatePayoutDetail;
  onCancel: () => void;
  onPaid: () => void;
}) {
  const [method, setMethod] = useState<PaymentMethod>(
    detail.summary.payoutMethod === "manual" ? "manual" : "bank_transfer",
  );
  const [externalReference, setExternalReference] = useState("");
  const [evidenceReference, setEvidenceReference] = useState("");
  const [paidAt, setPaidAt] = useState(localDateTime(new Date()));
  const [note, setNote] = useState("");
  const [identity, setIdentity] = useState(newCommandIdentity);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const change = <T,>(setter: (value: T) => void, value: T) => {
    setter(value);
    setIdentity(newCommandIdentity());
  };
  const submit = async () => {
    const external = externalReference.trim();
    const evidence = evidenceReference.trim();
    if (!external || !evidence || !paidAt)
      return setError("External reference, evidence reference, and paid time are required.");
    const timestamp = new Date(paidAt);
    if (Number.isNaN(timestamp.valueOf())) return setError("Paid time is invalid.");
    setSubmitting(true);
    setError("");
    try {
      await affiliatePayoutsService.markPaid(detail.summary.affiliateId, {
        ...identity,
        currency: detail.summary.currency,
        payoutIds: detail.payouts
          .filter((payout) => payout.manualMarkPaidEligible)
          .map((payout) => payout.payoutId),
        expectedAmount: detail.summary.payableAmount,
        paymentMethod: method,
        externalReference: external,
        evidenceReference: evidence,
        paidAt: timestamp.toISOString(),
        note: note.trim() || null,
      });
      onPaid();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not record the payout.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="space-y-3 rounded-lg border border-gray-200 p-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
        External payment evidence
      </h3>
      {error && <p className="rounded bg-red-50 p-2 text-[12px] text-red-700">{error}</p>}
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Payment method">
          <select
            value={method}
            onChange={(event) => change(setMethod, event.target.value as PaymentMethod)}
            className={INPUT_CLASS}
          >
            <option value="bank_transfer">Bank transfer</option>
            <option value="manual">Manual</option>
          </select>
        </Field>
        <Field label="Paid at">
          <input
            type="datetime-local"
            value={paidAt}
            onChange={(event) => change(setPaidAt, event.target.value)}
            className={INPUT_CLASS}
          />
        </Field>
        <Field label="External reference">
          <input
            value={externalReference}
            onChange={(event) => change(setExternalReference, event.target.value.trimStart())}
            placeholder="Bank transfer or receipt ID"
            className={INPUT_CLASS}
          />
        </Field>
        <Field label="Evidence reference">
          <input
            value={evidenceReference}
            onChange={(event) => change(setEvidenceReference, event.target.value.trimStart())}
            placeholder="Vault URL or document reference"
            className={INPUT_CLASS}
          />
        </Field>
      </div>
      <Field label="Note (optional)">
        <textarea
          rows={2}
          value={note}
          onChange={(event) => change(setNote, event.target.value.trimStart())}
          className={INPUT_CLASS}
        />
      </Field>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={submitting}
          onClick={onCancel}
          className="rounded-lg border border-gray-200 px-4 py-2 text-[13px] text-gray-700 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={submitting || !externalReference || !evidenceReference}
          onClick={() => void submit()}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
        >
          {submitting
            ? "Recording…"
            : `Confirm ${formatAmount(detail.summary.payableAmount, detail.summary.currency)} paid`}
        </button>
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-[11px] font-semibold uppercase tracking-wider text-gray-500">
      {label}
      <span className="mt-1 block normal-case tracking-normal">{children}</span>
    </label>
  );
}

const INPUT_CLASS =
  "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-normal text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-200";

function newCommandIdentity() {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return {
    commandId: `platform-affiliate-payout-${suffix}`,
    idempotencyKey: `platform-affiliate-payout-${suffix}`,
  };
}

function localDateTime(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
