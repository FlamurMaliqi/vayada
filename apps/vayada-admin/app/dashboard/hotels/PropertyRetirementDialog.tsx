"use client";

import { useEffect, useState } from "react";

import {
  getPropertyRetirementImpact,
  retireProperty,
  type PlatformPropertyLifecycleResult,
  type PlatformPropertyRetirementImpact,
} from "@/services/api/growthDashboard";

type Props = {
  propertyId: string;
  propertyName: string;
  onCancel: () => void;
  onRetired: (result: PlatformPropertyLifecycleResult) => void;
};

export function PropertyRetirementDialog({ propertyId, propertyName, onCancel, onRetired }: Props) {
  const [impact, setImpact] = useState<PlatformPropertyRetirementImpact | null>(null);
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    getPropertyRetirementImpact(propertyId)
      .then((result) => active && setImpact(result))
      .catch(
        (caught) =>
          active &&
          setError(caught instanceof Error ? caught.message : "Impact could not be loaded."),
      )
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [propertyId]);

  const blocked = Boolean(impact && !impact.canRetire);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="retire-property-title"
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white shadow-xl"
      >
        <div className="border-b border-gray-200 px-6 py-5">
          <h2 id="retire-property-title" className="text-lg font-semibold text-gray-900">
            Retire {propertyName}
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            Public access is removed. Operational and financial history is preserved.
          </p>
        </div>

        <div className="space-y-5 px-6 py-5">
          {loading && <p className="text-sm text-gray-500">Loading current impact…</p>}
          {impact && (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Impact label="Organizations" value={impact.organizations.linked} />
                <Impact
                  label="Entitlements"
                  value={impact.entitlements.active + impact.entitlements.suspended}
                />
                <Impact label="Bookings" value={impact.bookings.total} />
                <Impact label="Rooms" value={impact.inventory.rooms} />
                <Impact label="Payments retained" value={impact.finance.totalPayments} />
                <Impact label="Payments unresolved" value={impact.finance.unresolvedPayments} />
                <Impact label="Payouts retained" value={impact.finance.totalPayouts} />
                <Impact label="Payouts open" value={impact.finance.openPayouts} />
                <Impact label="Billing entitlements" value={impact.finance.billingEntitlements} />
                <Impact label="Media" value={impact.media.objects} />
                <Impact
                  label="Public surfaces"
                  value={
                    Number(impact.publicExposure.marketplaceActive) +
                    Number(impact.publicExposure.bookingRevisionActive) +
                    Number(impact.publicExposure.distributionStatus === "public")
                  }
                />
              </div>

              {impact.blockers.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                  <h3 className="text-sm font-semibold text-amber-900">Retirement is blocked</h3>
                  <ul className="mt-2 space-y-1 text-sm text-amber-800">
                    {impact.blockers.map((blocker) => (
                      <li key={blocker.code}>
                        {blocker.message} ({blocker.count})
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <label className="block text-sm font-medium text-gray-700">
                Reason
                <textarea
                  required
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  rows={3}
                  maxLength={500}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal"
                />
              </label>
              <label className="block text-sm font-medium text-gray-700">
                Type RETIRE to confirm
                <input
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal"
                />
              </label>
            </>
          )}

          {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        </div>

        <div className="flex justify-end gap-3 border-t border-gray-200 px-6 py-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!impact || blocked || !reason.trim() || confirmation !== "RETIRE" || saving}
            onClick={async () => {
              if (!impact) return;
              setSaving(true);
              setError("");
              try {
                onRetired(
                  await retireProperty(propertyId, {
                    expectedLifecycleRevision: impact.lifecycleRevision,
                    reason: reason.trim(),
                  }),
                );
              } catch (caught) {
                setError(caught instanceof Error ? caught.message : "Retirement failed.");
                try {
                  setImpact(await getPropertyRetirementImpact(propertyId));
                } catch {
                  /* keep original command error */
                }
              } finally {
                setSaving(false);
              }
            }}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? "Retiring…" : blocked ? "Resolve blockers first" : "Retire property"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Impact({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-gray-200 p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="mt-1 text-lg font-semibold text-gray-900">{value}</p>
    </div>
  );
}
