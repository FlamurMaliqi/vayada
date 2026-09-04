import { Buffer } from "node:buffer";

import {
  FINANCE_FIXED_PLAN_CURRENCY,
  FINANCE_FIXED_PLAN_INTERVAL_MONTHS,
  fixedPlanAmountMinor,
  type FinanceBillingDetails,
  type FinanceBillingInvoice,
  type FinanceSavedCard,
  type StripeFinanceSubscriptionProvider,
  type StripeSubscriptionSnapshot,
} from "@vayada/domain-finance";

type StripeFetch = typeof globalThis.fetch;
type StripeObject = Record<string, unknown>;

export function createStripeFinanceSubscriptionProvider(config: {
  secretKey: string;
  fixedPlanPriceId?: string;
  endpoint?: string;
  fetch?: StripeFetch;
}): StripeFinanceSubscriptionProvider {
  const endpoint = config.endpoint ?? "https://api.stripe.com/v1";
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const fixedPriceIds = new Map<string, string>();
  const configuredPriceIds = new Map<string, string>();
  const verifiedPriceIds = new Set<string>();
  if (config.fixedPlanPriceId)
    configuredPriceIds.set(FINANCE_FIXED_PLAN_CURRENCY, config.fixedPlanPriceId);

  const request = async (
    method: "GET" | "POST" | "DELETE",
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
          ...(method !== "GET" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        ...(method !== "GET" ? { body: query.toString() } : {}),
      },
    );
    const payload = asObject(await response.json());
    if (!response.ok) {
      const error = asObject(payload["error"]);
      throw new Error(text(error["message"]) ?? `Stripe request failed with ${response.status}.`);
    }
    return payload;
  };

  const verifyFixedPrice = async (priceId: string, currency: string): Promise<void> => {
    const price = await request("GET", `/prices/${encodeURIComponent(priceId)}`, [
      ["expand[]", "tiers"],
    ]);
    assertCanonicalFixedPrice(price, priceId, currency);
  };

  const ensureFixedPrice = async (rawCurrency: string): Promise<string> => {
    const currency = normalizedCurrency(rawCurrency);
    const lookupKey = fixedPriceLookupKey(currency);
    const configuredId = configuredPriceIds.get(currency);
    if (configuredId) {
      const configuredPrice = await request("GET", `/prices/${encodeURIComponent(configuredId)}`, [
        ["expand[]", "tiers"],
      ]);
      if (isCanonicalFixedPrice(configuredPrice, configuredId, currency)) {
        fixedPriceIds.set(currency, configuredId);
        verifiedPriceIds.add(configuredId);
        configuredPriceIds.delete(currency);
        return configuredId;
      }
      if (!isLegacyFixedPrice(configuredPrice, configuredId, currency)) {
        throw new Error(
          "Stripe Fixed Plan Price does not match the canonical Vayada billing terms.",
        );
      }
      configuredPriceIds.delete(currency);
    }
    const currentId = fixedPriceIds.get(currency);
    if (currentId && verifiedPriceIds.has(currentId)) return currentId;
    const existing = await request("GET", "/prices", [
      ["lookup_keys[]", lookupKey],
      ["active", "true"],
      ["limit", "1"],
    ]);
    const existingPrice = objectArray(existing["data"])[0];
    const existingId = text(existingPrice?.["id"]);
    if (existingId) {
      await verifyFixedPrice(existingId, currency);
      fixedPriceIds.set(currency, existingId);
      verifiedPriceIds.add(existingId);
      return existingId;
    }

    const baseAmountMinor = fixedPlanAmountMinor(1, currency);
    const extraAmountMinor = fixedPlanAmountMinor(2, currency) - baseAmountMinor;

    const created = await request(
      "POST",
      "/prices",
      [
        ["currency", currency.toLowerCase()],
        ["product_data[name]", "Vayada Fixed"],
        ["recurring[interval]", "month"],
        ["recurring[interval_count]", String(FINANCE_FIXED_PLAN_INTERVAL_MONTHS)],
        ["billing_scheme", "tiered"],
        ["tiers_mode", "graduated"],
        ["tiers[0][up_to]", "1"],
        ["tiers[0][unit_amount]", String(baseAmountMinor)],
        ["tiers[1][up_to]", "inf"],
        ["tiers[1][unit_amount]", String(extraAmountMinor)],
        ["lookup_key", lookupKey],
        ["metadata[vayada_plan]", "fixed"],
      ],
      `vayada-fixed-${currency.toLowerCase()}-monthly-price-v2`,
    );
    const createdId = text(created["id"]);
    if (!createdId) throw new Error("Stripe did not return a fixed-plan Price ID.");
    await verifyFixedPrice(createdId, currency);
    fixedPriceIds.set(currency, createdId);
    verifiedPriceIds.add(createdId);
    return createdId;
  };

  const verifiedSnapshot = async (value: StripeObject): Promise<StripeSubscriptionSnapshot> =>
    subscriptionSnapshot(value);

  return {
    async createFixedPlanCheckout(input) {
      const priceId = await ensureFixedPrice(input.currency);
      const fields: Array<readonly [string, string]> = [
        ["mode", "subscription"],
        ["success_url", input.successUrl],
        ["cancel_url", input.cancelUrl],
        ["client_reference_id", input.propertyId],
        ["payment_method_types[0]", "card"],
        ["line_items[0][price]", priceId],
        ["line_items[0][quantity]", String(Math.max(input.activeRoomCount, 1))],
        ["subscription_data[billing_cycle_anchor]", stripeUnixTimestamp(input.billingCycleAnchor)],
        ["subscription_data[proration_behavior]", "create_prorations"],
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

    async createFixedPlanInvoiceSubscription(input) {
      const priceId = await ensureFixedPrice(input.currency);
      const subscription = await request(
        "POST",
        "/subscriptions",
        [
          ["customer", input.customerId],
          ["items[0][price]", priceId],
          ["items[0][quantity]", String(Math.max(input.activeRoomCount, 1))],
          ["collection_method", "send_invoice"],
          ["days_until_due", "14"],
          ["billing_cycle_anchor", stripeUnixTimestamp(input.billingCycleAnchor)],
          ["proration_behavior", "create_prorations"],
          ["metadata[vayada_property_id]", input.propertyId],
          ["metadata[vayada_organization_id]", input.organizationId],
          ["metadata[vayada_plan]", "fixed"],
        ],
        input.idempotencyKey,
      );
      return verifiedSnapshot(subscription);
    },

    async createFixedPlanCardSubscription(input) {
      const priceId = await ensureFixedPrice(input.currency);
      const subscription = await request(
        "POST",
        "/subscriptions",
        [
          ["customer", input.customerId],
          ["items[0][price]", priceId],
          ["items[0][quantity]", String(Math.max(input.activeRoomCount, 1))],
          ["collection_method", "charge_automatically"],
          ["billing_cycle_anchor", stripeUnixTimestamp(input.billingCycleAnchor)],
          ["proration_behavior", "create_prorations"],
          ["payment_behavior", "error_if_incomplete"],
          ["metadata[vayada_property_id]", input.propertyId],
          ["metadata[vayada_organization_id]", input.organizationId],
          ["metadata[vayada_plan]", "fixed"],
        ],
        input.idempotencyKey,
      );
      return verifiedSnapshot(subscription);
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
      const subscription = await request(
        "POST",
        `/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
        [
          ["cancel_at_period_end", "true"],
          ["proration_behavior", "none"],
        ],
        input.idempotencyKey,
      );
      return verifiedSnapshot(subscription);
    },

    async cancelImmediately(input) {
      const subscription = await request(
        "DELETE",
        `/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
        [
          ["invoice_now", "true"],
          ["prorate", "true"],
        ],
        input.idempotencyKey,
      );
      return verifiedSnapshot(subscription);
    },

    async getCustomerBilling(customerId) {
      const customer = await request("GET", `/customers/${encodeURIComponent(customerId)}`, [
        ["expand[]", "invoice_settings.default_payment_method"],
      ]);
      const invoiceSettings = asObject(customer["invoice_settings"]);
      const defaultPaymentMethod = invoiceSettings["default_payment_method"];
      const paymentMethod =
        typeof defaultPaymentMethod === "string"
          ? await request("GET", `/payment_methods/${encodeURIComponent(defaultPaymentMethod)}`)
          : asObject(defaultPaymentMethod);
      return { savedCard: savedCard(paymentMethod) };
    },

    async upsertCustomer(input) {
      const path = input.customerId
        ? `/customers/${encodeURIComponent(input.customerId)}`
        : "/customers";
      const customer = await request(
        "POST",
        path,
        customerFields(input.billingDetails, input.propertyId, input.organizationId),
        input.idempotencyKey,
      );
      return { customerId: requiredText(customer, "id") };
    },

    async listInvoices(customerId) {
      const response = await request("GET", "/invoices", [
        ["customer", customerId],
        ["limit", "100"],
      ]);
      return objectArray(response["data"])
        .map(invoice)
        .sort((left, right) => right.issuedAt.localeCompare(left.issuedAt));
    },

    async updateCollectionMethod(input) {
      const fields: Array<readonly [string, string]> =
        input.paymentMethod === "bank_transfer"
          ? [
              ["collection_method", "send_invoice"],
              ["days_until_due", "14"],
            ]
          : [["collection_method", "charge_automatically"]];
      const subscription = await request(
        "POST",
        `/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
        fields,
        input.idempotencyKey,
      );
      return verifiedSnapshot(subscription);
    },

    async retrieveSubscription(subscriptionId) {
      return verifiedSnapshot(
        await request("GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`),
      );
    },

    async updateRoomQuantity(input) {
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
      return verifiedSnapshot(subscription);
    },
  };
}

