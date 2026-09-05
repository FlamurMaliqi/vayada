"use client";

import { useEffect, useRef, useState } from "react";
import {
  SETUP_TRACKS,
  type PlatformMarketplaceAccountsResponse,
  type UpdateTracksRequest,
  type UpdateTracksResponse,
} from "@vayada/domain-hotels";
import { apiClient } from "@/services/api/client";

export function MarketplaceAccountSetup({
  userId,
  propertyId,
  onSelect,
  onActivated,
}: {
  userId: string;
  propertyId?: string;
  onSelect: (propertyId: string) => void;
  onActivated: () => void;
}) {
  const [data, setData] = useState<PlatformMarketplaceAccountsResponse | null>(null);
  const [accountId, setAccountId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const retry = useRef<{ organizationId: string; key: string; body: UpdateTracksRequest } | null>(
    null,
  );
  const base = `/api/platform/admin/users/${encodeURIComponent(userId)}/marketplace-accounts`;
  const account = data?.accounts.find((item) => item.organizationId === accountId);
  const active =
    account?.setup.tracks.find((track) => track.track === "creator_marketplace")?.provisioning ===
    "active";

  async function refresh() {
    const response = await apiClient.get<PlatformMarketplaceAccountsResponse>(base);
    setData(response);
    return response;
  }
  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<PlatformMarketplaceAccountsResponse>(base)
      .then((response) => {
        if (cancelled) return;
        setData(response);
        const matches = response.accounts.filter((item) =>
          item.properties.some((property) => property.propertyId === propertyId),
        );
        const selected =
          matches.length === 1
            ? matches[0]
            : response.accounts.length === 1
              ? response.accounts[0]
              : undefined;
        setAccountId(
          (current) =>
            selected?.organizationId ??
            (response.accounts.some((item) => item.organizationId === current) ? current : ""),
        );
      })
      .catch((failure) => {
        if (!cancelled) setError(failure.message);
      });
    return () => {
      cancelled = true;
    };
  }, [base, propertyId]);

  async function activate() {
    if (!account) return;
    setBusy(true);
    setError("");
    setNotice("");
    retry.current ??= {
      organizationId: account.organizationId,
      key: crypto.randomUUID(),
      body: {
        expectedRevision: account.setup.trackRevision,
        selectedTracks: SETUP_TRACKS.filter(
          (track) =>
            track === "creator_marketplace" || account.setup.selectedTracks.includes(track),
        ),
      },
    };
    try {
      const request = retry.current;
      const result = await apiClient.post<UpdateTracksResponse>(
        `${base}/${request.organizationId}/activate`,
        request.body,
        { headers: { "Idempotency-Key": request.key } },
      );
      const enabled =
        result.tracks.find((track) => track.track === "creator_marketplace")?.provisioning ===
        "active";
      retry.current = null;
      await refresh();
      if (enabled) {
        setNotice("Marketplace enabled. No properties or offers were published.");
        onActivated();
      } else
        setError(
          "Marketplace could not be enabled. Resolve the account’s billing, suspended access, or property ownership restrictions, then retry.",
        );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not enable Marketplace.");
      if ((failure as { status?: number }).status === 409) {
        retry.current = null;
        await refresh().catch(() => {});
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="space-y-3 rounded-lg border border-gray-200 p-4"
      aria-label="Marketplace account setup"
    >
      <h3 className="font-semibold">Marketplace setup</h3>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-green-700">
          {notice}
        </p>
      )}
      {!data ? (
        <p>Loading accounts…</p>
      ) : data.accounts.length === 0 ? (
        <p>No active hotel account found for this user.</p>
      ) : (
        <>
          <label className="block text-sm">
            Hotel account
            <select
              className="mt-1 block w-full rounded border p-2"
              aria-label="Hotel account"
              value={accountId}
              disabled={busy}
              onChange={(event) => {
                setAccountId(event.target.value);
                retry.current = null;
                setError("");
                onSelect("");
              }}
            >
              <option value="">Choose an account</option>
              {data.accounts.map((item) => (
                <option key={item.organizationId} value={item.organizationId}>
                  {item.displayName}
                </option>
              ))}
            </select>
          </label>
          {account && (
            <>
              <p className="text-sm text-gray-600">
                {active
                  ? "Marketplace is enabled for this account."
                  : "Enable Marketplace for this account and its linked properties. Nothing becomes public until an offer is published."}
              </p>
              {!active && (
                <button
                  type="button"
                  className="rounded bg-primary-600 px-4 py-2 text-white disabled:opacity-50"
                  disabled={busy || !data.canActivate}
                  onClick={activate}
                >
                  {busy ? "Enabling…" : "Enable Marketplace"}
                </button>
              )}
              {!active && !data.canActivate && (
                <p className="text-sm">
                  An administrator with property management access must enable Marketplace.
                </p>
              )}
              <label className="block text-sm">
                Property
                <select
                  className="mt-1 block w-full rounded border p-2"
                  aria-label="Property"
                  value={propertyId ?? ""}
                  disabled={busy}
                  onChange={(event) => onSelect(event.target.value)}
                >
                  <option value="">Choose a property</option>
                  {account.properties.map((property) => (
                    <option key={property.propertyId} value={property.propertyId}>
                      {property.displayName}
                    </option>
                  ))}
                </select>
              </label>
              {account.properties.length === 0 && (
                <p className="text-sm">This account has no available properties.</p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
