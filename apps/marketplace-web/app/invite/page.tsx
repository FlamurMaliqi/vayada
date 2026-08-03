"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRightIcon,
  BuildingOffice2Icon,
  CheckCircleIcon,
  KeyIcon,
} from "@heroicons/react/24/outline";

import { ROUTES } from "@/lib/constants";
import {
  captureHotelAccountInviteCode,
  clearPendingHotelAccountInvite,
  hotelAccountInvitesService,
  storeHotelAccountInviteCode,
  type HotelAccountInviteLookup,
  type HotelAccountInviteRedemption,
} from "@/services/api/hotelAccountInvites";
import { ApiErrorResponse } from "@/services/api/client";
import { authService } from "@/services/auth";

type InviteState =
  | { phase: "loading" }
  | { phase: "missing"; message?: string }
  | { phase: "ready"; code: string; invite: HotelAccountInviteLookup; authenticated: boolean }
  | { phase: "wrong_account"; code: string; invite: HotelAccountInviteLookup }
  | { phase: "redeeming"; code: string; invite: HotelAccountInviteLookup }
  | { phase: "error"; code: string; invite: HotelAccountInviteLookup; message: string };

export default function HotelAccountInvitePage() {
  const router = useRouter();
  const initialLoadStarted = useRef(false);
  const [state, setState] = useState<InviteState>({ phase: "loading" });
  const [manualCode, setManualCode] = useState("");

  const loadInvite = useCallback(
    async (code: string) => {
      setState({ phase: "loading" });
      try {
        const invite = await hotelAccountInvitesService.lookup(code);
        let authenticated = false;
        try {
          authenticated = await authService.ensureSession();
        } catch {
          authenticated = false;
        }
        if (authenticated && authService.getUserType() === null) {
          router.replace(ROUTES.ONBOARDING);
          return;
        }
        if (authenticated && authService.getUserType() !== "hotel") {
          setState({ phase: "wrong_account", code, invite });
          return;
        }
        setState({ phase: "ready", code, invite, authenticated });
      } catch (error) {
        if (error instanceof ApiErrorResponse && error.status === 404) {
          try {
            const authenticated = await authService.ensureSession();
            if (authenticated && authService.getUserType() === "hotel") {
              const redemption = await hotelAccountInvitesService.redeem(code);
              finishRedemption(redemption);
              return;
            }
          } catch {
            // The replay path intentionally falls through to the same unavailable state.
          }
        }
        clearPendingHotelAccountInvite();
        setState({
          phase: "missing",
          message: "That invitation is invalid, expired, revoked, or already used.",
        });
      }
    },
    [router],
  );

  useEffect(() => {
    if (initialLoadStarted.current) return;
    initialLoadStarted.current = true;
    const code = captureHotelAccountInviteCode();
    if (!code) {
      setState({ phase: "missing" });
      return;
    }
    void loadInvite(code);
  }, [loadInvite]);

  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = storeHotelAccountInviteCode(manualCode);
    if (!code) {
      setState({ phase: "missing", message: "Enter the complete invitation code." });
      return;
    }
    await loadInvite(code);
  }

  async function redeemInvite(code: string, invite: HotelAccountInviteLookup) {
    setState({ phase: "redeeming", code, invite });
    try {
      await authService.completeOnboarding("hotel", { inviteCode: code });
      const redemption = await hotelAccountInvitesService.redeem(code);
      finishRedemption(redemption);
    } catch {
      setState({
        phase: "error",
        code,
        invite,
        message:
          "The invitation could not be accepted. Confirm this is the invited hotel-owner account and try again.",
      });
    }
  }

  if (state.phase === "loading") {
    return (
      <InviteShell>
        <div className="flex min-h-64 items-center justify-center" aria-label="Loading invitation">
          <div className="h-7 w-7 animate-spin rounded-full border-2 border-primary-600 border-t-transparent" />
        </div>
      </InviteShell>
    );
  }

  if (state.phase === "missing") {
    return (
      <InviteShell>
        <div className="mx-auto max-w-md text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-gray-100 text-gray-700">
            <KeyIcon className="h-6 w-6" aria-hidden="true" />
          </div>
          <h1 className="mt-5 text-2xl font-bold text-gray-950">Open your hotel invitation</h1>
          <p className="mt-2 text-sm leading-6 text-gray-600">
            Enter the code shared by the Vayada team. Invitation codes are accepted here and are
            never added to the page address.
          </p>
          <form onSubmit={submitCode} className="mt-7 text-left">
            <label htmlFor="hotel-invite-code" className="text-sm font-semibold text-gray-800">
              Invitation code
            </label>
            <input
              id="hotel-invite-code"
              type="text"
              required
              autoComplete="off"
              spellCheck={false}
              value={manualCode}
              onChange={(event) => setManualCode(event.target.value)}
              placeholder="VAY-…"
              className="mt-2 w-full rounded-xl border border-gray-300 px-4 py-3 font-mono text-sm text-gray-950 outline-none transition focus:border-primary-500 focus:ring-2 focus:ring-primary-100"
            />
            {state.message ? (
              <p role="alert" className="mt-3 text-sm text-red-700">
                {state.message}
              </p>
            ) : null}
            <button
              type="submit"
              className="mt-5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"
            >
              Check invitation
              <ArrowRightIcon className="h-4 w-4" aria-hidden="true" />
            </button>
          </form>
        </div>
      </InviteShell>
    );
  }

  const { code, invite } = state;
  const isWrongAccount = state.phase === "wrong_account";
  const isRedeeming = state.phase === "redeeming";
  const isAuthenticated = state.phase !== "ready" || state.authenticated;

  return (
    <InviteShell>
      <div className="mx-auto max-w-lg text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary-50 text-primary-700">
          <BuildingOffice2Icon className="h-7 w-7" aria-hidden="true" />
        </div>
        <p className="mt-5 text-xs font-bold uppercase tracking-[0.18em] text-primary-700">
          Hotel account invitation
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-gray-950">
          {invite.property.displayName}
        </h1>
        <p className="mt-2 text-sm text-gray-600">{invite.organization.displayName}</p>

        <div className="mt-7 rounded-2xl border border-gray-200 bg-gray-50 p-5 text-left">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">
            Invitation details
          </p>
          <dl className="mt-4 space-y-3 text-sm">
            <InviteDetail label="Invited account" value={invite.identity.emailHint} />
            <InviteDetail label="Setup route" value={formatTracks(invite.selectedTracks)} />
            <InviteDetail
              label="Valid until"
              value={new Date(invite.expiresAt).toLocaleDateString()}
            />
          </dl>
        </div>

        {state.phase === "error" ? (
          <p
            role="alert"
            className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700"
          >
            {state.message}
          </p>
        ) : null}
        {isWrongAccount ? (
          <p
            role="alert"
            className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800"
          >
            Choose or create the invited hotel account before accepting this invitation.
          </p>
        ) : null}

        {!isAuthenticated || isWrongAccount ? (
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <Link
              href={isWrongAccount ? ROUTES.ONBOARDING : ROUTES.SIGNUP}
              className="inline-flex min-h-11 items-center justify-center rounded-xl bg-primary-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"
            >
              {isWrongAccount ? "Open invited hotel account" : "Create hotel account"}
            </Link>
            <Link
              href={`${ROUTES.LOGIN}?returnTo=${encodeURIComponent("/invite")}`}
              className="inline-flex min-h-11 items-center justify-center rounded-xl border border-gray-300 bg-white px-5 py-3 text-sm font-semibold text-gray-800 transition hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"
            >
              Sign in
            </Link>
          </div>
        ) : (
          <button
            type="button"
            disabled={isRedeeming}
            onClick={() => void redeemInvite(code, invite)}
            className="mt-6 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary-600 px-6 py-3 text-sm font-semibold text-white transition hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isRedeeming ? "Preparing your setup…" : "Accept and continue to setup"}
            {!isRedeeming ? <CheckCircleIcon className="h-5 w-5" aria-hidden="true" /> : null}
          </button>
        )}
      </div>
    </InviteShell>
  );
}

function InviteShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top,_#eef2ff,_#f9fafb_52%)] px-5 py-12">
      <section className="w-full max-w-2xl rounded-3xl border border-white/80 bg-white p-7 shadow-[0_24px_70px_-36px_rgba(15,23,42,0.45)] sm:p-10">
        {children}
      </section>
    </main>
  );
}

function InviteDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-gray-500">{label}</dt>
      <dd className="text-right font-semibold text-gray-900">{value}</dd>
    </div>
  );
}

function formatTracks(tracks: readonly string[]): string {
  const marketplace = tracks.includes("creator_marketplace");
  const operations = tracks.includes("hotel_operations");
  if (marketplace && operations) return "Marketplace + Hotel Operations";
  if (operations) return "Hotel Operations";
  return "Creator Marketplace";
}

function setupHandoffPath(tracks: readonly string[]): string {
  const entryProduct =
    tracks.length === 1 && tracks[0] === "hotel_operations" ? "pms" : "marketplace";
  return `/setup?entryProduct=${entryProduct}&returnProduct=${entryProduct}`;
}

function finishRedemption(redemption: HotelAccountInviteRedemption): void {
  clearPendingHotelAccountInvite();
  window.location.assign(setupHandoffPath(redemption.selectedTracks));
}