function isCanonicalFixedPrice(
  price: StripeObject,
  expectedId: string,
  rawCurrency: string,
): boolean {
  const currency = normalizedCurrency(rawCurrency);
  const baseAmountMinor = fixedPlanAmountMinor(1, currency);
  const extraAmountMinor = fixedPlanAmountMinor(2, currency) - baseAmountMinor;
  const recurring = asObject(price["recurring"]);
  const metadata = asObject(price["metadata"]);
  const tiers = objectArray(price["tiers"]);
  const firstTier = tiers[0] ?? {};
  const extraTier = tiers[1] ?? {};
  return (
    text(price["id"]) === expectedId &&
    price["active"] !== false &&
    text(price["currency"])?.toUpperCase() === currency &&
    text(price["billing_scheme"]) === "tiered" &&
    text(price["tiers_mode"]) === "graduated" &&
    text(price["lookup_key"]) === fixedPriceLookupKey(currency) &&
    text(metadata["vayada_plan"]) === "fixed" &&
    text(recurring["interval"]) === "month" &&
    Number(recurring["interval_count"]) === FINANCE_FIXED_PLAN_INTERVAL_MONTHS &&
    Number(firstTier["up_to"]) === 1 &&
    Number(firstTier["unit_amount"]) === baseAmountMinor &&
    (extraTier["up_to"] === null || text(extraTier["up_to"]) === "inf") &&
    Number(extraTier["unit_amount"]) === extraAmountMinor
  );
}

