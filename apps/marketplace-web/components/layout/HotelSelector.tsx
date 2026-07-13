"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckIcon, ChevronDownIcon, PlusIcon } from "@heroicons/react/24/outline";
import type { SharedSetupProperty } from "@vayada/product-onboarding";

import { ROUTES } from "@/lib/constants";
import { SELECTED_SHARED_PROPERTY_ID_KEY } from "@/lib/utils/sharedSetupGuard";
import { sharedHotelSetupApi } from "@/services/api/sharedHotelSetupClient";

export function HotelSelector() {
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [properties, setProperties] = useState<SharedSetupProperty[]>([]);
  const [selectedPropertyId, setSelectedPropertyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void sharedHotelSetupApi
      .getStatus({ entryProduct: "marketplace" })
      .then((status) => {
        if (cancelled) return;
        const storedPropertyId = localStorage.getItem(SELECTED_SHARED_PROPERTY_ID_KEY)?.trim();
        const selected =
          status.properties.find((property) => property.propertyId === storedPropertyId) ??
          status.properties.find(
            (property) => property.propertyId === status.selection.selectedPropertyId,
          ) ??
          status.properties[0] ??
          null;
        setProperties(status.properties);
        setSelectedPropertyId(selected?.propertyId ?? null);
        if (selected) {
          localStorage.setItem(SELECTED_SHARED_PROPERTY_ID_KEY, selected.propertyId);
        }
      })
      .catch(() => {
        // The page-level setup guard owns errors and redirects.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const selectedProperty =
    properties.find((property) => property.propertyId === selectedPropertyId) ?? null;

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex max-w-[180px] items-center gap-1 text-[13px] text-gray-700 transition-colors hover:text-gray-950 sm:max-w-[240px]"
        title={selectedProperty?.displayName ?? undefined}
      >
        <span className="truncate font-medium">
          {selectedProperty?.displayName ?? "Select hotel"}
        </span>
        <ChevronDownIcon
          className={`h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-2 w-64 rounded-lg border border-gray-200 bg-white py-1.5 shadow-lg">
          <p className="px-3 py-1.5 text-xs text-gray-500">Switch hotel</p>
          <div className="max-h-64 overflow-y-auto px-1.5">
            {properties.map((property) => {
              const selected = property.propertyId === selectedPropertyId;
              return (
                <button
                  key={property.propertyId}
                  type="button"
                  onClick={() => {
                    localStorage.setItem(SELECTED_SHARED_PROPERTY_ID_KEY, property.propertyId);
                    setSelectedPropertyId(property.propertyId);
                    setOpen(false);
                    window.location.reload();
                  }}
                  className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors ${
                    selected ? "bg-gray-100" : "hover:bg-gray-50"
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold text-gray-900">
                      {property.displayName ?? "Unnamed hotel"}
                    </span>
                    {property.locationSummary && (
                      <span className="block truncate text-[11px] text-gray-500">
                        {property.locationSummary}
                      </span>
                    )}
                  </span>
                  {selected && <CheckIcon className="h-4 w-4 shrink-0 text-primary-600" />}
                </button>
              );
            })}
          </div>
          <div className="mt-1 border-t border-gray-100 px-1.5 pt-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                router.push(`${ROUTES.SETUP}?mode=add&entryProduct=marketplace`);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-[13px] text-primary-600 transition-colors hover:bg-primary-50"
            >
              <PlusIcon className="h-4 w-4" aria-hidden="true" />
              Add hotel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
