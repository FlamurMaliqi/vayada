"use client";

import {
  ArrowPathIcon,
  ChatBubbleLeftRightIcon,
  CloudArrowUpIcon,
  Cog6ToothIcon,
  ExclamationTriangleIcon,
  LinkIcon,
} from "@heroicons/react/24/outline";
import { useTranslation } from "@/lib/i18n";
import { channexService } from "@/services/channex";
import {
  terminalChannexStatuses,
  useChannexManager,
} from "@/lib/channel-manager/useChannexManager";
import {
  ChannelManagerSkeleton,
  channelManagerButtonClass as buttonClass,
  ConnectionBadge,
  MappingMetric as Metric,
  modeAllowsChanges,
  OperationBanner,
  SyncAction,
} from "@/components/channel-manager/ChannelManagerUi";

export default function ChannelManagerPage() {
  const { t } = useTranslation();
  const {
    snapshot,
    operation,
    loading,
    loadError,
    actionError,
    pendingAction,
    markupDrafts,
    channels,
    setMarkupDrafts,
    loadSnapshot,
    runCommand,
    openConsole,
    saveMarkups,
  } = useChannexManager();

  if (loading) return <ChannelManagerSkeleton />;

  if (!snapshot || loadError) {
    return (
      <div className="p-4 md:p-6">
        <div className="max-w-3xl rounded-xl border border-red-200 bg-white p-6" role="alert">
          <ExclamationTriangleIcon className="h-6 w-6 text-red-600" />
          <h1 className="mt-3 text-lg font-semibold text-gray-950">Channel manager unavailable</h1>
          <p className="mt-1 text-sm text-gray-600">{loadError}</p>
          <button
            type="button"
            onClick={() => {
              void loadSnapshot();
            }}
            className={`${buttonClass} mt-5 bg-gray-950 text-white hover:bg-gray-800`}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const connected = ["connected", "degraded"].includes(snapshot.connection.status);
  const busy =
    Boolean(pendingAction) || Boolean(operation && !terminalChannexStatuses.has(operation.status));
  const observeOnly = Object.values(snapshot.capabilityModes).some(
    (mode) => !modeAllowsChanges(mode),
  );

  return (
    <div className="p-4 md:p-6">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-xl font-bold text-gray-900">{t("channels.title")}</h1>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-gray-500">
              Connect booking channels and keep availability, rates, reservations, and messages in
              sync.
            </p>
          </div>
          <ConnectionBadge status={snapshot.connection.status} />
        </div>

        {observeOnly && (
          <div className="mt-5 flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <ExclamationTriangleIcon className="mt-0.5 h-5 w-5 shrink-0" />
            <p>
              Some controls are in observe-only mode during cutover. Their current state is visible,
              but changes stay disabled until the capability is approved.
            </p>
          </div>
        )}

        {actionError && (
          <div
            className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700"
            role="alert"
          >
            {actionError}
          </div>
        )}
        {operation && <OperationBanner operation={operation} />}

        <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(300px,0.75fr)]">
          <div className="space-y-5">
            <section className="rounded-xl border border-gray-200 bg-white p-5 md:p-6">
              <div className="flex items-start justify-between gap-4">
                <div className="flex gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-700">
                    <LinkIcon className="h-5 w-5" />
                  </div>
                  <div>
                    <h2 className="font-semibold text-gray-950">Channex connection</h2>
                    <p className="mt-1 text-sm text-gray-500">
                      {connected
                        ? `Provider property ${snapshot.connection.externalPropertyId ?? "connected"}`
                        : "Connect this property before provisioning channels."}
                    </p>
                  </div>
                </div>
              </div>
              <div className="mt-5 flex flex-wrap gap-3 border-t border-gray-100 pt-5">
                <button
                  type="button"
                  onClick={() =>
                    void runCommand(
                      "connection",
                      connected ? channexService.disable : channexService.enable,
                    )
                  }
                  disabled={busy || !modeAllowsChanges(snapshot.capabilityModes.connection)}
                  className={`${buttonClass} ${connected ? "border border-gray-300 bg-white text-gray-800 hover:bg-gray-50" : "bg-primary-600 text-white hover:bg-primary-700"}`}
                >
                  {connected ? "Disable connection" : "Enable connection"}
                </button>
                <button
                  type="button"
                  onClick={() => void openConsole()}
                  disabled={
                    busy || !connected || !modeAllowsChanges(snapshot.capabilityModes.iframe)
                  }
                  className={`${buttonClass} border border-gray-300 bg-white text-gray-800 hover:bg-gray-50`}
                >
                  <Cog6ToothIcon className="h-4 w-4" /> Open channel settings
                </button>
              </div>
            </section>

            <section className="rounded-xl border border-gray-200 bg-white p-5 md:p-6">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="font-semibold text-gray-950">Mappings</h2>
                  <p className="mt-1 text-sm text-gray-500">
                    Provider IDs linked to target PMS inventory.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void runCommand("provisioning", channexService.provision)}
                  disabled={
                    busy || !connected || !modeAllowsChanges(snapshot.capabilityModes.provisioning)
                  }
                  className={`${buttonClass} bg-gray-950 text-white hover:bg-gray-800`}
                >
                  Provision
                </button>
              </div>
              <div className="mt-5 grid grid-cols-2 gap-3">
                <Metric label="Room types" value={snapshot.mappings.roomTypes.length} />
                <Metric label="Rate plans" value={snapshot.mappings.ratePlans.length} />
              </div>
              {snapshot.mappings.roomTypes.length === 0 &&
              snapshot.mappings.ratePlans.length === 0 ? (
                <p className="mt-4 rounded-lg bg-gray-50 p-4 text-sm text-gray-500">
                  No provider mappings yet.
                </p>
              ) : (
                <div className="mt-4 max-h-56 overflow-auto rounded-lg border border-gray-200">
                  <table className="w-full text-left text-sm">
                    <thead className="sticky top-0 bg-gray-50 text-xs font-semibold uppercase tracking-wide text-gray-500">
                      <tr>
                        <th className="px-3 py-2">Inventory</th>
                        <th className="px-3 py-2">Provider ID</th>
                        <th className="px-3 py-2">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {snapshot.mappings.roomTypes.map((mapping) => (
                        <tr key={mapping.mappingId}>
                          <td className="px-3 py-2.5 font-medium text-gray-800">
                            {mapping.roomTypeName}
                          </td>
                          <td className="px-3 py-2.5 font-mono text-xs text-gray-500">
                            {mapping.externalRoomTypeId}
                          </td>
                          <td className="px-3 py-2.5 capitalize text-gray-600">{mapping.status}</td>
                        </tr>
                      ))}
                      {snapshot.mappings.ratePlans.map((mapping) => (
                        <tr key={mapping.mappingId}>
                          <td className="px-3 py-2.5 font-medium text-gray-800">
                            {mapping.ratePlanName}
                          </td>
                          <td className="px-3 py-2.5 font-mono text-xs text-gray-500">
                            {mapping.externalRatePlanId}
                          </td>
                          <td className="px-3 py-2.5 capitalize text-gray-600">{mapping.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="rounded-xl border border-gray-200 bg-white p-5 md:p-6">
              <h2 className="font-semibold text-gray-950">Channel markups</h2>
              <p className="mt-1 text-sm text-gray-500">
                Adjust rates sent to each connected channel.
              </p>
              {channels.length === 0 ? (
                <p className="mt-4 rounded-lg bg-gray-50 p-4 text-sm text-gray-500">
                  Connect a channel in Channex to set markups.
                </p>
              ) : (
                <div className="mt-5 space-y-3">
                  {channels.map((channel) => (
                    <label
                      key={channel}
                      className="grid items-center gap-2 sm:grid-cols-[1fr_9rem]"
                    >
                      <span className="text-sm font-medium capitalize text-gray-800">
                        {channel.replaceAll("_", " ")}
                      </span>
                      <span className="relative">
                        <input
                          type="number"
                          min={-50}
                          max={200}
                          step="0.1"
                          value={markupDrafts[channel] ?? "0"}
                          onChange={(event) =>
                            setMarkupDrafts((current) => ({
                              ...current,
                              [channel]: event.target.value,
                            }))
                          }
                          disabled={
                            busy ||
                            !connected ||
                            !modeAllowsChanges(snapshot.capabilityModes.markups)
                          }
                          className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-3 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-gray-50"
                        />
                        <span className="pointer-events-none absolute right-3 top-2 text-sm text-gray-500">
                          %
                        </span>
                      </span>
                    </label>
                  ))}
                  <div className="flex justify-end border-t border-gray-100 pt-4">
                    <button
                      type="button"
                      onClick={() => void saveMarkups()}
                      disabled={
                        busy || !connected || !modeAllowsChanges(snapshot.capabilityModes.markups)
                      }
                      className={`${buttonClass} bg-primary-600 text-white hover:bg-primary-700`}
                    >
                      Save markups
                    </button>
                  </div>
                </div>
              )}
            </section>
          </div>

          <div className="space-y-5">
            <section className="rounded-xl border border-gray-200 bg-white p-5">
              <h2 className="font-semibold text-gray-950">Sync operations</h2>
              <div className="mt-4 space-y-3">
                <SyncAction
                  icon={CloudArrowUpIcon}
                  title="Availability and rates"
                  state={snapshot.sync.ari}
                  disabled={
                    busy || !connected || !modeAllowsChanges(snapshot.capabilityModes.ariSync)
                  }
                  onClick={() => void runCommand("ARI sync", channexService.syncAri)}
                />
                <SyncAction
                  icon={ArrowPathIcon}
                  title="Reservations"
                  state={snapshot.sync.booking}
                  disabled={
                    busy || !connected || !modeAllowsChanges(snapshot.capabilityModes.bookingSync)
                  }
                  onClick={() => void runCommand("booking sync", channexService.syncBookings)}
                />
                <SyncAction
                  icon={ChatBubbleLeftRightIcon}
                  title="Messaging app"
                  state={snapshot.sync.message}
                  disabled={
                    busy ||
                    !connected ||
                    snapshot.connection.messagingAppInstalled ||
                    !modeAllowsChanges(snapshot.capabilityModes.messaging)
                  }
                  onClick={() =>
                    void runCommand("messaging installation", channexService.installMessagingApp)
                  }
                  actionLabel={snapshot.connection.messagingAppInstalled ? "Installed" : "Install"}
                />
              </div>
            </section>

            <section className="rounded-xl border border-gray-200 bg-white p-5">
              <h2 className="font-semibold text-gray-950">Connected channels</h2>
              {snapshot.channels.length === 0 ? (
                <p className="mt-3 text-sm leading-6 text-gray-500">
                  No connected channel applications yet. Open channel settings after provisioning to
                  add one.
                </p>
              ) : (
                <ul className="mt-4 divide-y divide-gray-100">
                  {snapshot.channels.map((channel) => (
                    <li
                      key={channel.key}
                      className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                    >
                      <div>
                        <p className="text-sm font-medium text-gray-900">
                          {channel.title || channel.application}
                        </p>
                        <p className="text-xs text-gray-500">{channel.application}</p>
                      </div>
                      <span
                        className={`h-2.5 w-2.5 rounded-full ${channel.isActive ? "bg-green-500" : "bg-gray-300"}`}
                      >
                        <span className="sr-only">{channel.isActive ? "Active" : "Inactive"}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
