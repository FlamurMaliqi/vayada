"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import { AffiliateWorkspace, affiliateName } from "@/components/affiliates/AffiliateWorkspace";
import {
  affiliatesService,
  type AffiliateDetail,
  type AffiliateLifecycleAction,
  type AffiliateLifecycleStatus,
  type AffiliateListResponse,
} from "@/services/affiliates";

export default function AffiliatesPage() {
  const [applications, setApplications] = useState<AffiliateListResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AffiliateDetail | null>(null);
  const [status, setStatus] = useState<"" | AffiliateLifecycleStatus>("");
  const [offset, setOffset] = useState(0);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [defaultDraft, setDefaultDraft] = useState("");
  const [overrideDraft, setOverrideDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [commissionError, setCommissionError] = useState<string | null>(null);
  const [defaultAvailable, setDefaultAvailable] = useState<boolean | null>(null);
  const selectedIdRef = useRef(selectedId);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const loadApplications = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await affiliatesService.list({
        ...(status ? { status } : {}),
        ...(search ? { search } : {}),
        limit: 50,
        offset,
      });
      setApplications(result);
      setSelectedId((current) =>
        current && result.affiliates.some((item) => item.affiliateId === current)
          ? current
          : (result.affiliates[0]?.affiliateId ?? null),
      );
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setLoading(false);
    }
  }, [offset, search, status]);

  useEffect(() => {
    void loadApplications();
  }, [loadApplications]);

  useEffect(() => {
    affiliatesService
      .getDefaultCommission()
      .then((commission) => {
        setDefaultDraft(commission.defaultPercentageRate);
        setDefaultAvailable(true);
      })
      .catch((nextError) => {
        setDefaultAvailable(false);
        setError(errorMessage(nextError));
      });
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let active = true;
    setDetail(null);
    setDetailError(null);
    setCommissionError(null);
    void (async () => {
      try {
        const affiliate = await affiliatesService.get(selectedId);
        if (!active) return;
        setDetail({ affiliate, commission: null });
        try {
          const commission = await affiliatesService.getCommission(selectedId);
          if (!active) return;
          setDetail({ affiliate, commission });
          setOverrideDraft(commission.overridePercentageRate ?? "");
        } catch (nextError) {
          if (active) setCommissionError(errorMessage(nextError));
        }
      } catch (nextError) {
        if (active) setDetailError(errorMessage(nextError));
      }
    })();
    return () => {
      active = false;
    };
  }, [selectedId]);

  const handleSearch = (event: FormEvent) => {
    event.preventDefault();
    setOffset(0);
    setSearch(searchDraft.trim());
  };

  const handleLifecycle = async (action: AffiliateLifecycleAction) => {
    if (
      !detail ||
      ((action === "reject" || action === "suspend") && !window.confirm(confirmCopy(action)))
    )
      return;
    const affiliateId = detail.affiliate.affiliateId;
    setBusy(action);
    setError(null);
    try {
      const result = await affiliatesService.updateStatus(affiliateId, action);
      setDetail((current) =>
        current?.affiliate.affiliateId === affiliateId
          ? { ...current, affiliate: result.affiliate }
          : current,
      );
      setNotice(`${affiliateName(result.affiliate)} ${pastTense(action)}.`);
      await loadApplications();
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  };

  const saveDefault = async () => {
    if (!validRate(defaultDraft)) return setError("Enter a percentage from 0 to 100.");
    setBusy("default");
    setError(null);
    try {
      const result = await affiliatesService.updateDefaultCommission(defaultDraft.trim());
      setDefaultDraft(result.commission.defaultPercentageRate);
      setNotice("Default affiliate commission saved.");
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  };

  const saveOverride = async (inherit = false) => {
    if (!detail?.commission) return;
    if (!inherit && !validRate(overrideDraft)) return setError("Enter a percentage from 0 to 100.");
    const affiliateId = detail.affiliate.affiliateId;
    setBusy("commission");
    setError(null);
    try {
      const result = await affiliatesService.updateCommission(
        affiliateId,
        inherit ? null : overrideDraft.trim(),
      );
      setDetail((current) =>
        current?.affiliate.affiliateId === affiliateId
          ? { ...current, commission: result.commission }
          : current,
      );
      if (selectedIdRef.current === affiliateId) {
        setOverrideDraft(result.commission.overridePercentageRate ?? "");
      }
      setNotice(inherit ? "Affiliate now uses the property default." : "Affiliate override saved.");
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4 md:p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary-600">
            Direct growth
          </p>
          <h1 className="mt-1 text-xl font-bold text-gray-900 md:text-2xl">
            Affiliate applications
          </h1>
          <p className="mt-1 text-[13px] text-gray-500">
            Review access and set referral commission rates for this property.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadApplications()}
          disabled={loading}
          className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-gray-200 bg-white px-3 text-[13px] font-medium text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-50"
        >
          <ArrowPathIcon className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </header>

      {(error || notice) && (
        <div
          role={error ? "alert" : "status"}
          className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px] ${error ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}
        >
          {error ? (
            <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <CheckCircleIcon className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <span>{error ?? notice}</span>
        </div>
      )}

      <section
        className="rounded-lg border border-gray-200 bg-white p-3 md:p-4"
        aria-label="Default commission"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Property default</h2>
            <p className="mt-1 text-xs text-gray-500">
              New and inherited affiliate rates use this percentage.
            </p>
          </div>
          {defaultAvailable ? (
            <div className="flex items-end gap-2">
              <label className="text-xs font-medium text-gray-600">
                Commission %
                <input
                  aria-label="Default commission percentage"
                  value={defaultDraft}
                  onChange={(event) => setDefaultDraft(event.target.value)}
                  inputMode="decimal"
                  className="mt-1 h-9 w-28 rounded-md border border-gray-200 px-3 text-sm text-gray-900 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-100"
                />
              </label>
              <button
                type="button"
                onClick={() => void saveDefault()}
                disabled={busy === "default"}
                className="h-9 rounded-md bg-gray-900 px-4 text-[13px] font-medium text-white hover:bg-gray-800 disabled:opacity-50"
              >
                Save default
              </button>
            </div>
          ) : (
            <p className="text-xs text-gray-500">Finance access is required to change this rate.</p>
          )}
        </div>
      </section>

      <AffiliateWorkspace
        applications={applications}
        selectedId={selectedId}
        detail={detail}
        status={status}
        searchDraft={searchDraft}
        overrideDraft={overrideDraft}
        loading={loading}
        busy={busy}
        detailError={detailError}
        commissionError={commissionError}
        offset={offset}
        onSearchDraftChange={setSearchDraft}
        onSearch={handleSearch}
        onStatusChange={(value) => {
          setOffset(0);
          setStatus(value);
        }}
        onSelect={setSelectedId}
        onPreviousPage={() => setOffset((current) => Math.max(0, current - 50))}
        onNextPage={() => setOffset((current) => current + 50)}
        onOverrideChange={setOverrideDraft}
        onLifecycle={handleLifecycle}
        onSaveOverride={saveOverride}
      />
    </div>
  );
}
function confirmCopy(action: AffiliateLifecycleAction) {
  return action === "reject"
    ? "Reject this affiliate application?"
    : "Suspend this affiliate's access?";
}
function pastTense(action: AffiliateLifecycleAction) {
  return action === "approve"
    ? "approved"
    : action === "reject"
      ? "rejected"
      : action === "suspend"
        ? "suspended"
        : "restored";
}
function validRate(value: string) {
  const normalized = value.trim();
  return /^\d+(?:\.\d{1,4})?$/.test(normalized) && Number(normalized) <= 100;
}
function errorMessage(error: unknown) {
  if (typeof error === "object" && error && "data" in error) {
    const code = (error as { data?: { code?: string } }).data?.code;
    if (code === "missing_permission")
      return "Your role cannot manage affiliates for this property.";
    if (code === "missing_entitlement" || code === "inactive_entitlement")
      return "Affiliate management requires active Booking or Finance access.";
    if (code === "missing_resource_access") return "You do not have access to this property.";
  }
  return error instanceof Error ? error.message : "Affiliate management is unavailable.";
}
