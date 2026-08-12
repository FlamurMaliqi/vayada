import { Buffer } from "node:buffer";

import {
  FINANCE_FIXED_PLAN_BASE_AMOUNT_MINOR,
  FINANCE_FIXED_PLAN_CURRENCY,
  FINANCE_FIXED_PLAN_EXTRA_ROOM_AMOUNT_MINOR,
  FINANCE_FIXED_PLAN_INTERVAL_DAYS,
  type StripeFinanceSubscriptionProvider,
  type StripeSubscriptionSnapshot,
} from "@vayada/domain-finance";

type StripeFetch = typeof globalThis.fetch;
type StripeObject = Record<string, unknown>;

const FIXED_PRICE_LOOKUP_KEY = "vayada_fixed_eur_30d_v1";

export function createStripeFinanceSubscriptionProvider(config: {
  secretKey: string;
  fixedPlanPriceId?: string;
  endpoint?: string;
  fetch?: StripeFetch;
}): StripeFinanceSubscriptionProvider {
  const endpoint = config.endpoint ?? "https://api.stripe.com/v1";
  const fetchImpl = config.fetch ?? globalThis.fetch;
  let fixedPriceId = config.fixedPlanPriceId;
  let fixedPriceVerified = false;

  const request = async (
    method: "GET" | "POST",
    path: string,
    fields: ReadonlyArray<readonly [string, string]> = [],
    idempotencyKey?: string,
  ): Promise<StripeObject> => {
    const query = new URLSearchParams(fields.map(([key, value]): [string, string] => [key, value]));
    const response = await fetchImpl(
      `${endpoint}${path}${method === "GET" && fields.length ? `?${query}` : ""}`,
      {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.secretKey}:`).toString("base64")}`,
          ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        ...(method === "POST" ? { body: query.toString() } : {}),
      },
    );
    const payload = asObject(await response.json());
    if (!response.ok) {
      const error = asObject(payload["error"]);
      throw new Error(text(error["message"]) ?? `Stripe request failed with ${response.status}.`);
    }
    return payload;
  };

  const verifyFixedPrice = async (priceId: string): Promise<void> => {
    const price = await request("GET", `/prices/${encodeURIComponent(priceId)}`, [
      ["expand[]", "tiers"],
    ]);
    assertCanonicalFixedPrice(price, priceId);
  };

  const ensureFixedPrice = async (): Promise<string> => {
    if (fixedPriceId && fixedPriceVerified) return fixedPriceId;
    if (fixedPriceId) {
      await verifyFixedPrice(fixedPriceId);
      fixedPriceVerified = true;
      return fixedPriceId;
    }
    const existing = await request("GET", "/prices", [
      ["lookup_keys[]", FIXED_PRICE_LOOKUP_KEY],
      ["active", "true"],
      ["limit", "1"],
    ]);
    const existingPrice = objectArray(existing["data"])[0];
    const existingId = text(existingPrice?.["id"]);
    if (existingId) {
      await verifyFixedPrice(existingId);
      fixedPriceId = existingId;
      fixedPriceVerified = true;
      return existingId;
    }

    const created = await request(
      "POST",
      "/prices",
      [
        ["currency", FINANCE_FIXED_PLAN_CURRENCY.toLowerCase()],
        ["product_data[name]", "Vayada Fixed"],
        ["recurring[interval]", "day"],
        ["recurring[interval_count]", String(FINANCE_FIXED_PLAN_INTERVAL_DAYS)],
        ["billing_scheme", "tiered"],
        ["tiers_mode", "graduated"],
        ["tiers[0][up_to]", "1"],
        ["tiers[0][unit_amount]", String(FINANCE_FIXED_PLAN_BASE_AMOUNT_MINOR)],
        ["tiers[1][up_to]", "inf"],
        ["tiers[1][unit_amount]", String(FINANCE_FIXED_PLAN_EXTRA_ROOM_AMOUNT_MINOR)],
        ["lookup_key", FIXED_PRICE_LOOKUP_KEY],
        ["metadata[vayada_plan]", "fixed"],
      ],
      "vayada-fixed-eur-30d-price-v1",
    );
    const createdId = text(created["id"]);
    if (!createdId) throw new Error("Stripe did not return a fixed-plan Price ID.");
    await verifyFixedPrice(createdId);
    fixedPriceId = createdId;
    fixedPriceVerified = true;
    return createdId;
  };

  return {
    async createFixedPlanCheckout(input) {
      const priceId = await ensureFixedPrice();
      const fields: Array<readonly [string, string]> = [
        ["mode", "subscription"],
        ["success_url", input.successUrl],
        ["cancel_url", input.cancelUrl],
        ["client_reference_id", input.propertyId],
        ["payment_method_types[0]", "card"],
        ["line_items[0][price]", priceId],
        ["line_items[0][quantity]", String(Math.max(input.activeRoomCount, 1))],
        ["subscription_data[proration_behavior]", "none"],
        ["subscription_data[metadata][vayada_property_id]", input.propertyId],
        ["subscription_data[metadata][vayada_organization_id]", input.organizationId],
        ["subscription_data[metadata][vayada_plan]", "fixed"],
        ["metadata[vayada_property_id]", input.propertyId],
        ["metadata[vayada_organization_id]", input.organizationId],
        ["metadata[vayada_active_room_count]", String(input.activeRoomCount)],
      ];
      fields.push(
        input.existingCustomerId
          ? ["customer", input.existingCustomerId]
          : ["customer_email", input.customerEmail],
      );
      const session = await request("POST", "/checkout/sessions", fields, input.idempotencyKey);
      const checkoutSessionId = requiredText(session, "id");
      const checkoutUrl = requiredText(session, "url");
      return { checkoutSessionId, checkoutUrl };
    },

    async expireFixedPlanCheckout(input) {
      await request(
        "POST",
        `/checkout/sessions/${encodeURIComponent(input.checkoutSessionId)}/expire`,
        [],
        input.idempotencyKey,
      );
    },

    async createCustomerPortal(input) {
      const session = await request(
        "POST",
        "/billing_portal/sessions",
        [
          ["customer", input.customerId],
          ["return_url", input.returnUrl],
        ],
        input.idempotencyKey,
      );
      return { portalUrl: requiredText(session, "url") };
    },

    async cancelAtPeriodEnd(input) {
      const priceId = await ensureFixedPrice();
      const subscription = await request(
        "POST",
        `/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
        [
          ["cancel_at_period_end", "true"],
          ["proration_behavior", "none"],
        ],
        input.idempotencyKey,
      );
      return subscriptionSnapshot(subscription, priceId);
    },

    async retrieveSubscription(subscriptionId) {
      const priceId = await ensureFixedPrice();
      return subscriptionSnapshot(
        await request("GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`),
        priceId,
      );
    },

    async updateRoomQuantity(input) {
      const priceId = await ensureFixedPrice();
      const subscription = await request(
        "POST",
        `/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
        [
          ["items[0][id]", input.subscriptionItemId],
          ["items[0][quantity]", String(Math.max(input.activeRoomCount, 1))],
          ["proration_behavior", "none"],
        ],
        input.idempotencyKey,
      );
      return subscriptionSnapshot(subscription, priceId);
    },
  };
}

function assertCanonicalFixedPrice(price: StripeObject, expectedId: string): void {
  const recurring = asObject(price["recurring"]);
  const metadata = asObject(price["metadata"]);
  const tiers = objectArray(price["tiers"]);
  const firstTier = tiers[0] ?? {};
  const extraTier = tiers[1] ?? {};
  const valid =
    text(price["id"]) === expectedId &&
    price["active"] !== false &&
    text(price["currency"])?.toUpperCase() === FINANCE_FIXED_PLAN_CURRENCY &&
    text(price["billing_scheme"]) === "tiered" &&
    text(price["tiers_mode"]) === "graduated" &&
    text(price["lookup_key"]) === FIXED_PRICE_LOOKUP_KEY &&
    text(metadata["vayada_plan"]) === "fixed" &&
    text(recurring["interval"]) === "day" &&
    Number(recurring["interval_count"]) === FINANCE_FIXED_PLAN_INTERVAL_DAYS &&
    Number(firstTier["up_to"]) === 1 &&
    Number(firstTier["unit_amount"]) === FINANCE_FIXED_PLAN_BASE_AMOUNT_MINOR &&
    (extraTier["up_to"] === null || text(extraTier["up_to"]) === "inf") &&
    Number(extraTier["unit_amount"]) === FINANCE_FIXED_PLAN_EXTRA_ROOM_AMOUNT_MINOR;
  if (!valid) {
    throw new Error("Stripe Fixed Plan Price does not match the canonical Vayada billing terms.");
  }
}

function subscriptionSnapshot(
  value: StripeObject,
  expectedPriceId: string,
): StripeSubscriptionSnapshot {
  const items = objectArray(asObject(value["items"])["data"]);
  const item = items[0] ?? {};
  const price = asObject(item["price"]);
  const recurring = asObject(price["recurring"]);
  const priceMetadata = asObject(price["metadata"]);
  const subscriptionMetadata = asObject(value["metadata"]);
  const customer = value["customer"];
  const propertyId = text(subscriptionMetadata["vayada_property_id"]);
  const organizationId = text(subscriptionMetadata["vayada_organization_id"]);
  return {
    subscriptionId: requiredText(value, "id"),
    customerId: typeof customer === "string" ? customer : requiredText(asObject(customer), "id"),
    status: text(value["status"]) ?? "unknown",
    propertyId,
    organizationId,
    fixedPlanVerified:
      text(price["id"]) === expectedPriceId &&
      text(price["currency"])?.toUpperCase() === FINANCE_FIXED_PLAN_CURRENCY &&
      text(price["billing_scheme"]) === "tiered" &&
      text(price["tiers_mode"]) === "graduated" &&
      text(price["lookup_key"]) === FIXED_PRICE_LOOKUP_KEY &&
      text(priceMetadata["vayada_plan"]) === "fixed" &&
      text(recurring["interval"]) === "day" &&
      Number(recurring["interval_count"]) === FINANCE_FIXED_PLAN_INTERVAL_DAYS &&
      text(subscriptionMetadata["vayada_plan"]) === "fixed" &&
      Boolean(propertyId) &&
      Boolean(organizationId),
    currentPeriodStart: stripeTimestamp(
      item["current_period_start"] ?? value["current_period_start"],
    ),
    currentPeriodEnd: stripeTimestamp(item["current_period_end"] ?? value["current_period_end"]),
    cancelAtPeriodEnd: value["cancel_at_period_end"] === true,
    subscriptionItemId: text(item["id"]),
  };
}

function stripeTimestamp(value: unknown): string | null {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp * 1_000).toISOString()
    : null;
}

function requiredText(value: StripeObject, key: string): string {
  const result = text(value[key]);
  if (!result) throw new Error(`Stripe response omitted ${key}.`);
  return result;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asObject(value: unknown): StripeObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as StripeObject) : {};
}

function objectArray(value: unknown): StripeObject[] {
  return Array.isArray(value) ? value.map(asObject) : [];
}
