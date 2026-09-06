"use client";
import PendingRequestFields from "@/components/booking/PendingRequestFields";

import { use, useCallback, useEffect, useRef, useState } from "react";
import { PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { Link, useRouter } from "@/i18n/navigation";
import BookingNavigation from "@/components/layout/BookingNavigation";
import BookingFooter from "@/components/layout/BookingFooter";
import StripeProvider from "@/components/StripeProvider";
import { useAddons, useHotel, useRooms, useSlug } from "@/contexts/HotelContext";
import {
  bookingService,
  type BookingCreateRequest,
  type PaymentSettings,
} from "@/services/api/booking";
import {
  pendingBookingEdit,
  type PendingEditDetails,
  type PendingEditAttempt,
  type BookingQuote,
  type BookingRequestResponse,
} from "@/services/api/pendingBookingEdits";
import { saveLastBooking, toConfirmationBooking } from "@/lib/storage/bookingDraft";

const button = "rounded-full bg-gray-900 px-6 py-3 font-semibold text-white disabled:opacity-50";

export default function EditRequestPage({
  params,
  searchParams,
}: {
  params: Promise<{ reference: string }>;
  searchParams: Promise<{ token?: string; payment_intent?: string }>;
}) {
  const { reference } = use(params);
  const { token = "", payment_intent: returnedIntent } = use(searchParams);
  const { slug } = useSlug();
  const { hotel } = useHotel();
  const { rooms, refetchRooms } = useRooms();
  const { addons } = useAddons();
  const router = useRouter();
  const [details, setDetails] = useState<PendingEditDetails | null>(null);
  const [input, setInput] = useState<BookingCreateRequest | null>(null);
  const [settings, setSettings] = useState<PaymentSettings | null>(null);
  const [quote, setQuote] = useState<BookingQuote | null>(null);
  const [attempt, setAttempt] = useState<PendingEditAttempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const prepareKey = useRef("");
  const saveKey = useRef("");
  const returned = useRef(false);
  const storageKey = `pending-request-edit:${slug}:${reference}`;
  const back = `/booking/${encodeURIComponent(reference)}?token=${encodeURIComponent(token)}`;

  useEffect(() => {
    let canceled = false;
    if (!slug || !token) {
      setError("Open the editor from your booking confirmation link.");
      return;
    }
    Promise.all([
      pendingBookingEdit<PendingEditDetails>(slug, reference, token, "details"),
      bookingService.getPaymentSettings(slug),
    ])
      .then(([loaded, paymentSettings]) => {
        if (canceled) return;
        setDetails(loaded);
        setInput(loaded.input);
        setSettings(paymentSettings);
        void refetchRooms(
          loaded.input.checkIn,
          loaded.input.checkOut,
          loaded.input.adults,
          loaded.input.children,
        );
      })
      .catch((e) => {
        if (!canceled) setError(e instanceof Error ? e.message : "Unable to open this request.");
      });
    return () => {
      canceled = true;
    };
  }, [slug, reference, token, refetchRooms]);

  useEffect(() => {
    if (!input?.checkIn || !input.checkOut || input.checkIn >= input.checkOut) return;
    const timer = setTimeout(() => {
      void refetchRooms(input.checkIn, input.checkOut, input.adults, input.children);
    }, 250);
    return () => clearTimeout(timer);
  }, [input?.checkIn, input?.checkOut, input?.adults, input?.children, refetchRooms]);

  const save = useCallback(
    async (prepared: PendingEditAttempt, revision = details?.revision) => {
      setBusy(true);
      setError("");
      try {
        saveKey.current ||= crypto.randomUUID();
        const saved = await pendingBookingEdit<BookingRequestResponse>(
          slug,
          reference,
          token,
          "save",
          { attemptId: prepared.attemptId, revision },
          saveKey.current,
        );
        saveLastBooking(toConfirmationBooking(saved.booking, { hotelName: hotel.name }));
        sessionStorage.removeItem(storageKey);
        router.replace(
          `/booking/${encodeURIComponent(reference)}?token=${encodeURIComponent(saved.confirmationToken || token)}`,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "Your request could not be saved.");
      } finally {
        setBusy(false);
      }
    },
    [details?.revision, slug, reference, token, hotel.name, storageKey, router],
  );

  useEffect(() => {
    if (!details || !returnedIntent || returned.current) return;
    returned.current = true;
    try {
      const pending = JSON.parse(sessionStorage.getItem(storageKey) || "null");
      if (pending?.attemptId && Number.isInteger(pending.revision)) {
        saveKey.current = pending.saveKey;
        void save({ attemptId: pending.attemptId, clientSecret: null }, pending.revision);
      } else setError("Reopen the editor to finish saving your request.");
    } catch {
      setError("Reopen the editor to finish saving your request.");
    }
  }, [details, returnedIntent, save, storageKey]);

  function change(patch: Partial<BookingCreateRequest>) {
    setInput((value) => {
      if (!value) return value;
      const next = { ...value, ...patch };
      if (patch.addonIds) {
        for (const key of ["addonQuantities", "addonDates", "addonPackageQuantities"] as const) {
          next[key] = Object.fromEntries(
            Object.entries(next[key] || {}).filter(([id]) => patch.addonIds!.includes(id)),
          );
        }
      }
      return next;
    });
    setQuote(null);
    setAttempt(null);
    prepareKey.current = "";
    saveKey.current = "";
  }

  async function review() {
    if (!input || !details) return;
    setBusy(true);
    setError("");
    try {
      const priced = await pendingBookingEdit<BookingQuote>(
        slug,
        reference,
        token,
        "quote",
        { ...input, revision: details.revision },
        crypto.randomUUID(),
      );
      setQuote(priced);
      void refetchRooms(input.checkIn, input.checkOut, input.adults, input.children);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The requested stay is unavailable.");
    } finally {
      setBusy(false);
    }
  }

  async function prepare() {
    if (!quote || !input || !details) return;
    setBusy(true);
    setError("");
    try {
      prepareKey.current ||= crypto.randomUUID();
      const prepared = await pendingBookingEdit<PendingEditAttempt>(
        slug,
        reference,
        token,
        "prepare",
        {
          ...input,
          revision: details.revision,
          quoteId: quote.quoteId,
          expectedTotalAmount: quote.totalAmount,
        },
        prepareKey.current,
      );
      saveKey.current ||= crypto.randomUUID();
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({
          attemptId: prepared.attemptId,
          revision: details.revision,
          saveKey: saveKey.current,
        }),
      );
      setAttempt(prepared);
      if (!prepared.clientSecret) await save(prepared);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to prepare this update.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <BookingNavigation />
      <main className="mx-auto max-w-3xl px-5 pb-12 pt-24">
        <Link href={back} className="text-sm underline">
          Back to booking
        </Link>
        <h1 className="mt-6 text-3xl font-bold">Edit request</h1>
        <p className="mt-2 text-gray-600">
          Booking {reference}. We’ll review your updated request. Its status remains Pending.
        </p>
        {error && (
          <p role="alert" className="mt-5 rounded-lg bg-red-50 p-4 text-red-700">
            {error}
          </p>
        )}
        {!input || !details ? (
          !error && (
            <p className="mt-6" role="status">
              Loading your request…
            </p>
          )
        ) : (
          <form
            className="mt-8 space-y-6"
            onSubmit={(event) => {
              event.preventDefault();
              void review();
            }}
          >
            <PendingRequestFields
              input={input}
              details={details}
              settings={settings}
              rooms={rooms}
              addons={addons}
              disabled={busy || Boolean(attempt?.clientSecret)}
              change={change}
            />
            {quote && (
              <section aria-label="Updated total" className="rounded-xl bg-gray-50 p-6">
                <p className="text-xl font-semibold">
                  Updated total: {quote.currency} {quote.totalAmount.toFixed(2)}
                </p>
                <p className="mt-2 text-sm text-gray-600">
                  Your booking reference and original review deadline remain the same.
                </p>
                {!attempt?.clientSecret && (
                  <button
                    type="button"
                    className={`${button} mt-4`}
                    disabled={busy}
                    onClick={() => void prepare()}
                  >
                    {busy
                      ? "Saving…"
                      : input.paymentMethod === "card"
                        ? "Authorize card and save"
                        : "Save request"}
                  </button>
                )}
              </section>
            )}
            {attempt?.clientSecret && (
              <StripeProvider
                clientSecret={attempt.clientSecret}
                stripeAccountId={attempt.stripeAccountId}
              >
                <AuthorizeCard busy={busy} save={() => save(attempt)} onError={setError} />
              </StripeProvider>
            )}
            <Link href={back} className="inline-block text-sm underline">
              Cancel editing
            </Link>
          </form>
        )}
      </main>
      <BookingFooter />
    </>
  );
}

function AuthorizeCard({
  busy,
  save,
  onError,
}: {
  busy: boolean;
  save: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [authorizing, setAuthorizing] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  async function authorize() {
    if (!stripe || !elements || authorizing) return;
    setAuthorizing(true);
    try {
      if (!authorized) {
        const result = await stripe.confirmPayment({
          elements,
          confirmParams: { return_url: window.location.href },
          redirect: "if_required",
        });
        if (result.error) throw new Error(result.error.message || "Card authorization failed.");
        setAuthorized(true);
      }
      await save();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Card authorization failed.");
    } finally {
      setAuthorizing(false);
    }
  }
  return (
    <section className="space-y-4">
      <PaymentElement />
      <p className="text-sm text-gray-600">
        Your card will be authorized for the updated total. We’ll only charge it after accepting
        your request.
      </p>
      <button
        type="button"
        className={button}
        disabled={busy || authorizing || !stripe}
        onClick={() => void authorize()}
      >
        {busy || authorizing ? "Saving…" : "Authorize and save request"}
      </button>
    </section>
  );
}
