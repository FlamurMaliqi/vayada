import { Buffer } from "node:buffer";

import {
  StripeConnectAccountNotFoundError,
  type FinanceStripeConnectProvider,
} from "@vayada/domain-finance";

type StripeObject = Record<string, unknown>;

export function createStripeConnectProvider(config: {
  secretKey: string;
  returnBaseUrls: { marketplace: string; bookingAdmin: string };
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
}): FinanceStripeConnectProvider {
  const endpoint = config.endpoint ?? "https://api.stripe.com/v1";
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const requestTimeoutMs = config.requestTimeoutMs ?? 10_000;
  const returnBaseUrls = {
    marketplace: new URL(config.returnBaseUrls.marketplace).origin,
    booking_admin: new URL(config.returnBaseUrls.bookingAdmin).origin,
  } as const;

  const request = async (
    method: "GET" | "POST" | "DELETE",
    path: string,
    fields: ReadonlyArray<readonly [string, string]>,
    idempotencyKey?: string,
    signal?: AbortSignal,
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
        signal: signal ?? AbortSignal.timeout(requestTimeoutMs),
      },
    );
    const payload = object(await response.json());
    if (!response.ok) {
      if (response.status === 404) {
        throw new StripeConnectAccountNotFoundError();
      }
      throw new Error(
        text(object(payload["error"])["message"]) ?? `Stripe failed (${response.status}).`,
      );
    }
    return payload;
  };

  const onboardingLink = async (
    account: string,
    idempotencyKey: string,
    returnSurface: "marketplace" | "booking_admin" = "marketplace",
  ): Promise<string> => {
    const returnBaseUrl = returnBaseUrls[returnSurface];
    const returnPath = returnSurface === "booking_admin" ? "/settings" : "/setup";
    const returnQuery = returnSurface === "booking_admin" ? "section=payments&stripe" : "stripe";
    const result = await request(
      "POST",
      "/account_links",
      [
        ["account", account],
        ["type", "account_onboarding"],
        ["refresh_url", `${returnBaseUrl}${returnPath}?${returnQuery}=refresh`],
        ["return_url", `${returnBaseUrl}${returnPath}?${returnQuery}=return`],
      ],
      idempotencyKey,
    );
    const url = text(result["url"]);
    if (!url) throw new Error("Stripe did not return an onboarding URL.");
    return url;
  };

  return {
    async createAccount(input) {
      const ownerId =
        input.owner.ownerScope === "property" ? input.owner.propertyId : input.owner.affiliateId;
      const account = await request(
        "POST",
        "/accounts",
        [
          ["type", "express"],
          ["email", input.email],
          ["country", input.country],
          ["capabilities[card_payments][requested]", "true"],
          ["capabilities[transfers][requested]", "true"],
          ["metadata[vayada_owner_scope]", input.owner.ownerScope],
          ["metadata[vayada_owner_id]", ownerId],
        ],
        input.idempotencyKey,
      );
      const providerAccountRef = text(account["id"]);
      if (!providerAccountRef) throw new Error("Stripe did not return a connected account ID.");
      return {
        providerAccountRef,
        onboardingUrl: await onboardingLink(
          providerAccountRef,
          `${input.idempotencyKey}:link`,
          input.returnSurface,
        ),
      };
    },
    createOnboardingLink(input) {
      return onboardingLink(input.providerAccountRef, input.idempotencyKey, input.returnSurface);
    },
    async createLoginLink(input) {
      const link = await request(
        "POST",
        `/accounts/${encodeURIComponent(input.providerAccountRef)}/login_links`,
        [],
      );
      const url = text(link["url"]);
      if (!url) throw new Error("Stripe did not return a dashboard login URL.");
      return url;
    },
    async retrieveAccount(input) {
      const account = await request(
        "GET",
        `/accounts/${encodeURIComponent(input.providerAccountRef)}`,
        [],
      );
      return {
        providerAccountRef: requiredText(account, "id"),
        chargesEnabled: account["charges_enabled"] === true,
        payoutsEnabled: account["payouts_enabled"] === true,
        detailsSubmitted: account["details_submitted"] === true,
        cardPaymentsStatus: text(object(account["capabilities"])["card_payments"]),
        defaultCurrency: text(account["default_currency"]),
      };
    },
    async compensateAccountCreation(input) {
      try {
        await request(
          "DELETE",
          `/accounts/${encodeURIComponent(input.providerAccountRef)}`,
          [],
          input.idempotencyKey,
          input.signal,
        );
      } catch (error) {
        if (!(error instanceof StripeConnectAccountNotFoundError)) throw error;
      }
    },
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function object(value: unknown): StripeObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as StripeObject) : {};
}

function requiredText(value: StripeObject, key: string): string {
  const result = text(value[key]);
  if (!result) throw new Error(`Stripe response omitted ${key}.`);
  return result;
}
