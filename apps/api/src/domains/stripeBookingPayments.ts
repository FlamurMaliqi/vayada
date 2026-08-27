import { Buffer } from "node:buffer";

type StripeFetch = typeof globalThis.fetch;
type StripeObject = Record<string, unknown>;

export type StripeBookingPaymentIntent = {
  paymentIntentId: string;
  clientSecret: string | null;
  status: string;
  amountMinor: number;
  currency: string;
  propertyId: string | null;
  bookingReference: string | null;
  providerAccountRef: string | null;
  cardBrand?: string | null;
  cardLast4?: string | null;
  feeBreakdown?: {
    balanceTransactionId: string;
    chargeId: string;
    currency: string;
    grossAmountMinor: number;
    processorFeeAmountMinor: number;
    applicationFeeAmountMinor: number;
    netPayoutAmountMinor: number;
  } | null;
};

export type StripeBookingPaymentProvider = {
  createPaymentIntent(input: {
    propertyId: string;
    bookingReference: string;
    providerAccountRef: string;
    amountMinor: number;
    applicationFeeAmountMinor: number;
    currency: string;
    captureMethod: "automatic" | "manual";
    idempotencyKey: string;
  }): Promise<StripeBookingPaymentIntent>;
  retrievePaymentIntent(
    paymentIntentId: string,
    providerAccountRef: string | null,
  ): Promise<StripeBookingPaymentIntent>;
  capturePaymentIntent(
    paymentIntentId: string,
    providerAccountRef: string | null,
    idempotencyKey: string,
  ): Promise<StripeBookingPaymentIntent>;
  cancelPaymentIntent(
    paymentIntentId: string,
    providerAccountRef: string | null,
    idempotencyKey: string,
  ): Promise<StripeBookingPaymentIntent>;
};

export function createStripeBookingPaymentProvider(config: {
  secretKey: string;
  endpoint?: string;
  fetch?: StripeFetch;
}): StripeBookingPaymentProvider {
  const endpoint = config.endpoint ?? "https://api.stripe.com/v1";
  const fetchImpl = config.fetch ?? globalThis.fetch;

  const request = async (
    method: "GET" | "POST",
    path: string,
    fields: ReadonlyArray<readonly [string, string]> = [],
    idempotencyKey?: string,
    providerAccountRef?: string | null,
  ): Promise<StripeObject> => {
    const form = new URLSearchParams(fields.map(([key, value]): [string, string] => [key, value]));
    const response = await fetchImpl(
      `${endpoint}${path}${method === "GET" && fields.length ? `?${form}` : ""}`,
      {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.secretKey}:`).toString("base64")}`,
          ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
          ...(providerAccountRef ? { "Stripe-Account": providerAccountRef } : {}),
        },
        ...(method === "POST" ? { body: form.toString() } : {}),
      },
    );
    const payload = object(await response.json());
    if (!response.ok) {
      throw new Error(
        text(object(payload["error"])["message"]) ?? `Stripe failed (${response.status}).`,
      );
    }
    return payload;
  };

  return {
    async createPaymentIntent(input) {
      const intent = paymentIntent(
        await request(
          "POST",
          "/payment_intents",
          [
            ["amount", String(input.amountMinor)],
            ["currency", input.currency.toLowerCase()],
            ["capture_method", input.captureMethod],
            ["payment_method_types[0]", "card"],
            ["metadata[vayada_property_id]", input.propertyId],
            ["metadata[vayada_booking_reference]", input.bookingReference],
            ...(input.applicationFeeAmountMinor > 0
              ? [["application_fee_amount", String(input.applicationFeeAmountMinor)] as const]
              : []),
          ],
          input.idempotencyKey,
          input.providerAccountRef,
        ),
        input.providerAccountRef,
      );
      if (
        intent.propertyId !== input.propertyId ||
        intent.bookingReference !== input.bookingReference ||
        intent.providerAccountRef !== input.providerAccountRef
      ) {
        throw new Error("Stripe replayed a PaymentIntent for a different property booking.");
      }
      return intent;
    },

    async retrievePaymentIntent(paymentIntentId, providerAccountRef) {
      return paymentIntent(
        await request(
          "GET",
          `/payment_intents/${encodeURIComponent(paymentIntentId)}`,
          [
            ["expand[]", "payment_method"],
            ["expand[]", "latest_charge.balance_transaction"],
          ],
          undefined,
          providerAccountRef,
        ),
        providerAccountRef,
      );
    },

    async capturePaymentIntent(paymentIntentId, providerAccountRef, idempotencyKey) {
      return paymentIntent(
        await request(
          "POST",
          `/payment_intents/${encodeURIComponent(paymentIntentId)}/capture`,
          [["expand[]", "latest_charge.balance_transaction"]],
          idempotencyKey,
          providerAccountRef,
        ),
        providerAccountRef,
      );
    },

    async cancelPaymentIntent(paymentIntentId, providerAccountRef, idempotencyKey) {
      return paymentIntent(
        await request(
          "POST",
          `/payment_intents/${encodeURIComponent(paymentIntentId)}/cancel`,
          [],
          idempotencyKey,
          providerAccountRef,
        ),
        providerAccountRef,
      );
    },
  };
}

