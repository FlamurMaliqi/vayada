"use client";

import { useState } from "react";

import { provisionProperty } from "@/services/api/growthDashboard";

type Props = {
  accountUserId: string;
  accountName: string;
  accountEmail: string;
  onCancel: () => void;
  onProvisioned: (propertyId: string) => void;
};

export function PropertyProvisionDialog({
  accountUserId,
  accountName,
  accountEmail,
  onCancel,
  onProvisioned,
}: Props) {
  const [form, setForm] = useState({
    displayName: accountName,
    propertyType: "hotel",
    streetAddress: "",
    postalCode: "",
    city: "",
    countryCode: "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Athens",
    email: accountEmail,
    phone: "",
    reason: "",
  });
  const provisioningReference = `platform-admin:account:${accountUserId}`;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const set = (key: keyof typeof form, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="provision-property-title"
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white shadow-xl"
      >
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setSaving(true);
            setError("");
            try {
              const result = await provisionProperty({
                accountUserId,
                provisioningReference,
                reason: form.reason,
                profile: {
                  displayName: form.displayName,
                  propertyType: form.propertyType,
                  location: {
                    streetAddress: form.streetAddress,
                    postalCode: form.postalCode,
                    city: form.city,
                    countryCode: form.countryCode.toUpperCase(),
                    timezone: form.timezone,
                    latitude: null,
                    longitude: null,
                    localityPublic: true,
                    geoPublic: false,
                    mapDisplayMode: "approximate",
                  },
                  contacts: [
                    {
                      channelType: "email",
                      value: form.email,
                      purpose: "general",
                      isPublic: true,
                    },
                    {
                      channelType: "phone",
                      value: form.phone,
                      purpose: "operations",
                      isPublic: false,
                    },
                  ],
                },
              });
              onProvisioned(result.propertyId);
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : "Property provisioning failed.");
            } finally {
              setSaving(false);
            }
          }}
        >
          <div className="border-b border-gray-200 px-6 py-5">
            <h2 id="provision-property-title" className="text-lg font-semibold text-gray-900">
              Provision property
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              Create the canonical property for {accountEmail}. Product access follows the
              account&apos;s setup tracks and entitlements.
            </p>
          </div>

          <div className="grid gap-4 px-6 py-5 sm:grid-cols-2">
            <Field
              label="Property name"
              value={form.displayName}
              onChange={(v) => set("displayName", v)}
            />
            <label className="text-sm font-medium text-gray-700">
              Property type
              <select
                value={form.propertyType}
                onChange={(event) => set("propertyType", event.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal"
              >
                <option value="hotel">Hotel</option>
                <option value="resort">Resort</option>
                <option value="hostel">Hostel</option>
                <option value="apartment">Apartment</option>
                <option value="villa">Villa</option>
                <option value="other">Other</option>
              </select>
            </label>
            <div className="sm:col-span-2">
              <Field
                label="Street address"
                value={form.streetAddress}
                onChange={(v) => set("streetAddress", v)}
              />
            </div>
            <Field
              label="Postal code"
              value={form.postalCode}
              onChange={(v) => set("postalCode", v)}
            />
            <Field label="City" value={form.city} onChange={(v) => set("city", v)} />
            <Field
              label="Country code"
              value={form.countryCode}
              onChange={(v) => set("countryCode", v.slice(0, 2))}
              placeholder="GR"
            />
            <Field
              label="IANA timezone"
              value={form.timezone}
              onChange={(v) => set("timezone", v)}
              placeholder="Europe/Athens"
            />
            <Field
              label="Public email"
              type="email"
              value={form.email}
              onChange={(v) => set("email", v)}
            />
            <Field
              label="Operations phone"
              type="tel"
              value={form.phone}
              onChange={(v) => set("phone", v)}
            />
            <div className="sm:col-span-2">
              <Field
                label="Provisioning reason"
                value={form.reason}
                onChange={(v) => set("reason", v)}
              />
            </div>
          </div>

          {error && (
            <p className="mx-6 mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>
          )}

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
              type="submit"
              disabled={saving}
              className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {saving ? "Provisioning…" : "Provision property"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <label className="block text-sm font-medium text-gray-700">
      {label}
      <input
        required
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal"
      />
    </label>
  );
}
