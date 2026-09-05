"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowPathIcon,
  ChartBarIcon,
  CursorArrowRaysIcon,
  PresentationChartLineIcon,
} from "@heroicons/react/24/outline";
import { HotelIcon } from "@vayada/product-onboarding";
import { BarChart, LineChart } from "@/components/growth-dashboard/Chart";
import { PropertySelector } from "@/components/growth-dashboard/PropertySelector";
import { getGrowthDashboard, Granularity, GrowthDashboard } from "@/services/api/growthDashboard";

const STORAGE_KEY = "vayadaAdminGrowthFilters";

const tabs = [
  { name: "Growth", active: true },
  { name: "Bookings", active: false },
  { name: "Properties", active: false },
];

const granularityOptions: Granularity[] = ["daily", "weekly", "monthly"];

type StoredFilters = {
  selectedIds?: string[];
  excludeTestData?: boolean;
  granularity?: Granularity;
  bookingPropertyId?: string;
};

function isGranularity(value: unknown): value is Granularity {
  return granularityOptions.includes(value as Granularity);
}

function readStoredFilters(): StoredFilters | null {
  const stored = sessionStorage.getItem(STORAGE_KEY);
  if (!stored) return null;

  try {
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;

    return {
      selectedIds: Array.isArray(parsed.selectedIds)
        ? parsed.selectedIds.filter((id): id is string => typeof id === "string")
        : undefined,
      excludeTestData:
        typeof parsed.excludeTestData === "boolean" ? parsed.excludeTestData : undefined,
      granularity: isGranularity(parsed.granularity) ? parsed.granularity : undefined,
      bookingPropertyId:
        typeof parsed.bookingPropertyId === "string" ? parsed.bookingPropertyId : undefined,
    };
  } catch {
    sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

function haveSameIds(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right);
  return left.every((id) => rightIds.has(id));
}

export default function KpiDashboardPage() {
  const [data, setData] = useState<GrowthDashboard | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [excludeTestData, setExcludeTestData] = useState(true);
  const [granularity, setGranularity] = useState<Granularity>("weekly");
  const [bookingPropertyId, setBookingPropertyId] = useState("");
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const hasLoadedDefaults = useRef(false);
  const requestToken = useRef(0);

  useEffect(() => {
    const filters = readStoredFilters();
    if (!filters) return;

    setSelectedIds(filters.selectedIds || []);
    setExcludeTestData(filters.excludeTestData ?? true);
    setGranularity(filters.granularity || "weekly");
    setBookingPropertyId(filters.bookingPropertyId || "");
  }, []);

  useEffect(() => {
    const token = requestToken.current + 1;
    requestToken.current = token;

    async function load() {
      setIsLoading(true);
      setError("");
      try {
        const response = await getGrowthDashboard({
          granularity,
          excludeTestData,
          propertyIds:
            selectedIds.length === 0 && !hasLoadedDefaults.current ? undefined : selectedIds,
          bookingPropertyId: bookingPropertyId || undefined,
        });
        if (requestToken.current !== token) return;

        hasLoadedDefaults.current = true;
        setData(response);
        if (!haveSameIds(selectedIds, response.selectedPropertyIds)) {
          setSelectedIds(response.selectedPropertyIds);
        }
        sessionStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            selectedIds: response.selectedPropertyIds,
            excludeTestData,
            granularity,
            bookingPropertyId: response.bookingPropertyId || "",
          }),
        );
      } catch (err) {
        if (requestToken.current !== token) return;

        if (err instanceof Error && err.message.toLowerCase().includes("staff")) {
          setError("Access denied.");
        } else {
          setError(err instanceof Error ? err.message : "Unable to load dashboard.");
        }
      } finally {
        if (requestToken.current === token) {
          setIsLoading(false);
        }
      }
    }

    load();

    return () => {
      if (requestToken.current === token) {
        requestToken.current += 1;
      }
    };
  }, [bookingPropertyId, excludeTestData, granularity, selectedIds]);

  const liveProperties = useMemo(
    () => data?.properties.filter((property) => property.status === "live") || [],
    [data],
  );
  const selectedPropertiesLabel =
    selectedIds.length === 0
      ? "No properties selected"
      : selectedIds.length === (data?.properties.length || 0)
        ? "All properties"
        : `${selectedIds.length} selected`;

  return (
    <div className="p-4 md:p-8 max-w-[1400px] text-gray-900">
      <div className="mb-5 md:mb-6 flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="mt-1 text-[13px] text-gray-500">
            Growth signals across properties, traffic, and booking demand
          </p>
          <nav className="mt-4 flex flex-wrap gap-2" aria-label="Dashboard views">
            {tabs.map((tab) => (
              <button
                key={tab.name}
                type="button"
                className={`rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors ${
                  tab.active
                    ? "border-gray-900 bg-gray-900 text-white"
                    : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                }`}
              >
                {tab.name}
              </button>
            ))}
          </nav>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
          <button
            type="button"
            onClick={() => setExcludeTestData((value) => !value)}
            aria-pressed={excludeTestData}
            className="flex h-10 items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-3 text-[13px] font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 sm:justify-start"
          >
            <span
              className={`flex h-5 w-9 rounded-full p-0.5 transition-colors ${
                excludeTestData ? "bg-gray-900" : "bg-gray-300"
              }`}
            >
              <span
                className={`block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                  excludeTestData ? "translate-x-4" : ""
                }`}
              />
            </span>
            {excludeTestData ? "Real bookings only" : "Including test data"}
          </button>
          <button
            type="button"
            onClick={() => setSelectorOpen(true)}
            className="flex h-10 items-center justify-between gap-2 rounded-lg border border-gray-200 bg-white px-3 text-[13px] font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 sm:justify-start"
          >
            <span className="flex items-center gap-2">
              <HotelIcon className="h-4 w-4 text-gray-400" aria-hidden="true" />
              Properties
            </span>
            <span className="text-gray-400">{selectedPropertiesLabel}</span>
          </button>
        </div>
      </div>

      <div>
        {error ? (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13px] font-medium text-red-700">
            {error}
          </div>
        ) : null}

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {isLoading && !data
            ? Array.from({ length: 4 }).map((_, index) => <MetricSkeleton key={index} />)
            : (data?.metrics || []).map((metric) => (
                <article
                  key={metric.key}
                  className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
                >
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <p className="text-[13px] font-medium text-gray-500">{metric.label}</p>
                    <MetricIcon metricKey={metric.key} />
                  </div>
                  <p className="text-3xl font-semibold tracking-normal text-gray-900">
                    {isLoading ? "..." : error ? "—" : metric.value}
                  </p>
                  <p className="mt-2 text-[12px] text-gray-500">{metric.delta?.label || ""}</p>
                </article>
              ))}
        </div>

        <section className="mt-4 rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap gap-2">
              {granularityOptions.map((option) => (
                <button
                  type="button"
                  key={option}
                  onClick={() => setGranularity(option)}
                  className={`rounded-full border px-3 py-1.5 text-[12px] font-medium capitalize transition-colors ${
                    granularity === option
                      ? "border-gray-900 bg-gray-900 text-white"
                      : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>
            <select
              value={bookingPropertyId}
              onChange={(event) => setBookingPropertyId(event.target.value)}
              className="h-10 min-w-0 rounded-lg border border-gray-200 bg-white px-3 text-[13px] font-medium text-gray-700 outline-none focus:ring-2 focus:ring-gray-200 sm:min-w-72"
              aria-label="Dashboard property"
            >
              <option value="">All properties</option>
              {liveProperties.map((property) => (
                <option key={property.id} value={property.id}>
                  {property.name}
                </option>
              ))}
            </select>
          </div>
        </section>

        {!isLoading && !error && data?.emptyMessage ? (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] font-medium text-amber-700">
            {data.emptyMessage}
          </div>
        ) : null}

        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          <ChartPanel
            title="Page views"
            subtitle={bookingPropertyId ? "Single property drill-down" : "All selected properties"}
            icon={<PresentationChartLineIcon className="h-5 w-5" aria-hidden="true" />}
          >
            {isLoading ? (
              <ChartLoading />
            ) : (
              <LineChart points={error ? [] : data?.pageViews || []} yLabel="Number of views" />
            )}
          </ChartPanel>
          <ChartPanel
            title="Booking requests"
            subtitle={bookingPropertyId ? "Single property drill-down" : "All properties"}
            icon={<ChartBarIcon className="h-5 w-5" aria-hidden="true" />}
          >
            {isLoading ? (
              <ChartLoading />
            ) : (
              <BarChart
                points={error ? [] : data?.bookingRequests || []}
                yLabel="Number of requests"
              />
            )}
          </ChartPanel>
        </div>

        <div className="mt-4">
          <ChartPanel
            title="Properties going live"
            subtitle="Cumulative live properties"
            icon={<CursorArrowRaysIcon className="h-5 w-5" aria-hidden="true" />}
          >
            <LineChart points={data?.liveProperties || []} tone="brass" />
          </ChartPanel>
        </div>
      </div>

      <PropertySelector
        open={selectorOpen}
        properties={data?.properties || []}
        selectedIds={selectedIds}
        onApply={(ids) => {
          setSelectedIds(ids);
          setSelectorOpen(false);
        }}
        onClose={() => setSelectorOpen(false)}
      />
    </div>
  );
}

function ChartLoading() {
  return (
    <div role="status" className="flex h-[260px] items-center justify-center text-sm text-gray-500">
      Loading chart…
    </div>
  );
}

function MetricIcon({ metricKey }: { metricKey: string }) {
  const className = "h-5 w-5 text-gray-400";
  if (metricKey === "live_properties") return <HotelIcon className={className} />;
  if (metricKey === "page_views") return <PresentationChartLineIcon className={className} />;
  if (metricKey === "booking_requests") return <ChartBarIcon className={className} />;
  return <ArrowPathIcon className={className} />;
}

function MetricSkeleton() {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-5 flex items-center justify-between">
        <div className="h-4 w-28 animate-pulse rounded bg-gray-100" />
        <div className="h-5 w-5 animate-pulse rounded bg-gray-100" />
      </div>
      <div className="h-8 w-20 animate-pulse rounded bg-gray-100" />
      <div className="mt-3 h-3 w-32 animate-pulse rounded bg-gray-100" />
    </div>
  );
}

function ChartPanel({
  title,
  subtitle,
  icon,
  children,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">{title}</h2>
          <p className="mt-0.5 text-[13px] text-gray-500">{subtitle}</p>
        </div>
        <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 bg-gray-50 text-gray-500">
          {icon}
        </div>
      </div>
      {children}
    </section>
  );
}
