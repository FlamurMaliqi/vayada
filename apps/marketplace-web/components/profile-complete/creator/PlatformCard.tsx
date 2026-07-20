"use client";

import { Input } from "@/components/ui";
import { CheckCircleIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import type {
  CreatorPlatformConnection,
  CreatorPlatformProvider,
  PlatformFormData,
} from "@/lib/types";
import { PlatformDemographics } from "./PlatformDemographics";

interface PlatformCardProps {
  platformName: string;
  platforms: PlatformFormData[];
  allPlatforms: PlatformFormData[];
  expandedPlatforms: Set<number>;
  platformCountryInputs: Record<number, string>;
  connections: CreatorPlatformConnection[];
  disabled: boolean;
  connectingPlatform: CreatorPlatformProvider | null;
  busyConnectionId: string | null;
  onAddPlatform: (name: string) => void;
  onConnectPlatform: (platform: CreatorPlatformProvider, platformId?: string) => void;
  onSyncConnection: (connectionId: string) => void;
  onDisconnectConnection: (connectionId: string) => void;
  onRemovePlatform: (index: number) => void;
  onUpdatePlatform: (
    index: number,
    field: keyof PlatformFormData,
    value: PlatformFormData[keyof PlatformFormData],
  ) => void;
  onTogglePlatformExpanded: (index: number) => void;
  onCountryInputChange: (platformIndex: number, value: string) => void;
  onAddCountry: (platformIndex: number, country?: string) => void;
  onRemoveCountry: (platformIndex: number, countryIndex: number) => void;
  onUpdateCountryPercentage: (
    platformIndex: number,
    countryIndex: number,
    percentage: number,
  ) => void;
  onToggleAgeGroup: (platformIndex: number, ageRange: string) => void;
  onUpdateGenderSplit: (platformIndex: number, field: "male" | "female", value: string) => void;
  getAvailableCountries: (platformIndex: number) => string[];
}

const platformColors: Record<string, string> = {
  Instagram: "from-yellow-400 via-pink-500 to-purple-600",
  TikTok: "from-gray-900 to-gray-800",
  YouTube: "from-red-600 to-red-500",
  Facebook: "from-blue-600 to-blue-500",
};

function PlatformIcon({ name }: { name: string }) {
  if (name === "Instagram") {
    return (
      <svg
        className="h-6 w-6 text-white"
        fill="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zM5.838 12a6.162 6.162 0 1 1 12.324 0 6.162 6.162 0 0 1-12.324 0zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm4.965-10.322a1.44 1.44 0 1 1 2.881.001 1.44 1.44 0 0 1-2.881-.001z" />
      </svg>
    );
  }
  if (name === "TikTok") {
    return (
      <svg
        className="h-6 w-6 text-white"
        fill="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.1 1.75 2.9 2.9 0 0 1 2.31-4.64 2.88 2.88 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-.96-.1z" />
      </svg>
    );
  }
  if (name === "YouTube") {
    return (
      <svg
        className="h-6 w-6 text-white"
        fill="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
      </svg>
    );
  }
  return (
    <svg className="h-6 w-6 text-white" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
    </svg>
  );
}

export function PlatformCard({
  platformName,
  platforms,
  allPlatforms,
  expandedPlatforms,
  platformCountryInputs,
  connections,
  disabled,
  connectingPlatform,
  busyConnectionId,
  onAddPlatform,
  onConnectPlatform,
  onSyncConnection,
  onDisconnectConnection,
  onRemovePlatform,
  onUpdatePlatform,
  onTogglePlatformExpanded,
  onCountryInputChange,
  onAddCountry,
  onRemoveCountry,
  onUpdateCountryPercentage,
  onToggleAgeGroup,
  onUpdateGenderSplit,
  getAvailableCountries,
}: PlatformCardProps) {
  // Get all platforms of this type
  const platformsOfThisType = platforms.filter((p) => p.name === platformName);
  const hasPlatforms = platformsOfThisType.length > 0;
  const provider = platformName.toLowerCase() as CreatorPlatformProvider;
  const isConnecting = connectingPlatform === provider;

  return (
    <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white transition-colors hover:border-primary-200">
      {/* Platform Header */}
      <div className="flex items-center justify-between gap-3 p-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div
            className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white ${platformColors[platformName] || "from-gray-500 to-gray-400"}`}
          >
            <PlatformIcon name={platformName} />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-gray-950">{platformName}</p>
            {hasPlatforms && (
              <p className="mt-0.5 text-xs text-gray-500">
                {platformsOfThisType.length}{" "}
                {platformsOfThisType.length === 1 ? "account" : "accounts"} added
              </p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <button
            type="button"
            onClick={() => onAddPlatform(platformName)}
            disabled={disabled}
            aria-label={`Enter ${platformName} account manually`}
            className="rounded-full px-2.5 py-1.5 text-xs font-semibold text-gray-600 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-300 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Enter manually
          </button>
          <button
            type="button"
            onClick={() => onConnectPlatform(provider)}
            disabled={disabled || isConnecting}
            aria-label={`${hasPlatforms ? "Connect another" : "Connect"} ${platformName} account`}
            className="rounded-full border border-primary-200 px-3 py-1.5 text-xs font-semibold text-primary-700 transition-colors hover:bg-primary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 disabled:cursor-wait disabled:opacity-60"
          >
            {isConnecting ? "Opening…" : hasPlatforms ? "Connect another" : "Connect"}
          </button>
        </div>
      </div>

      {/* Show all platforms of this type */}
      {platformsOfThisType.length > 0 && (
        <div className="divide-y divide-gray-100 border-t border-gray-100 bg-gray-50/50">
          {platformsOfThisType.map((platform, idx) => {
            // Find the actual index in allPlatforms
            const allIndices = allPlatforms
              .map((p, i) => (p.name === platformName ? i : -1))
              .filter((i) => i !== -1);
            const actualIndex = allIndices[idx];
            const connection = connections.find(
              (candidate) => candidate.platformId === platform.id,
            );
            const connectionBusy = connection?.connectionId === busyConnectionId;
            const importedFields = new Set(connection?.importedFields ?? []);
            const unavailableManualFields =
              connection?.unavailableFields.filter(({ field }) =>
                [
                  "followerCount",
                  "engagementRate",
                  "audienceCountries",
                  "audienceAgeGroups",
                  "audienceGenderSplit",
                ].includes(field),
              ) ?? [];

            return (
              <div key={platform.id ?? `${platformName}-${idx}`} className="px-3 pb-4 pt-3 sm:px-4">
                {/* Account Header */}
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-gray-900">
                        {platform.handle || `Account ${idx + 1}`}
                      </p>
                      {connection && <ConnectionBadge status={connection.status} />}
                    </div>
                    {platform.handle && platform.followers && (
                      <p className="mt-0.5 text-xs text-gray-500">{platform.followers} followers</p>
                    )}
                    {connection?.lastSuccessfulSyncAt && (
                      <p className="mt-0.5 text-xs text-gray-500">
                        Synced {formatSyncDate(connection.lastSuccessfulSyncAt)}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                    {connection?.status === "active" && (
                      <button
                        type="button"
                        onClick={() => onSyncConnection(connection.connectionId)}
                        disabled={disabled || connectionBusy}
                        className="rounded-full border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-wait disabled:opacity-60"
                      >
                        {connectionBusy ? "Syncing…" : "Sync"}
                      </button>
                    )}
                    {connection && connection.status !== "active" && (
                      <button
                        type="button"
                        onClick={() => onConnectPlatform(provider, platform.id ?? undefined)}
                        disabled={disabled || isConnecting}
                        className="rounded-full border border-primary-200 px-3 py-1.5 text-xs font-semibold text-primary-700 transition-colors hover:bg-primary-50 disabled:cursor-wait disabled:opacity-60"
                      >
                        Reconnect
                      </button>
                    )}
                    {!connection && platform.id && (
                      <button
                        type="button"
                        onClick={() => onConnectPlatform(provider, platform.id ?? undefined)}
                        disabled={disabled || isConnecting}
                        aria-label={`Connect saved ${platform.handle || `account ${idx + 1}`} ${platformName} account`}
                        className="rounded-full border border-primary-200 px-3 py-1.5 text-xs font-semibold text-primary-700 transition-colors hover:bg-primary-50 disabled:cursor-wait disabled:opacity-60"
                      >
                        {isConnecting ? "Opening…" : "Connect"}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        if (connection) {
                          onDisconnectConnection(connection.connectionId);
                          return;
                        }
                        onRemovePlatform(actualIndex);
                      }}
                      disabled={disabled || connectionBusy}
                      aria-label={`${connection ? "Disconnect" : "Remove"} ${platform.handle || `account ${idx + 1}`} from ${platformName}`}
                      className="rounded-full border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700 transition-colors hover:bg-red-50 disabled:cursor-wait disabled:opacity-60"
                    >
                      {connection ? "Disconnect" : "Remove"}
                    </button>
                  </div>
                </div>

                {unavailableManualFields.length > 0 && (
                  <p className="mb-3 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    {unavailableFieldsMessage(unavailableManualFields)} Add the missing information
                    manually.
                  </p>
                )}

                {/* Account Form */}
                <div className="mb-3 space-y-2">
                  <Input
                    label="Username"
                    type="text"
                    value={actualIndex >= 0 ? allPlatforms[actualIndex].handle : ""}
                    onChange={(e) => onUpdatePlatform(actualIndex, "handle", e.target.value)}
                    placeholder="@ username"
                    required
                    disabled={disabled || Boolean(connection)}
                    helperText={
                      connection
                        ? `${platformName} supplies the username while connected.`
                        : undefined
                    }
                    className="rounded-xl border-gray-200 bg-white"
                  />
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <Input
                      label="Followers"
                      type="number"
                      value={actualIndex >= 0 ? allPlatforms[actualIndex].followers : ""}
                      onChange={(e) =>
                        onUpdatePlatform(
                          actualIndex,
                          "followers",
                          e.target.value === "" ? "" : parseInt(e.target.value),
                        )
                      }
                      required
                      placeholder="0"
                      min={1}
                      disabled={disabled || importedFields.has("followerCount")}
                      helperText={
                        importedFields.has("followerCount")
                          ? `${platformName} supplies this value while connected.`
                          : undefined
                      }
                      className="rounded-xl border-gray-200 bg-white"
                    />
                    <Input
                      label="Engagement Rate (%)"
                      type="number"
                      value={actualIndex >= 0 ? allPlatforms[actualIndex].engagement_rate : ""}
                      onChange={(e) => {
                        const raw = e.target.value.replace(",", ".");
                        onUpdatePlatform(
                          actualIndex,
                          "engagement_rate",
                          raw === "" ? "" : parseFloat(raw),
                        );
                      }}
                      required
                      placeholder="0.00"
                      min={0}
                      step="0.01"
                      disabled={disabled || importedFields.has("engagementRate")}
                      helperText={
                        importedFields.has("engagementRate")
                          ? "Calculated from the connected account's recent content."
                          : undefined
                      }
                      className="rounded-xl border-gray-200 bg-white"
                    />
                  </div>
                </div>

                <PlatformDemographics
                  platform={allPlatforms[actualIndex]}
                  isExpanded={expandedPlatforms.has(actualIndex)}
                  onToggleExpanded={() => onTogglePlatformExpanded(actualIndex)}
                  countryInput={platformCountryInputs[actualIndex] || ""}
                  onCountryInputChange={(value) => onCountryInputChange(actualIndex, value)}
                  availableCountries={getAvailableCountries(actualIndex)}
                  onAddCountry={(country) => onAddCountry(actualIndex, country)}
                  onRemoveCountry={(countryIndex) => onRemoveCountry(actualIndex, countryIndex)}
                  onUpdateCountryPercentage={(countryIndex, percentage) =>
                    onUpdateCountryPercentage(actualIndex, countryIndex, percentage)
                  }
                  onToggleAgeGroup={(ageRange) => onToggleAgeGroup(actualIndex, ageRange)}
                  onUpdateGenderSplit={(field, value) =>
                    onUpdateGenderSplit(actualIndex, field, value)
                  }
                  countriesLocked={disabled || importedFields.has("audienceCountries")}
                  ageGroupsLocked={disabled || importedFields.has("audienceAgeGroups")}
                  genderSplitLocked={disabled || importedFields.has("audienceGenderSplit")}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ConnectionBadge({ status }: { status: CreatorPlatformConnection["status"] }) {
  if (status === "active") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
        <CheckCircleIcon className="h-3.5 w-3.5" aria-hidden="true" />
        Connected
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800">
      <ExclamationTriangleIcon className="h-3.5 w-3.5" aria-hidden="true" />
      {status === "sync_failed"
        ? "Sync failed"
        : status === "revoked"
          ? "Disconnected"
          : "Reconnect required"}
    </span>
  );
}

function formatSyncDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function unavailableFieldsMessage(
  unavailableFields: CreatorPlatformConnection["unavailableFields"],
): string {
  const fields = unavailableFields.map(({ field }) => {
    if (field === "audienceCountries") return "countries";
    if (field === "audienceAgeGroups") return "age groups";
    if (field === "audienceGenderSplit") return "gender split";
    if (field === "followerCount") return "followers";
    if (field === "engagementRate") return "engagement rate";
    return field.replace(/([A-Z])/g, " $1").toLowerCase();
  });
  return `The platform did not provide ${new Intl.ListFormat(undefined, {
    style: "long",
    type: "conjunction",
  }).format(fields)}.`;
}