function assertCanonicalFixedPrice(
  price: StripeObject,
  expectedId: string,
  currency: string,
): void {
  if (!isCanonicalFixedPrice(price, expectedId, currency)) {
    throw new Error("Stripe Fixed Plan Price does not match the canonical Vayada billing terms.");
  }
}

function isLegacyFixedPrice(price: StripeObject, expectedId: string, rawCurrency: string): boolean {
  const currency = normalizedCurrency(rawCurrency);
  const recurring = asObject(price["recurring"]);
  const metadata = asObject(price["metadata"]);
  return (
    text(price["id"]) === expectedId &&
    price["active"] !== false &&
    text(price["currency"])?.toUpperCase() === currency &&
    text(price["billing_scheme"]) === "tiered" &&
    text(price["tiers_mode"]) === "graduated" &&
    text(price["lookup_key"]) === legacyFixedPriceLookupKey(currency) &&
    text(metadata["vayada_plan"]) === "fixed" &&
    text(recurring["interval"]) === "day" &&
    Number(recurring["interval_count"]) === 30
  );
}

function subscriptionSnapshot(value: StripeObject): StripeSubscriptionSnapshot {
  const items = objectArray(asObject(value["items"])["data"]);
  const item = items[0] ?? {};
  const price = asObject(item["price"]);
  const recurring = asObject(price["recurring"]);
  const priceMetadata = asObject(price["metadata"]);
  const subscriptionMetadata = asObject(value["metadata"]);
  const customer = value["customer"];
  const propertyId = text(subscriptionMetadata["vayada_property_id"]);
  const organizationId = text(subscriptionMetadata["vayada_organization_id"]);
  const currency = normalizedCurrency(text(price["currency"]) ?? "");
  const currentTerms =
    text(price["lookup_key"]) === fixedPriceLookupKey(currency) &&
    text(recurring["interval"]) === "month" &&
    Number(recurring["interval_count"]) === FINANCE_FIXED_PLAN_INTERVAL_MONTHS;
  const legacyTerms =
    text(price["lookup_key"]) === legacyFixedPriceLookupKey(currency) &&
    text(recurring["interval"]) === "day" &&
    Number(recurring["interval_count"]) === 30;
  return {
    subscriptionId: requiredText(value, "id"),
    customerId: typeof customer === "string" ? customer : requiredText(asObject(customer), "id"),
    status: text(value["status"]) ?? "unknown",
    propertyId,
    organizationId,
    fixedPlanVerified:
      /^[A-Z]{3}$/.test(currency) &&
      text(price["billing_scheme"]) === "tiered" &&
      text(price["tiers_mode"]) === "graduated" &&
      text(priceMetadata["vayada_plan"]) === "fixed" &&
      (currentTerms || legacyTerms) &&
      text(subscriptionMetadata["vayada_plan"]) === "fixed" &&
      Boolean(propertyId) &&
      Boolean(organizationId),
    currentPeriodStart: stripeTimestamp(
      item["current_period_start"] ?? value["current_period_start"],
    ),
    currentPeriodEnd: stripeTimestamp(item["current_period_end"] ?? value["current_period_end"]),
    cancelAtPeriodEnd: value["cancel_at_period_end"] === true,
    subscriptionItemId: text(item["id"]),
    currency,
  };
}

