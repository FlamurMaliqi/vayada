"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  ArrowLeftIcon,
  CheckIcon,
  ClipboardIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";

import {
  inviteCodesService,
  type HotelAccountInviteCreateRequest,
  type HotelSetupTrack,
  type InviteCode,
} from "@/services/api/inviteCodes";

type InviteView = "list" | "create";
type SetupRoute = "marketplace" | "operations" | "combined";

const SETUP_ROUTE_OPTIONS: Array<{
  id: SetupRoute;
  label: string;
  description: string;
  steps: string;
  selectedTracks: HotelSetupTrack[];
}> = [
  {
    id: "marketplace",
    label: "Creator Marketplace",
    description: "For hotels that only want creator collaborations.",
    steps: "Hotel details → Marketplace setup",
    selectedTracks: ["creator_marketplace"],
  },
  {
    id: "operations",
    label: "Hotel Operations",
    description: "For hotels using Booking Engine and PMS.",
    steps: "Hotel details → Booking and PMS setup",
    selectedTracks: ["hotel_operations"],
  },
  {
    id: "combined",
    label: "Marketplace + Hotel Operations",
    description: "For hotels using the complete Vayada product suite.",
    steps: "Hotel details → Combined setup",
    selectedTracks: ["hotel_operations", "creator_marketplace"],
  },
];

