"use client";

import { GlobeAltIcon, LinkIcon } from "@heroicons/react/24/outline";
import { Input } from "@/components/ui";
import { PLATFORM_OPTIONS } from "@/lib/constants";
import type {
  CreatorPlatformConnection,
  CreatorPlatformPendingAuthorization,
  CreatorPlatformProvider,
  PlatformFormData,
} from "@/lib/types";
import { PlatformCard } from "./PlatformCard";

interface CreatorPlatformsStepProps {
  platforms: PlatformFormData[];
  expandedPlatforms: Set<number>;
  platformCountryInputs: Record<number, string>;
  connections: CreatorPlatformConnection[];
  connectionsLoading: boolean;
  connectionsError: string;
  actionsDisabled: boolean;
  pendingAuthorization: CreatorPlatformPendingAuthorization | null;
  connectionNotice: { tone: "success" | "error"; message: string } | null;
  connectingPlatform: CreatorPlatformProvider | null;
  busyConnectionId: string | null;
  selectingExternalAccountId: string | null;
  onAddPlatform: (name: string) => void;
  onConnectPlatform: (platform: CreatorPlatformProvider, platformId?: string) => void;
  onSyncConnection: (connectionId: string) => void;
  onDisconnectConnection: (connectionId: string) => void;
  onSelectAuthorizedAccount: (externalAccountId: string) => void;
  onRetryConnections: () => void;
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

export function CreatorPlatformsStep({
  platforms,
  expandedPlatforms,
  platformCountryInputs,
  connections,
  connectionsLoading,
  connectionsError,
  actionsDisabled,
  pendingAuthorization,
  connectionNotice,
  connectingPlatform,
  busyConnectionId,
  selectingExternalAccountId,
  onAddPlatform,
  onConnectPlatform,
  onSyncConnection,
  onDisconnectConnection,
  onSelectAuthorizedAccount,
  onRetryConnections,
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
}: CreatorPlatformsStepProps) {
  return (
    <div className="space-y-3">
      {connectionsLoading && (
        <p
          role="status"
          className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700"
        >
          Loading connected accounts…
        </p>
      )}

      {connectionsError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2"
        >
          <p className="text-sm font-medium text-red-800">{connectionsError}</p>
          <button
            type="button"
            onClick={onRetryConnections}
            className="shrink-0 rounded-full border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 transition-colors hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
          >
            Retry
          </button>
        </div>
      )}

      {connectionNotice && (
        <p
          role={connectionNotice.tone === "error" ? "alert" : "status"}
          className={`rounded-xl border px-3 py-2 text-sm font-medium ${
            connectionNotice.tone === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          {connectionNotice.message}
        </p>
      )}

      {pendingAuthorization && (
        <div className="rounded-2xl border border-primary-200 bg-primary-50/60 p-3 sm:p-4">
          <p className="text-sm font-semibold text-gray-950">
            Choose the {platformDisplayName(pendingAuthorization.platform)} account to connect
          </p>
          <p className="mt-1 text-xs text-gray-600">
            vayada will import statistics for the account you select.
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {pendingAuthorization.accounts.map((account) => (
              <button
                key={account.externalAccountId}
                type="button"
                onClick={() => onSelectAuthorizedAccount(account.externalAccountId)}
                disabled={actionsDisabled}
                className="rounded-xl border border-primary-200 bg-white px-3 py-2 text-left transition-colors hover:bg-primary-50 disabled:cursor-wait disabled:opacity-60"
              >
                <span className="block truncate text-sm font-semibold text-gray-900">
                  {account.displayName}
                </span>
                <span className="mt-0.5 block truncate text-xs text-gray-500">
                  {selectingExternalAccountId === account.externalAccountId
                    ? "Connecting…"
                    : account.handle}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2">
        {PLATFORM_OPTIONS.map((platformName) => (
          <PlatformCard
            key={platformName}
            platformName={platformName}
            platforms={platforms}
            allPlatforms={platforms}
            expandedPlatforms={expandedPlatforms}
            platformCountryInputs={platformCountryInputs}
            connections={connections}
            disabled={actionsDisabled}
            connectingPlatform={connectingPlatform}
            busyConnectionId={busyConnectionId}
            onAddPlatform={onAddPlatform}
            onConnectPlatform={onConnectPlatform}
            onSyncConnection={onSyncConnection}
            onDisconnectConnection={onDisconnectConnection}
            onRemovePlatform={onRemovePlatform}
            onUpdatePlatform={onUpdatePlatform}
            onTogglePlatformExpanded={onTogglePlatformExpanded}
            onCountryInputChange={onCountryInputChange}
            onAddCountry={onAddCountry}
            onRemoveCountry={onRemoveCountry}
            onUpdateCountryPercentage={onUpdateCountryPercentage}
            onToggleAgeGroup={onToggleAgeGroup}
            onUpdateGenderSplit={onUpdateGenderSplit}
            getAvailableCountries={getAvailableCountries}
          />
        ))}
        <OtherPlatformsCard
          platforms={platforms}
          disabled={actionsDisabled}
          onAddPlatform={onAddPlatform}
          onRemovePlatform={onRemovePlatform}
          onUpdatePlatform={onUpdatePlatform}
        />
      </div>

      {platforms.length === 0 && (
        <p role="status" className="text-center text-xs font-medium text-gray-500">
          Add at least one account to complete your profile.
        </p>
      )}
      <p className="text-center text-xs text-gray-500">
        Connected accounts use a consistent 30-day window. Enter anything unavailable manually.
      </p>
    </div>
  );
}

function platformDisplayName(platform: CreatorPlatformProvider): string {
  if (platform === "instagram") return "Instagram";
  if (platform === "tiktok") return "TikTok";
  if (platform === "youtube") return "YouTube";
  return "Facebook";
}

function OtherPlatformsCard({
  platforms,
  disabled,
  onAddPlatform,
  onRemovePlatform,
  onUpdatePlatform,
}: Pick<
  CreatorPlatformsStepProps,
  "platforms" | "onAddPlatform" | "onRemovePlatform" | "onUpdatePlatform"
> & { disabled: boolean }) {
  const customPlatforms = platforms
    .map((platform, index) => ({ platform, index }))
    .filter(({ platform }) => platform.name === "Other");

  return (
    <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white transition-colors hover:border-primary-200">
      <div className="flex items-center justify-between gap-3 p-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gray-100 text-gray-600">
            <GlobeAltIcon className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-gray-950">Another platform</p>
            <p className="mt-0.5 truncate text-xs text-gray-500">
              X, LinkedIn, Lemon8, or another channel
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => onAddPlatform("Other")}
          disabled={disabled}
          className="shrink-0 rounded-full border border-primary-200 px-3 py-1.5 text-xs font-semibold text-primary-700 transition-colors hover:bg-primary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Add another platform
        </button>
      </div>

      {customPlatforms.length > 0 && (
        <div className="divide-y divide-gray-100 border-t border-gray-100 bg-gray-50/50">
          {customPlatforms.map(({ platform, index }, customIndex) => {
            const profileUrl = platform.profile_url;

            return (
              <div key={platform.id ?? `other-${customIndex}`} className="space-y-3 p-3 sm:p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-gray-900">
                    {platform.handle || `Platform ${customIndex + 1}`}
                  </p>
                  <button
                    type="button"
                    onClick={() => onRemovePlatform(index)}
                    disabled={disabled}
                    aria-label={`Remove ${platform.handle || `platform ${customIndex + 1}`}`}
                    className="rounded-full border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Remove
                  </button>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Input
                    label="Platform name"
                    aria-label="Platform name"
                    value={platform.handle}
                    disabled={disabled}
                    onChange={(event) => onUpdatePlatform(index, "handle", event.target.value)}
                    placeholder="e.g. LinkedIn"
                    required
                    className="rounded-xl border-gray-200 bg-white"
                  />
                  <Input
                    label="Profile link"
                    aria-label="Profile link"
                    type="url"
                    value={profileUrl ?? ""}
                    disabled={disabled}
                    onChange={(event) => onUpdatePlatform(index, "profile_url", event.target.value)}
                    placeholder="https://your-profile.com"
                    leadingIcon={<LinkIcon className="h-4 w-4" aria-hidden="true" />}
                    required
                    className="rounded-xl border-gray-200 bg-white"
                  />
                  <Input
                    label="Followers"
                    aria-label="Followers"
                    type="number"
                    value={platform.followers}
                    disabled={disabled}
                    onChange={(event) =>
                      onUpdatePlatform(
                        index,
                        "followers",
                        event.target.value === "" ? "" : Number.parseInt(event.target.value, 10),
                      )
                    }
                    placeholder="0"
                    min={1}
                    required
                    className="rounded-xl border-gray-200 bg-white"
                  />
                  <Input
                    label="Engagement rate (%)"
                    aria-label="Engagement rate (%)"
                    type="number"
                    value={platform.engagement_rate}
                    disabled={disabled}
                    onChange={(event) => {
                      const value = event.target.value.replace(",", ".");
                      onUpdatePlatform(
                        index,
                        "engagement_rate",
                        value === "" ? "" : Number.parseFloat(value),
                      );
                    }}
                    placeholder="0.00"
                    min={0}
                    max={100}
                    step="0.01"
                    required
                    className="rounded-xl border-gray-200 bg-white"
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
