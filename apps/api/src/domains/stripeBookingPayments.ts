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
  retrievePaymentIntent(paymentIntentId: string): Promise<StripeBookingPaymentIntent>;
  capturePaymentIntent(
    paymentIntentId: string,
    idempotencyKey: string,
  ): Promise<StripeBookingPaymentIntent>;
  cancelPaymentIntent(
    paymentIntentId: string,
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
            ["transfer_data[destination]", input.providerAccountRef],
            ["metadata[vayada_property_id]", input.propertyId],
            ["metadata[vayada_booking_reference]", input.bookingReference],
            ...(input.applicationFeeAmountMinor > 0
              ? [["application_fee_amount", String(input.applicationFeeAmountMinor)] as const]
              : []),
          ],
          input.idempotencyKey,
        ),
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

    async retrievePaymentIntent(paymentIntentId) {
      return paymentIntent(
        await request("GET", `/payment_intents/${encodeURIComponent(paymentIntentId)}`),
      );
    },

    async capturePaymentIntent(paymentIntentId, idempotencyKey) {
      return paymentIntent(
        await request(
          "POST",
          `/payment_intents/${encodeURIComponent(paymentIntentId)}/capture`,
          [],
          idempotencyKey,
        ),
      );
    },

    async cancelPaymentIntent(paymentIntentId, idempotencyKey) {
      return paymentIntent(
        await request(
          "POST",
          `/payment_intents/${encodeURIComponent(paymentIntentId)}/cancel`,
          [],
          idempotencyKey,
        ),
      );
    },
  };
}

function paymentIntent(value: StripeObject): StripeBookingPaymentIntent {
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
  return {
    paymentIntentId,
    clientSecret: text(value["client_secret"]),
    status,
    amountMinor,
    currency: currency.toUpperCase(),
    propertyId: text(object(value["metadata"])["vayada_property_id"]),
    bookingReference: text(object(value["metadata"])["vayada_booking_reference"]),
    providerAccountRef: text(object(value["transfer_data"])["destination"]),
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function object(value: unknown): StripeObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as StripeObject) : {};
}