export default function InviteCodesPage() {
  const [view, setView] = useState<InviteView>("list");
  const [invites, setInvites] = useState<InviteCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [inviteeEmail, setInviteeEmail] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [propertyName, setPropertyName] = useState("");
  const [setupRoute, setSetupRoute] = useState<SetupRoute>("marketplace");
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createdInvite, setCreatedInvite] = useState<InviteCode | null>(null);

  useEffect(() => {
    void loadInvites();
  }, []);

  async function loadInvites() {
    try {
      setPageError("");
      setInvites(await inviteCodesService.list());
    } catch {
      setPageError("Invite codes could not be loaded. Try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy(code: string, id: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId(null), 2000);
    } catch {
      setPageError("The invite code could not be copied. Copy it manually instead.");
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm("Revoke this invite code?")) return;

    try {
      setPageError("");
      await inviteCodesService.delete(id);
      setInvites((current) => current.filter((invite) => invite.id !== id));
    } catch {
      setPageError("The invite code could not be revoked. Try again.");
    }
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const selectedRoute = SETUP_ROUTE_OPTIONS.find((option) => option.id === setupRoute)!;
    const request: HotelAccountInviteCreateRequest = {
      identity: { email: inviteeEmail.trim() },
      organization: { displayName: organizationName.trim() },
      property: { displayName: propertyName.trim() },
      selectedTracks: selectedRoute.selectedTracks,
    };

    try {
      setSaving(true);
      setCreateError("");
      const invite = await inviteCodesService.create(request);
      setCreatedInvite(invite);
      setInvites((current) => [invite, ...current]);
    } catch {
      setCreateError("The invite could not be created. Check the details and try again.");
    } finally {
      setSaving(false);
    }
  }

  function closeCreateView() {
    setInviteeEmail("");
    setOrganizationName("");
    setPropertyName("");
    setSetupRoute("marketplace");
    setCreateError("");
    setCreatedInvite(null);
    setView("list");
  }

  if (view === "create") {
    return createdInvite ? (
      <InviteCreated invite={createdInvite} onDone={closeCreateView} />
    ) : (
      <div className="min-h-full bg-gray-50">
        <header className="border-b border-gray-200 bg-white">
          <div className="flex items-center gap-3 px-6 py-4">
            <button
              type="button"
              onClick={closeCreateView}
              className="rounded-md p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 focus:outline-none focus:ring-2 focus:ring-primary-500"
              aria-label="Back to invite codes"
            >
              <ArrowLeftIcon className="h-5 w-5" />
            </button>
            <div>
              <h1 className="text-xl font-bold text-gray-900">Invite a hotel account</h1>
              <p className="text-sm text-gray-500">
                Set account identity and product access. The hotel completes its own setup.
              </p>
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-4xl px-6 py-8">
          <form onSubmit={handleCreate} className="space-y-6">
            {createError ? (
              <div
                role="alert"
                className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
              >
                {createError}
              </div>
            ) : null}

            <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
              <div className="mb-5">
                <p className="text-xs font-semibold uppercase tracking-wider text-primary-600">
                  Account
                </p>
                <h2 className="mt-1 text-lg font-semibold text-gray-900">Who are you inviting?</h2>
                <p className="mt-1 text-sm text-gray-500">
                  These details identify the invitation. They do not replace hotel onboarding.
                </p>
              </div>

              <div className="grid gap-5 md:grid-cols-2">
                <label className="block md:col-span-2">
                  <span className="text-sm font-medium text-gray-800">Hotel owner email</span>
                  <input
                    type="email"
                    required
                    maxLength={254}
                    autoComplete="email"
                    value={inviteeEmail}
                    onChange={(event) => setInviteeEmail(event.target.value)}
                    placeholder="owner@example.com"
                    className="mt-1.5 w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-900 outline-none transition focus:border-primary-500 focus:ring-2 focus:ring-primary-100"
                  />
                </label>

                <label className="block">
                  <span className="text-sm font-medium text-gray-800">Hotel group name</span>
                  <input
                    type="text"
                    required
                    maxLength={160}
                    value={organizationName}
                    onChange={(event) => setOrganizationName(event.target.value)}
                    placeholder="Alpenrose Hospitality"
                    className="mt-1.5 w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-900 outline-none transition focus:border-primary-500 focus:ring-2 focus:ring-primary-100"
                  />
                </label>

                <label className="block">
                  <span className="text-sm font-medium text-gray-800">Property name</span>
                  <input
                    type="text"
                    required
                    maxLength={160}
                    value={propertyName}
                    onChange={(event) => setPropertyName(event.target.value)}
                    placeholder="Hotel Alpenrose"
                    className="mt-1.5 w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-900 outline-none transition focus:border-primary-500 focus:ring-2 focus:ring-primary-100"
                  />
                </label>
              </div>
            </section>

            <fieldset className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
              <legend className="sr-only">Product setup route</legend>
              <div className="mb-5">
                <p className="text-xs font-semibold uppercase tracking-wider text-primary-600">
                  Product access
                </p>
                <h2 className="mt-1 text-lg font-semibold text-gray-900">Choose the setup route</h2>
                <p className="mt-1 text-sm text-gray-500">
                  This controls which product steps appear after the preserved hotel-details flow.
                </p>
              </div>

              <div className="grid gap-3 lg:grid-cols-3">
                {SETUP_ROUTE_OPTIONS.map((option) => {
                  const selected = setupRoute === option.id;
                  return (
                    <label
                      key={option.id}
                      className={`relative flex cursor-pointer flex-col rounded-xl border p-4 transition focus-within:ring-2 focus-within:ring-primary-500 ${
                        selected
                          ? "border-primary-500 bg-primary-50/60"
                          : "border-gray-200 bg-white hover:border-gray-300"
                      }`}
                    >
                      <span className="flex items-start justify-between gap-3">
                        <span className="text-sm font-semibold text-gray-900">{option.label}</span>
                        <input
                          type="radio"
                          name="setup-route"
                          value={option.id}
                          checked={selected}
                          onChange={() => setSetupRoute(option.id)}
                          className="mt-0.5 h-4 w-4 border-gray-300 text-primary-600 focus:ring-primary-500"
                        />
                      </span>
                      <span className="mt-2 text-sm leading-5 text-gray-600">
                        {option.description}
                      </span>
                      <span className="mt-4 border-t border-gray-200 pt-3 text-xs font-medium text-gray-500">
                        {option.steps}
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={closeCreateView}
                className="rounded-lg border border-gray-300 px-5 py-2.5 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center justify-center rounded-lg bg-primary-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? "Creating invite…" : "Create invite code"}
              </button>
            </div>
          </form>
        </main>
      </div>
    );
  }

  return (
    <div>
      <header className="border-b border-gray-200 bg-white">
        <div className="flex items-center justify-between gap-4 px-6 py-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Hotel invitations</h1>
            <p className="text-sm text-gray-500">
              Invite hotel accounts and choose their Vayada product route.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setView("create")}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2"
          >
            <PlusIcon className="h-4 w-4" /> Create invite
          </button>
        </div>
      </header>

      <main className="p-6">
        {pageError ? (
          <div
            role="alert"
            className="mb-4 flex items-center justify-between gap-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          >
            <span>{pageError}</span>
            <button
              type="button"
              onClick={() => void loadInvites()}
              className="font-semibold underline"
            >
              Retry
            </button>
          </div>
        ) : null}

        {loading ? (
          <div className="flex justify-center py-12" aria-label="Loading invite codes">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
          </div>
        ) : invites.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-300 bg-white px-6 py-16 text-center">
            <p className="text-sm font-medium text-gray-700">No hotel invitations yet</p>
            <p className="mt-1 text-sm text-gray-500">
              Create an invite when a hotel is ready to begin its own setup.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
            <table className="w-full min-w-[940px] text-sm">
              <thead className="border-b border-gray-200 bg-gray-50">
                <tr>
                  {[
                    "Code",
                    "Invitee",
                    "Hotel account",
                    "Setup route",
                    "Status",
                    "Created",
                    "Expires",
                  ].map((heading) => (
                    <th
                      key={heading}
                      className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500"
                    >
                      {heading}
                    </th>
                  ))}
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {invites.map((invite) => (
                  <tr key={invite.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono font-semibold text-gray-900">
                      {invite.code}
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {invite.identity?.email ?? "Legacy invite"}
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-800">
                        {invite.property?.displayName ?? "—"}
                      </p>
                      <p className="text-xs text-gray-500">
                        {invite.organization?.displayName ?? "No hotel group recorded"}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {formatSetupRoute(invite.selectedTracks)}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={invite.status} />
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {new Date(invite.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {new Date(invite.expiresAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => void handleCopy(invite.code, invite.id)}
                          className="rounded-md p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-500"
                          aria-label={`Copy invite code ${invite.code}`}
                        >
                          {copiedId === invite.id ? (
                            <CheckIcon className="h-4 w-4 text-green-600" />
                          ) : (
                            <ClipboardIcon className="h-4 w-4" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDelete(invite.id)}
                          className="rounded-md p-2 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600 focus:outline-none focus:ring-2 focus:ring-red-500"
                          aria-label={`Revoke invite code ${invite.code}`}
                        >
                          <TrashIcon className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}

function InviteCreated({ invite, onDone }: { invite: InviteCode; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");

  async function copyInviteCode() {
    try {
      await navigator.clipboard.writeText(invite.code);
      setCopyError("");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError("The invite code could not be copied. Copy it manually instead.");
    }
  }

  return (
    <div className="flex min-h-[80vh] items-center justify-center bg-gray-50 p-6">
      <div className="w-full max-w-lg rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-green-100">
          <CheckIcon className="h-7 w-7 text-green-700" />
        </div>
        <h1 className="text-xl font-bold text-gray-900">Hotel invite created</h1>
        <p className="mt-2 text-sm text-gray-500">
          Share this code with {invite.identity?.email}. They enter it on the Marketplace invitation
          page, then continue through the {formatSetupRoute(invite.selectedTracks)} route.
        </p>
        <div className="my-6 rounded-xl border border-gray-200 bg-gray-50 p-5">
          <p className="break-all font-mono text-xl font-bold tracking-wider text-gray-900 sm:text-2xl">
            {invite.code}
          </p>
          <p className="mt-2 text-xs font-medium text-gray-500">
            After secure acceptance: {invite.handoffPath}
          </p>
        </div>
        {copyError ? (
          <p role="alert" className="mb-3 text-sm text-red-700">
            {copyError}
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => void copyInviteCode()}
          className="w-full rounded-lg bg-primary-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2"
        >
          {copied ? "Invite code copied" : "Copy invite code"}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="mt-3 w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500"
        >
          Back to invitations
        </button>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: InviteCode["status"] }) {
  const classes =
    status === "pending"
      ? "bg-amber-100 text-amber-800"
      : status === "redeemed"
        ? "bg-green-100 text-green-800"
        : "bg-gray-100 text-gray-600";

  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${classes}`}>
      {status}
    </span>
  );
}

function formatSetupRoute(selectedTracks: readonly HotelSetupTrack[]): string {
  const hasMarketplace = selectedTracks.includes("creator_marketplace");
  const hasOperations = selectedTracks.includes("hotel_operations");
  if (hasMarketplace && hasOperations) return "Marketplace + Hotel Operations";
  if (hasMarketplace) return "Creator Marketplace";
  if (hasOperations) return "Hotel Operations";
  return "Legacy invite";
}