function paymentIntent(
  value: StripeObject,
  requestProviderAccountRef: string | null,
): StripeBookingPaymentIntent {
  const paymentIntentId = text(value["id"]);
  const status = text(value["status"]);
  const amountMinor = Number(value["amount"]);
  const currency = text(value["currency"]);
  if (
    !paymentIntentId ||
    !status ||
    !Number.isInteger(amountMinor) ||
    amountMinor < 0 ||
    !currency
  ) {
    throw new Error("Stripe returned an invalid PaymentIntent.");
  }
  const card = object(object(value["payment_method"])["card"]);
  const charge = object(value["latest_charge"]);
  const balanceTransaction = object(charge["balance_transaction"]);
  const balanceTransactionId = text(balanceTransaction["id"]);
  const chargeId = text(charge["id"]);
  const balanceCurrency = text(balanceTransaction["currency"]);
  const balanceGross = integer(balanceTransaction["amount"]);
  const balanceFee = integer(balanceTransaction["fee"]);
  const balanceNet = signedInteger(balanceTransaction["net"]);
  const feeDetails = Array.isArray(balanceTransaction["fee_details"])
    ? balanceTransaction["fee_details"].map(object)
    : [];
  const applicationFeeAmountMinor = feeDetails
    .filter((fee) => text(fee["type"]) === "application_fee")
    .reduce((sum, fee) => sum + (integer(fee["amount"]) ?? 0), 0);
  const detailedProcessorFeeAmountMinor = feeDetails
    .filter((fee) => text(fee["type"]) !== "application_fee")
    .reduce((sum, fee) => sum + (integer(fee["amount"]) ?? 0), 0);
  const processorFeeAmountMinor =
    balanceFee !== null &&
    applicationFeeAmountMinor + detailedProcessorFeeAmountMinor !== balanceFee
      ? Math.max(balanceFee - applicationFeeAmountMinor, 0)
      : detailedProcessorFeeAmountMinor;
  return {
    paymentIntentId,
    clientSecret: text(value["client_secret"]),
    status,
    amountMinor,
    currency: currency.toUpperCase(),
    propertyId: text(object(value["metadata"])["vayada_property_id"]),
    bookingReference: text(object(value["metadata"])["vayada_booking_reference"]),
    providerAccountRef:
      requestProviderAccountRef ?? text(object(value["transfer_data"])["destination"]),
    cardBrand: text(card["brand"]),
    cardLast4: /^\d{4}$/.test(text(card["last4"]) ?? "") ? text(card["last4"]) : null,
    feeBreakdown:
      balanceTransactionId &&
      chargeId &&
      balanceCurrency &&
      balanceGross !== null &&
      balanceFee !== null &&
      balanceNet !== null &&
      applicationFeeAmountMinor + processorFeeAmountMinor === balanceFee
        ? {
            balanceTransactionId,
            chargeId,
            currency: balanceCurrency.toUpperCase(),
            grossAmountMinor: balanceGross,
            processorFeeAmountMinor,
            applicationFeeAmountMinor,
            netPayoutAmountMinor: balanceNet,
          }
        : null,
  };
}

function integer(value: unknown): number | null {
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

function signedInteger(value: unknown): number | null {
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function object(value: unknown): StripeObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as StripeObject) : {};
}
