"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  MagnifyingGlassIcon,
  ArrowTopRightOnSquareIcon,
  ArchiveBoxXMarkIcon,
} from "@heroicons/react/24/outline";
import { bookingSettingsService } from "@/services/booking";
import { usersService } from "@/services/api";
import {
  updatePropertyStatus,
  type PlatformPropertyLifecycleResult,
  type PlatformPropertyLifecycleStatus,
} from "@/services/api/growthDashboard";
import { PropertyProvisionDialog } from "./PropertyProvisionDialog";
import { PropertyRetirementDialog } from "./PropertyRetirementDialog";

const BOOKING_URL_TEMPLATE =
  process.env.NEXT_PUBLIC_BOOKING_URL_TEMPLATE || "https://{slug}.booking.vayada.com";

interface HotelRow {
  id: string;
  name: string;
  slug: string;
  location: string;
  country: string;
  owner_name: string;
  owner_email: string;
  /** Account user ID — present when no canonical property is bound yet. */
  marketplace_user_id?: string;
  /** True when the canonical property already exists. */
  initialized: boolean;
  lifecycle_status?: PlatformPropertyLifecycleStatus;
  lifecycle_revision?: number;
  owner_account_user_ids?: string[];
}

export default function HotelsPage() {
  const router = useRouter();
  const [hotels, setHotels] = useState<HotelRow[]>([]);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [provisioningRow, setProvisioningRow] = useState<HotelRow | null>(null);
  const [retirementRow, setRetirementRow] = useState<HotelRow | null>(null);
  const [transitioningId, setTransitioningId] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    loadHotels(debouncedSearch);
  }, [debouncedSearch]);

  const loadHotels = async (searchTerm: string) => {
    try {
      setLoading(true);
      setError("");

      const marketplaceParams: {
        type: "hotel";
        page: number;
        page_size: number;
        search?: string;
      } = { type: "hotel", page: 1, page_size: 100 };
      if (searchTerm) marketplaceParams.search = searchTerm;

      // Fetch both sources in parallel
      const [bookingHotels, marketplaceRes] = await Promise.all([
        bookingSettingsService.listAllHotels(),
        usersService.getAllUsers(marketplaceParams),
      ]);

      const initializedAccountIds = new Set(
        bookingHotels.flatMap((hotel) => hotel.owner_account_user_ids),
      );

      // Start with every canonical property already provisioned.
      const rows: HotelRow[] = bookingHotels.map((h) => ({
        ...h,
        initialized: true,
      }));

      // Add hotel accounts that are not yet bound to a canonical property.
      for (const user of marketplaceRes.users || []) {
        if (!initializedAccountIds.has(user.id)) {
          rows.push({
            id: user.id,
            name: user.name,
            slug: "",
            location: "",
            country: "",
            owner_name: user.name,
            owner_email: user.email,
            marketplace_user_id: user.id,
            initialized: false,
          });
        }
      }

      setHotels(rows);
    } catch (err) {
      console.error("Failed to load hotels:", err);
      setHotels([]);
      setError(
        "Failed to load canonical property bindings. Provisioning is disabled until the read succeeds.",
      );
    } finally {
      setLoading(false);
    }
  };

  const applyLifecycleResult = (result: PlatformPropertyLifecycleResult) => {
    setHotels((current) =>
      current.map((hotel) =>
        hotel.id === result.propertyId
          ? {
              ...hotel,
              lifecycle_status: result.lifecycleStatus,
              lifecycle_revision: result.lifecycleRevision,
            }
          : hotel,
      ),
    );
  };

  const handleTransition = async (row: HotelRow) => {
    if (!row.lifecycle_status || !row.lifecycle_revision) return;
    const targetStatus = nextStatus(row.lifecycle_status);
    const reason = window.prompt(
      `Reason for moving "${row.name}" to ${targetStatus}:`,
      targetStatus === "suspended"
        ? "Platform admin safety hold"
        : "Platform admin review complete",
    );
    if (!reason?.trim()) return;
    try {
      setTransitioningId(row.id);
      setError("");
      applyLifecycleResult(
        await updatePropertyStatus(row.id, {
          expectedLifecycleRevision: row.lifecycle_revision,
          status: targetStatus,
          reason: reason.trim(),
        }),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Property status could not be changed.");
    } finally {
      setTransitioningId(null);
    }
  };

  const filtered = hotels.filter((h) => {
    const q = search.toLowerCase();
    return (
      h.name.toLowerCase().includes(q) ||
      (h.location || "").toLowerCase().includes(q) ||
      h.owner_name.toLowerCase().includes(q) ||
      h.owner_email.toLowerCase().includes(q)
    );
  });

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="px-6 py-4">
          <h1 className="text-xl font-bold text-gray-900">Hotels</h1>
          <p className="text-sm text-gray-500">Browse and configure hotel booking engines</p>
        </div>
      </header>

      <div className="px-4 sm:px-6 lg:px-8 py-8 max-w-7xl mx-auto">
        {/* Search */}
        <div className="mb-6 bg-white p-4 rounded-lg shadow">
          <div className="relative">
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
            <input
              type="text"
              placeholder="Search by hotel name, location, owner..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent placeholder-gray-400"
            />
          </div>
        </div>

        {error && (
          <div className="mb-6 bg-yellow-50 border border-yellow-200 rounded-lg p-4">
            <p className="text-sm text-yellow-800">{error}</p>
          </div>
        )}

        {/* Table */}
        {loading ? (
          <div className="text-center py-12 bg-white rounded-lg shadow">
            <p className="text-gray-600">Loading hotels...</p>
          </div>
        ) : hotels.length === 0 && !error ? (
          <div className="text-center py-12 bg-white rounded-lg shadow">
            <h3 className="mt-2 text-sm font-medium text-gray-900">No hotels found</h3>
            <p className="mt-1 text-sm text-gray-500">
              No hotels are registered on the platform yet.
            </p>
          </div>
        ) : (
          <>
            <div className="bg-white shadow overflow-x-auto sm:rounded-lg">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Hotel
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Location
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Owner
                    </th>
                    <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Status
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-6 py-8 text-center text-sm text-gray-500">
                        {search ? "No hotels match your search." : "No hotels found."}
                      </td>
                    </tr>
                  ) : (
                    filtered.map((hotel) => (
                      <tr key={hotel.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-6 py-4">
                          <p className="text-sm font-medium text-gray-900">{hotel.name}</p>
                          {hotel.slug && <p className="text-xs text-gray-500">{hotel.slug}</p>}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {hotel.location || hotel.country ? (
                            `${hotel.location}${hotel.country ? `, ${hotel.country}` : ""}`
                          ) : (
                            <span className="text-gray-400">-</span>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          <p className="text-sm text-gray-900">{hotel.owner_name}</p>
                          <p className="text-xs text-gray-500">{hotel.owner_email}</p>
                        </td>
                        <td className="px-6 py-4 text-center">
                          {hotel.lifecycle_status ? (
                            <span
                              className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${statusStyle(hotel.lifecycle_status)}`}
                            >
                              {lifecycleLabel(hotel.lifecycle_status)}
                            </span>
                          ) : (
                            <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-gray-100 text-gray-600">
                              Not set up
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-right whitespace-nowrap space-x-2">
                          {hotel.initialized ? (
                            <>
                              {hotel.slug && hotel.lifecycle_status === "active" && (
                                <a
                                  href={BOOKING_URL_TEMPLATE.replace("{slug}", hotel.slug)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-50 border border-gray-200 rounded-md hover:bg-gray-100 transition-colors"
                                >
                                  Preview
                                  <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" />
                                </a>
                              )}
                              <button
                                onClick={() => router.push(`/dashboard/hotels/${hotel.id}`)}
                                className="inline-flex items-center px-3 py-1.5 text-xs font-medium text-primary-600 bg-primary-50 border border-primary-200 rounded-md hover:bg-primary-100 transition-colors"
                              >
                                Configure
                              </button>
                              {hotel.lifecycle_status && (
                                <button
                                  onClick={() => handleTransition(hotel)}
                                  disabled={transitioningId === hotel.id}
                                  className="inline-flex items-center px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors disabled:opacity-50"
                                >
                                  {transitioningId === hotel.id
                                    ? "Updating…"
                                    : transitionLabel(hotel.lifecycle_status)}
                                </button>
                              )}
                              {hotel.lifecycle_status !== "retired" && (
                                <button
                                  onClick={() => setRetirementRow(hotel)}
                                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-md hover:bg-red-100 transition-colors"
                                >
                                  <ArchiveBoxXMarkIcon className="w-3.5 h-3.5" />
                                  Retire
                                </button>
                              )}
                            </>
                          ) : (
                            <button
                              onClick={() => setProvisioningRow(hotel)}
                              className="inline-flex items-center px-3 py-1.5 text-xs font-medium text-white bg-primary-600 border border-primary-600 rounded-md hover:bg-primary-700 transition-colors disabled:opacity-50"
                            >
                              Set Up
                            </button>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <p className="mt-3 text-xs text-gray-400">
              {filtered.length} of {hotels.length} hotels
            </p>
          </>
        )}
      </div>
      {provisioningRow?.marketplace_user_id && (
        <PropertyProvisionDialog
          accountUserId={provisioningRow.marketplace_user_id}
          accountName={provisioningRow.name}
          accountEmail={provisioningRow.owner_email}
          onCancel={() => setProvisioningRow(null)}
          onProvisioned={(propertyId) => {
            setProvisioningRow(null);
            router.push(`/dashboard/hotels/${propertyId}`);
          }}
        />
      )}
      {retirementRow && (
        <PropertyRetirementDialog
          propertyId={retirementRow.id}
          propertyName={retirementRow.name}
          onCancel={() => setRetirementRow(null)}
          onRetired={(result) => {
            applyLifecycleResult(result);
            setRetirementRow(null);
          }}
        />
      )}
    </div>
  );
}

function nextStatus(status: PlatformPropertyLifecycleStatus): "active" | "suspended" {
  return status === "active" || status === "retired" ? "suspended" : "active";
}

function transitionLabel(status: PlatformPropertyLifecycleStatus): string {
  if (status === "active") return "Suspend";
  if (status === "retired") return "Restore to review";
  return "Activate";
}

function lifecycleLabel(status: PlatformPropertyLifecycleStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function statusStyle(status: PlatformPropertyLifecycleStatus): string {
  if (status === "active") return "bg-green-100 text-green-800";
  if (status === "retired") return "bg-red-100 text-red-800";
  if (status === "suspended") return "bg-amber-100 text-amber-800";
  return "bg-blue-100 text-blue-800";
}