function fixedPriceLookupKey(currency: string): string {
  return `vayada_fixed_${normalizedCurrency(currency).toLowerCase()}_monthly_v2`;
}

function legacyFixedPriceLookupKey(currency: string): string {
  return `vayada_fixed_${normalizedCurrency(currency).toLowerCase()}_30d_v1`;
}

function normalizedCurrency(value: string): string {
  const currency = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Stripe currency must be a three-letter code.");
  return currency;
}

function customerFields(
  details: FinanceBillingDetails,
  propertyId: string,
  organizationId: string,
): Array<readonly [string, string]> {
  const fields: Array<readonly [string, string]> = [
    ["name", details.companyName],
    ["email", details.billingEmail],
    ["metadata[vayada_property_id]", propertyId],
    ["metadata[vayada_organization_id]", organizationId],
  ];
  if (details.taxId) {
    fields.push(
      ["metadata[vayada_tax_id]", details.taxId],
      ["invoice_settings[custom_fields][0][name]", "Tax ID"],
      ["invoice_settings[custom_fields][0][value]", details.taxId],
    );
  } else {
    fields.push(["invoice_settings[custom_fields]", ""]);
  }
  return fields;
}

function savedCard(paymentMethod: StripeObject): FinanceSavedCard | null {
  const card = asObject(paymentMethod["card"]);
  const last4 = text(card["last4"]);
  const expiryMonth = Number(card["exp_month"]);
  const expiryYear = Number(card["exp_year"]);
  if (!last4 || !Number.isInteger(expiryMonth) || !Number.isInteger(expiryYear)) return null;
  return {
    brand: text(card["brand"]) ?? "card",
    last4,
    expiryMonth,
    expiryYear,
  };
}

function invoice(value: StripeObject): FinanceBillingInvoice {
  const created = Number(value["created"]);
  const transitions = asObject(value["status_transitions"]);
  const paidAt = Number(transitions["paid_at"]);
  const effectiveAt = Number(value["effective_at"]);
  const date =
    Number.isFinite(paidAt) && paidAt > 0
      ? paidAt
      : Number.isFinite(effectiveAt) && effectiveAt > 0
        ? effectiveAt
        : created;
  const issuedAt = new Date(date * 1_000).toISOString();
  const providerNumber = text(value["number"]);
  const sequence = (providerNumber?.match(/(\d+)$/)?.[1] ?? String(created % 10_000)).slice(-4);
  const status = text(value["status"]);
  const paymentAttemptFailed = status === "open" && Number(value["attempt_count"]) > 0;
  return {
    id: requiredText(value, "id"),
    number: `INV-${new Date(issuedAt).getUTCFullYear()}-${sequence.padStart(4, "0")}`,
    issuedAt,
    amountMinor: Math.max(0, Number(value["amount_paid"]) || Number(value["amount_due"]) || 0),
    currency: normalizedCurrency(text(value["currency"]) ?? ""),
    status:
      status === "paid"
        ? "paid"
        : paymentAttemptFailed || ["void", "uncollectible"].includes(status ?? "")
          ? "failed"
          : "pending",
    pdfUrl: httpsUrl(value["invoice_pdf"]),
  };
}

function stripeTimestamp(value: unknown): string | null {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp * 1_000).toISOString()
    : null;
}

function stripeUnixTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error("Billing cycle anchor must be an ISO date.");
  return String(Math.floor(milliseconds / 1_000));
}

function requiredText(value: StripeObject, key: string): string {
  const result = text(value[key]);
  if (!result) throw new Error(`Stripe response omitted ${key}.`);
  return result;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function httpsUrl(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function asObject(value: unknown): StripeObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as StripeObject) : {};
}

function objectArray(value: unknown): StripeObject[] {
  return Array.isArray(value) ? value.map(asObject) : [];
}
