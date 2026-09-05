import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { Webhook } from "svix";

import type { PmsInboxDeliveryReceiptPort } from "../jobs/pmsInboxDeliveryReceipts.js";

export const PROVIDER_WEBHOOK_MODES = [
  "observe_only",
  "mutating",
  "ack_only_with_receipt",
] as const;

export type ProviderWebhookMode = (typeof PROVIDER_WEBHOOK_MODES)[number];
export type ProviderWebhookProvider = "stripe" | "xendit" | "channex";

export type ProviderWebhookSecrets = {
  stripe?: string;
  xendit?: string;
  channex?: string;
  resend?: string;
};

export type ProviderWebhookModeConfig = Partial<
  Record<ProviderWebhookProvider, ProviderWebhookMode>
>;

export type ProviderWebhookReceiptInput = {
  provider: ProviderWebhookProvider;
  receiptKey: string;
  receiptKeyHash: string;
  providerEventId: string;
  eventType: string;
  payloadHash: string;
  rawHeaders: Record<string, string>;
  rawPayload: Record<string, unknown>;
  mode: ProviderWebhookMode;
  normalizedPreview: ProviderWebhookNormalizedPreview;
};

export type ProviderWebhookReceiptResult = {
  status: "inserted" | "duplicate" | "conflict";
  receiptId: string;
  lifecycleStatus: ProviderWebhookReceiptLifecycleStatus;
};

export type ProviderWebhookReceiptLifecycleStatus =
  | "observed"
  | "promoted"
  | "succeeded"
  | "failed"
  | "dead_lettered"
  | "ignored"
  | "received"
  | "validated"
  | "normalized";

export type ProviderWebhookPromotionInput = {
  provider: ProviderWebhookProvider;
  receiptId: string;
  receiptKey: string;
  receiptKeyHash: string;
  payloadHash: string;
  rawPayload: Record<string, unknown>;
  normalizedPreview: ProviderWebhookNormalizedPreview;
};

export type ProviderWebhookPromotionResult = {
  status:
    | "promoted"
    | "already_promoted"
    | "already_normalized"
    | "ignored"
    | "failed"
    | "dead_lettered"
    | "incompatible_terminal_state";
  receiptId: string;
  domainEventId?: string;
  jobIds: string[];
  auditEventIds?: string[];
};

export type ProviderWebhookStore = {
  resolveChannexPropertyId?(externalPropertyId: string): Promise<string | null>;
  recordReceipt(input: ProviderWebhookReceiptInput): Promise<ProviderWebhookReceiptResult>;
  promoteReceipt(input: ProviderWebhookPromotionInput): Promise<ProviderWebhookPromotionResult>;
  close?(): Promise<void>;
};

export type ProviderWebhookRoutesOptions = {
  secrets: ProviderWebhookSecrets;
  modes?: ProviderWebhookModeConfig;
  channexBookingPromotionEnabled?: boolean;
  store: ProviderWebhookStore;
  pmsInboxDeliveryReceipts?: Pick<PmsInboxDeliveryReceiptPort, "recordTrustedProviderReceipt">;
  stripeTimestampToleranceSeconds?: number;
  now?: () => Date;
};

export type ProviderWebhookNormalizedPreview = {
  domainEventKey: string;
  domainEventType: string;
  resourceProduct: "booking" | "finance" | "pms" | "platform";
  resourceType: string;
  resourceId: string;
  jobKey: string;
  queueName: string;
  jobType: string;
  payload: Record<string, unknown>;
};

export const registerProviderWebhookRoutes: FastifyPluginAsync<
  ProviderWebhookRoutesOptions
> = async (app: FastifyInstance, options: ProviderWebhookRoutesOptions) => {
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    done(null, typeof body === "string" ? body : body.toString());
  });

  app.post<{ Body: string }>("/webhooks/stripe", async (request, reply) => {
    const secret = options.secrets.stripe;
    if (!secret) return reply.code(503).send({ error: "stripe_webhook_not_configured" });

    const signature = request.headers["stripe-signature"];
    if (typeof signature !== "string" || !signature.trim()) {
      return reply.code(400).send({ error: "missing_stripe_signature" });
    }
    if (
      !verifyStripeSignature({
        payload: request.body,
        signatureHeader: signature,
        secret,
        toleranceSeconds: options.stripeTimestampToleranceSeconds,
        now: options.now,
      })
    ) {
      return reply.code(400).send({ error: "invalid_stripe_signature" });
    }

    const payload = parseJsonPayload(request.body);
    if (!payload.ok) return reply.code(400).send({ error: "invalid_stripe_payload" });

    const eventId = requiredString(payload.value, "id", "Stripe event");
    const eventType = requiredString(payload.value, "type", "Stripe event");
    const receiptKey = `webhook:stripe:${eventId}`;
    const persistedPayload = minimizeStripeWebhookPayload(payload.value);
    return handleAuthenticatedProviderWebhook({
      provider: "stripe",
      eventType,
      mode: modeFor(options, "stripe"),
      receiptKey,
      reply,
      request,
      rawPayload: persistedPayload,
      payloadHash: stripePayloadHash(payload.value),
      store: options.store,
      normalizedPreview: previewStripeEvent(
        persistedPayload,
        receiptKey,
        Math.floor((options.now?.() ?? new Date()).getTime() / 1_000),
      ),
    });
  });

  app.post<{ Body: string }>("/webhooks/xendit", async (request, reply) => {
    const secret = options.secrets.xendit;
    if (!secret) return reply.code(503).send({ error: "xendit_webhook_not_configured" });

    const token = request.headers["x-callback-token"];
    if (typeof token !== "string" || !token.trim()) {
      return reply.code(400).send({ error: "missing_xendit_callback_token" });
    }
    if (!secureCompare(token, secret)) {
      return reply.code(400).send({ error: "invalid_xendit_callback_token" });
    }

    const payload = parseJsonPayload(request.body);
    if (!payload.ok) return reply.code(400).send({ error: "invalid_xendit_payload" });

    const classification = classifyXenditPayload(payload.value);
    return handleAuthenticatedProviderWebhook({
      provider: "xendit",
      eventType: classification.eventType,
      mode: modeFor(options, "xendit"),
      receiptKey: classification.receiptKey,
      reply,
      request,
      rawPayload: payload.value,
      store: options.store,
      normalizedPreview: previewXenditEvent(payload.value, classification),
    });
  });

  app.post<{ Body: string }>("/webhooks/channex", async (request, reply) => {
    const secret = options.secrets.channex;
    if (!secret) return reply.code(503).send({ error: "channex_webhook_not_configured" });

    const token = request.headers["x-vayada-webhook-token"];
    if (typeof token !== "string" || !token.trim()) {
      return reply.code(401).send({ error: "missing_channex_webhook_token" });
    }
    if (!secureCompare(token, secret)) {
      return reply.code(401).send({ error: "invalid_channex_webhook_token" });
    }

    const payload = parseJsonPayload(request.body);
    if (!payload.ok) return reply.code(400).send({ error: "invalid_channex_payload" });

    const classification = await resolveChannexPropertyIdentity(
      options.store,
      classifyChannexPayload(payload.value),
    );
    return handleAuthenticatedProviderWebhook({
      provider: "channex",
      eventType: classification.eventType,
      mode: channexModeFor(options, classification),
      receiptKey: classification.receiptKey,
      reply,
      request,
      rawPayload:
        classification.family === "message" &&
        (classification.propertyOwnerResolved === false ||
          !channexMessageIdentityComplete(classification))
          ? channexUnresolvedMessageTombstone(classification)
          : payload.value,
      payloadHash: channexPayloadHash(payload.value, classification),
      store: options.store,
      normalizedPreview: previewChannexEvent(payload.value, classification),
    });
  });

  app.post<{ Body: string }>("/webhooks/resend", async (request, reply) => {
    const secret = options.secrets.resend;
    if (!secret || !options.pmsInboxDeliveryReceipts)
      return reply.code(503).send({ error: "resend_webhook_not_configured" });
    const id = request.headers["svix-id"];
    const timestamp = request.headers["svix-timestamp"];
    const signature = request.headers["svix-signature"];
    if (typeof id !== "string" || typeof timestamp !== "string" || typeof signature !== "string")
      return reply.code(400).send({ error: "missing_resend_signature" });
    try {
      new Webhook(secret).verify(request.body, {
        "svix-id": id,
        "svix-timestamp": timestamp,
        "svix-signature": signature,
      });
    } catch {
      return reply.code(400).send({ error: "invalid_resend_signature" });
    }

    const payload = parseJsonPayload(request.body);
    if (!payload.ok) return reply.code(400).send({ error: "invalid_resend_payload" });
    if (optionalString(payload.value, "type") !== "email.delivered")
      return reply.code(200).send({ status: "ignored" });
    const data = optionalRecord(payload.value, "data");
    const providerReference = optionalString(data, "email_id");
    const acknowledgedAt = new Date(optionalString(payload.value, "created_at") ?? "");
    if (!providerReference || !Number.isFinite(acknowledgedAt.getTime()))
      return reply.code(400).send({ error: "invalid_resend_delivery_receipt" });

    const result = await options.pmsInboxDeliveryReceipts.recordTrustedProviderReceipt({
      adapter: "resend",
      providerReference,
      receiptType: "delivered",
      providerReceiptId: id,
      acknowledgedAt,
    });
    if (result.matchCount !== 1)
      return reply.code(503).send({ error: "resend_provider_reference_unresolved" });
    return reply.code(200).send({ status: result.recorded ? "recorded" : "ignored_or_duplicate" });
  });
};

export async function promotePulledChannexBookingRevision(input: {
  store: ProviderWebhookStore;
  propertyId: string;
  providerPropertyId: string;
  revision: Record<string, unknown>;
}): Promise<ProviderWebhookPromotionResult | null> {
  const attributes = optionalRecord(input.revision, "attributes");
  const revision = attributes
    ? { ...attributes, id: optionalString(input.revision, "id") ?? attributes["id"] }
    : input.revision;
  const declaredPropertyId = optionalString(revision, "property_id");
  if (declaredPropertyId && declaredPropertyId !== input.providerPropertyId) {
    throw new Error("Pulled Channex revision belongs to another provider property");
  }
  const rawPayload = {
    event: "booking",
    property_id: input.providerPropertyId,
    payload: revision,
  };
  const classified = classifyChannexPayload(rawPayload);
  const classification = {
    ...classified,
    propertyId: input.propertyId,
    providerPropertyId: input.providerPropertyId,
    receiptKey: bookingReceiptKey(input.propertyId, classified),
  };
  if (classification.family !== "booking" || !classification.channelBookingId) {
    throw new Error("Pulled Channex revision has no booking identity");
  }
  const receiptKeyHash = sha256(classification.receiptKey);
  const payloadHash = channexPayloadHash(rawPayload, classification);
  const normalizedPreview = previewChannexEvent(rawPayload, classification, "revision_feed");
  const receipt = await input.store.recordReceipt({
    provider: "channex",
    receiptKey: classification.receiptKey,
    receiptKeyHash,
    providerEventId: classification.receiptKey,
    eventType: classification.eventType,
    payloadHash,
    rawHeaders: { source: "channex-booking-revisions-feed" },
    rawPayload,
    mode: "mutating",
    normalizedPreview,
  });
  if (receipt.status === "conflict")
    throw new Error("Pulled Channex revision conflicts with receipt");
  if (
    receipt.status === "duplicate" &&
    !["observed", "received", "validated", "normalized"].includes(receipt.lifecycleStatus)
  ) {
    return null;
  }
  return input.store.promoteReceipt({
    provider: "channex",
    receiptId: receipt.receiptId,
    receiptKey: classification.receiptKey,
    receiptKeyHash,
    payloadHash,
    rawPayload,
    normalizedPreview,
  });
}

async function handleAuthenticatedProviderWebhook(input: {
  provider: ProviderWebhookProvider;
  eventType: string;
  mode: ProviderWebhookMode;
  receiptKey: string;
  reply: FastifyReply;
  request: FastifyRequest<{ Body: string }>;
  rawPayload: Record<string, unknown>;
  payloadHash?: string;
  store: ProviderWebhookStore;
  normalizedPreview: ProviderWebhookNormalizedPreview;
}) {
  const receiptKeyHash = sha256(input.receiptKey);
  const payloadHash =
    input.payloadHash ?? sha256(stableStringify(canonicalPayload(input.rawPayload)));
  const receipt = await input.store.recordReceipt({
    provider: input.provider,
    receiptKey: input.receiptKey,
    receiptKeyHash,
    providerEventId: input.receiptKey,
    eventType: input.eventType,
    payloadHash,
    rawHeaders: receiptHeaders(input.provider, input.request),
    rawPayload: input.rawPayload,
    mode: input.mode,
    normalizedPreview: input.normalizedPreview,
  });

  if (receipt.status === "conflict") {
    return input.reply.code(409).send({
      error: "provider_webhook_receipt_conflict",
      mode: input.mode,
      provider: input.provider,
      receiptId: receipt.receiptId,
      receiptKey: input.receiptKey,
      lifecycleStatus: receipt.lifecycleStatus,
    });
  }

  if (input.mode === "observe_only") {
    return input.reply.code(200).send({
      status: receipt.status === "duplicate" ? "duplicate_observed" : "observed",
      mode: input.mode,
      provider: input.provider,
      receiptId: receipt.receiptId,
      receiptKey: input.receiptKey,
    });
  }

  if (input.mode === "ack_only_with_receipt") {
    return input.reply.code(200).send({
      status: receipt.status === "duplicate" ? "duplicate_acknowledged" : "acknowledged",
      mode: input.mode,
      provider: input.provider,
      receiptId: receipt.receiptId,
      receiptKey: input.receiptKey,
      replayRequired: true,
    });
  }

  if (
    receipt.status === "duplicate" &&
    receipt.lifecycleStatus !== "observed" &&
    receipt.lifecycleStatus !== "received" &&
    receipt.lifecycleStatus !== "validated" &&
    receipt.lifecycleStatus !== "normalized"
  ) {
    return input.reply.code(200).send({
      status: "duplicate",
      mode: input.mode,
      provider: input.provider,
      receiptId: receipt.receiptId,
      receiptKey: input.receiptKey,
      lifecycleStatus: receipt.lifecycleStatus,
    });
  }

  const promotion = await input.store.promoteReceipt({
    provider: input.provider,
    receiptId: receipt.receiptId,
    receiptKey: input.receiptKey,
    receiptKeyHash,
    payloadHash,
    rawPayload: input.rawPayload,
    normalizedPreview: input.normalizedPreview,
  });

  return input.reply.code(200).send({
    status: promotion.status,
    mode: input.mode,
    provider: input.provider,
    receiptId: receipt.receiptId,
    receiptKey: input.receiptKey,
    domainEventId: promotion.domainEventId,
    jobIds: promotion.jobIds,
    auditEventIds: promotion.auditEventIds ?? [],
  });
}

export function minimizeStripeWebhookPayload(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const eventType = requiredString(value, "type", "Stripe event");
  const dataObject = optionalRecord(optionalRecord(value, "data"), "object") ?? {};
  return definedObject({
    receipt_version: 1,
    id: requiredString(value, "id", "Stripe event"),
    type: eventType,
    created: optionalNumber(value, "created"),
    account: optionalString(value, "account"),
    data: { object: minimizedStripeObject(eventType, dataObject) },
  });
}

function minimizedStripeObject(
  eventType: string,
  object: Record<string, unknown>,
): Record<string, unknown> {
  if (eventType === "account.updated") {
    return definedObject({
      id: optionalString(object, "id"),
      charges_enabled: optionalBoolean(object, "charges_enabled"),
      payouts_enabled: optionalBoolean(object, "payouts_enabled"),
      details_submitted: optionalBoolean(object, "details_submitted"),
      capabilities: definedObject({
        card_payments: optionalString(optionalRecord(object, "capabilities"), "card_payments"),
      }),
      default_currency: optionalString(object, "default_currency"),
    });
  }
  if (eventType.startsWith("payment_intent.")) {
    return definedObject({
      id: optionalString(object, "id"),
      amount: optionalNumber(object, "amount"),
      amount_received: optionalNumber(object, "amount_received"),
      currency: optionalString(object, "currency"),
      status: optionalString(object, "status"),
    });
  }
  if (eventType === "charge.updated") {
    return definedObject({
      id: optionalString(object, "id"),
      payment_intent: stripeReference(object["payment_intent"]),
      balance_transaction: stripeReference(object["balance_transaction"]),
      amount: optionalNumber(object, "amount"),
      currency: optionalString(object, "currency"),
    });
  }
  if (eventType.startsWith("payout.")) {
    return definedObject({
      id: optionalString(object, "id"),
      status: optionalString(object, "status"),
      amount: optionalNumber(object, "amount"),
      currency: optionalString(object, "currency"),
    });
  }
  if (STRIPE_SUBSCRIPTION_EVENT_TYPES.has(eventType)) {
    const details =
      optionalRecord(optionalRecord(object, "parent"), "subscription_details") ??
      optionalRecord(object, "subscription_details");
    return definedObject({
      id: optionalString(object, "id"),
      subscription: stripeReference(object["subscription"]),
      subscription_details: definedObject({
        subscription: stripeReference(details?.["subscription"]),
        metadata: internalStripeMetadata(optionalRecord(details, "metadata")),
      }),
      client_reference_id: optionalString(object, "client_reference_id"),
      customer: stripeReference(object["customer"]),
      metadata: internalStripeMetadata(optionalRecord(object, "metadata")),
    });
  }
  return definedObject({ id: optionalString(object, "id") });
}

function internalStripeMetadata(metadata: Record<string, unknown> | undefined) {
  return definedObject({
    vayada_property_id: optionalString(metadata, "vayada_property_id"),
    vayada_organization_id: optionalString(metadata, "vayada_organization_id"),
  });
}

function stripeReference(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  return value && typeof value === "object" && !Array.isArray(value)
    ? optionalString(value as Record<string, unknown>, "id")
    : undefined;
}

function definedObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(
      ([, value]) =>
        value !== undefined &&
        (!value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          Object.keys(value).length > 0),
    ),
  );
}

function stripePayloadHash(value: Record<string, unknown>): string {
  return sha256(stableStringify(canonicalPayload(redactLegacyStripeHashFields(value))));
}

function redactLegacyStripeHashFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactLegacyStripeHashFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !LEGACY_STRIPE_HASH_DENYLIST.has(key.toLowerCase()))
      .map(([key, nested]) => [key, redactLegacyStripeHashFields(nested)]),
  );
}

const LEGACY_STRIPE_HASH_DENYLIST = new Set([
  "client_secret",
  "secret",
  "access_token",
  "refresh_token",
]);

function modeFor(options: ProviderWebhookRoutesOptions, provider: ProviderWebhookProvider) {
  return options.modes?.[provider] ?? "observe_only";
}

function channexModeFor(
  options: ProviderWebhookRoutesOptions,
  classification: ChannexClassification,
): ProviderWebhookMode {
  const mode = modeFor(options, "channex");
  return mode === "mutating" &&
    ((classification.family === "booking" && !options.channexBookingPromotionEnabled) ||
      (["booking", "message"].includes(classification.family) &&
        classification.propertyOwnerResolved === false) ||
      (classification.family === "message" && !channexMessageIdentityComplete(classification)))
    ? "observe_only"
    : mode;
}

function channexPayloadHash(
  payload: Record<string, unknown>,
  classification: ChannexClassification,
): string {
  if (classification.family === "message") {
    return sha256(
      stableStringify({
        eventType: classification.eventType,
        propertyId: classification.propertyId,
        sourceMessageId: classification.sourceMessageId ?? "unknown",
        threadId: classification.sourceThreadId ?? "unknown",
      }),
    );
  }
  if (
    classification.family !== "booking" ||
    !classification.channelBookingId ||
    !classification.revision
  ) {
    return sha256(stableStringify(canonicalPayload(payload)));
  }
  return sha256(
    stableStringify({
      propertyId: classification.propertyId,
      channelBookingId: classification.channelBookingId,
      revision: classification.revision,
    }),
  );
}

function channexUnresolvedMessageTombstone(
  classification: ChannexClassification,
): Record<string, unknown> {
  return {
    event: classification.eventType,
    property_id: classification.propertyId,
    source_message_id: classification.sourceMessageId ?? "unknown",
    source_thread_id: classification.sourceThreadId ?? "unknown",
    content_retained: false,
  };
}

function channexMessageIdentityComplete(classification: ChannexClassification): boolean {
  return Boolean(classification.sourceMessageId && classification.sourceThreadId);
}

async function resolveChannexPropertyIdentity(
  store: ProviderWebhookStore,
  classification: ChannexClassification,
): Promise<ChannexClassification> {
  if (!["booking", "message"].includes(classification.family)) return classification;
  const providerPropertyId = classification.propertyId;
  if (classification.propertyIdentityConsistent === false) {
    return {
      ...classification,
      providerPropertyId,
      propertyOwnerResolved: false,
    };
  }
  const propertyId = store.resolveChannexPropertyId
    ? await store.resolveChannexPropertyId(providerPropertyId)
    : providerPropertyId;
  return {
    ...classification,
    propertyId: propertyId ?? providerPropertyId,
    providerPropertyId,
    propertyOwnerResolved: propertyId !== null,
    receiptKey:
      classification.family === "booking"
        ? bookingReceiptKey(propertyId ?? providerPropertyId, classification)
        : messageReceiptKey(propertyId ?? providerPropertyId, classification),
  };
}

function messageReceiptKey(propertyId: string, classification: ChannexClassification): string {
  return channexMessageIdentityComplete(classification)
    ? `webhook:channex:message:${propertyId}:${classification.sourceMessageId}`
    : `webhook:channex:message:${propertyId}:${classification.sourceThreadId ?? "unknown"}:${classification.sourceMessageId ?? "unknown"}`;
}

function bookingReceiptKey(propertyId: string, classification: ChannexClassification): string {
  return classification.channelBookingId && classification.revision
    ? `webhook:channex:booking:${propertyId}:${classification.channelBookingId}:${classification.revision}`
    : classification.receiptKey;
}

function verifyStripeSignature(input: {
  payload: string;
  signatureHeader: string;
  secret: string;
  toleranceSeconds?: number;
  now?: () => Date;
}): boolean {
  const fields = new Map<string, string[]>();
  for (const part of input.signatureHeader.split(",")) {
    const [key, value] = part.split("=", 2);
    if (!key || !value) continue;
    fields.set(key, [...(fields.get(key) ?? []), value]);
  }

  const timestamp = fields.get("t")?.[0];
  const signatures = fields.get("v1") ?? [];
  if (!timestamp || signatures.length === 0) return false;

  const timestampSeconds = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(timestampSeconds)) return false;

  const tolerance = input.toleranceSeconds ?? 300;
  const nowSeconds = Math.floor((input.now?.() ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > tolerance) return false;

  const expected = createHmac("sha256", input.secret)
    .update(`${timestamp}.${input.payload}`)
    .digest("hex");
  return signatures.some((signature) => secureCompare(signature, expected));
}

function classifyXenditPayload(payload: Record<string, unknown>): {
  eventType: string;
  receiptKey: string;
  kind: "invoice" | "payout" | "unsupported";
  providerObjectId: string;
  status: string;
} {
  const event = optionalString(payload, "event");
  const data = optionalRecord(payload, "data");
  const invoiceId = optionalString(payload, "id");
  const externalId = optionalString(payload, "external_id");
  const invoiceStatus = optionalString(payload, "status");

  if (invoiceId && externalId && invoiceStatus && !event) {
    const callbackId = optionalString(payload, "callback_id") ?? invoiceId;
    return {
      eventType: "invoice.callback",
      receiptKey: `webhook:xendit:invoice:${callbackId}:${invoiceStatus}`,
      kind: "invoice",
      providerObjectId: invoiceId,
      status: invoiceStatus,
    };
  }

  if (event?.startsWith("v3_payout.") || optionalString(data, "payout_id")) {
    const fallbackKey = sha256(stableStringify(canonicalPayload(payload)));
    return {
      eventType: event ?? "v3_payout.unsupported",
      receiptKey: `webhook:xendit:payout:v3-disabled:${fallbackKey}`,
      kind: "unsupported",
      providerObjectId: "v3-disabled",
      status: "unsupported_v3_payout",
    };
  }

  const payoutId = optionalString(data, "id") ?? optionalString(payload, "id");
  const payoutStatus =
    optionalString(data, "status") ??
    xenditPayoutStatusFromEvent(event) ??
    invoiceStatus ??
    "unknown";
  if (!payoutId) {
    const fallbackKey = sha256(stableStringify(canonicalPayload(payload)));
    return {
      eventType: event ?? "unknown",
      receiptKey: `webhook:xendit:payout:unknown:${fallbackKey}`,
      kind: "payout",
      providerObjectId: "unknown",
      status: payoutStatus,
    };
  }
  return {
    eventType: event ?? "payout.callback",
    receiptKey: `webhook:xendit:payout:${payoutId}:${payoutStatus}`,
    kind: "payout",
    providerObjectId: payoutId,
    status: payoutStatus,
  };
}

function xenditPayoutStatusFromEvent(event: string | undefined): string | undefined {
  switch (event) {
    case "payout.succeeded":
      return "SUCCEEDED";
    case "payout.failed":
      return "FAILED";
    case "payout.reversed":
      return "REVERSED";
    default:
      return undefined;
  }
}

type ChannexEventFamily = "message" | "booking" | "review" | "updated_review" | "unsupported";

type ChannexEventEnvelope = {
  eventType: string;
  family: ChannexEventFamily;
  payload: Record<string, unknown>;
};

type ChannexClassification = {
  eventType: string;
  family: ChannexEventFamily;
  receiptKey: string;
  propertyId: string;
  providerPropertyId?: string;
  propertyOwnerResolved?: boolean;
  propertyIdentityConsistent?: boolean;
  sourceMessageId?: string;
  sourceThreadId?: string;
  channelBookingId?: string;
  revision?: string;
  reviewId?: string;
  reviewRevision?: string;
};

function classifyChannexPayload(payload: Record<string, unknown>): ChannexClassification {
  const nestedPayload = optionalRecord(payload, "payload") ?? {};
  const eventType =
    optionalString(payload, "event") ??
    optionalString(payload, "event_type") ??
    optionalString(payload, "type") ??
    "unknown";
  const envelope: ChannexEventEnvelope = {
    eventType,
    family: channexEventFamily(eventType),
    payload: nestedPayload,
  };
  const suppliedPropertyIds = channexSuppliedPropertyIds(payload, nestedPayload);
  const propertyId = suppliedPropertyIds[0] ?? "unknown";
  const propertyIdentityConsistent =
    suppliedPropertyIds.length > 0 && suppliedPropertyIds.every((value) => value === propertyId);

  if (envelope.family === "message") {
    const message =
      optionalRecord(nestedPayload, "message") ??
      optionalRecord(nestedPayload, "data") ??
      optionalRecord(payload, "message") ??
      {};
    const messageId =
      optionalString(nestedPayload, "message_id") ??
      optionalString(nestedPayload, "source_message_id") ??
      optionalString(nestedPayload, "id") ??
      optionalString(message, "id") ??
      optionalString(message, "source_message_id");
    const sourceThreadId = channexMessageThreadId(payload);
    return {
      eventType,
      family: envelope.family,
      propertyId,
      propertyIdentityConsistent,
      ...(messageId ? { sourceMessageId: messageId } : {}),
      ...(sourceThreadId === "unknown" ? {} : { sourceThreadId }),
      receiptKey: `webhook:channex:message:${propertyId}:${sourceThreadId}:${messageId ?? "unknown"}`,
    };
  }

  if (envelope.family === "booking") {
    const booking =
      optionalRecord(nestedPayload, "booking") ??
      optionalRecord(nestedPayload, "revision") ??
      optionalRecord(payload, "booking") ??
      nestedPayload;
    const revisionId =
      optionalString(nestedPayload, "booking_revision_id") ??
      optionalString(nestedPayload, "revision_id") ??
      optionalString(booking, "booking_revision_id") ??
      optionalString(booking, "revision_id") ??
      optionalString(nestedPayload, "id");
    const channelBookingId =
      optionalString(nestedPayload, "channel_booking_id") ??
      optionalString(nestedPayload, "booking_id") ??
      optionalString(booking, "channel_booking_id") ??
      optionalString(booking, "id");
    const revision =
      revisionId ??
      optionalString(nestedPayload, "revision") ??
      optionalString(nestedPayload, "revision_number") ??
      optionalString(booking, "revision") ??
      optionalString(booking, "revision_number") ??
      "unknown";

    if (revisionId || channelBookingId) {
      return {
        eventType,
        family: envelope.family,
        propertyId,
        propertyIdentityConsistent,
        channelBookingId: channelBookingId ?? revisionId,
        revision,
        receiptKey: `webhook:channex:booking:${propertyId}:${channelBookingId ?? revisionId}:${revision}`,
      };
    }
  }

  if (envelope.family === "review" || envelope.family === "updated_review") {
    const review = optionalRecord(nestedPayload, "review") ?? nestedPayload;
    const reviewId =
      optionalString(nestedPayload, "review_id") ??
      optionalString(nestedPayload, "id") ??
      optionalString(review, "id");
    const reviewRevision =
      optionalString(payload, "timestamp") ??
      optionalString(nestedPayload, "updated_at") ??
      optionalString(review, "updated_at");
    if (reviewId) {
      const revisionMarker =
        envelope.family === "updated_review" ? `:${reviewRevision ?? "unknown"}` : "";
      return {
        eventType,
        family: envelope.family,
        propertyId,
        propertyIdentityConsistent,
        reviewId,
        reviewRevision,
        receiptKey: `webhook:channex:${envelope.family}:${propertyId}:${reviewId}${revisionMarker}`,
      };
    }
  }

  return {
    eventType,
    family: envelope.family,
    propertyId,
    propertyIdentityConsistent,
    receiptKey: `webhook:channex:${eventType}:${propertyId}:${sha256(
      stableStringify(canonicalPayload(payload)),
    )}`,
  };
}

function channexSuppliedPropertyIds(
  payload: Record<string, unknown>,
  nestedPayload: Record<string, unknown>,
): string[] {
  const data = optionalRecord(nestedPayload, "data") ?? {};
  const message = optionalRecord(nestedPayload, "message") ?? data;
  const attributes = optionalRecord(message, "attributes") ?? {};
  const meta = optionalRecord(attributes, "meta") ?? optionalRecord(message, "meta") ?? {};
  const bookingDetails = optionalRecord(meta, "booking_details") ?? {};
  const thread = optionalRecord(nestedPayload, "thread") ?? {};
  const relationships = optionalRecord(message, "relationships") ?? {};
  const relationshipProperty =
    optionalRecord(optionalRecord(relationships, "property"), "data") ?? {};
  return [
    optionalString(payload, "property_id"),
    optionalString(nestedPayload, "property_id"),
    optionalNestedString(nestedPayload, ["property", "id"]),
    optionalString(message, "property_id"),
    optionalString(attributes, "property_id"),
    optionalString(thread, "property_id"),
    optionalString(bookingDetails, "property_id"),
    optionalString(relationshipProperty, "id"),
  ].filter((value): value is string => Boolean(value));
}

function channexMessageThreadId(payload: Record<string, unknown>): string {
  const nested = optionalRecord(payload, "payload") ?? {};
  const data = optionalRecord(nested, "data") ?? {};
  const message = optionalRecord(nested, "message") ?? data;
  const relationships = optionalRecord(message, "relationships") ?? {};
  return (
    optionalString(nested, "thread_id") ??
    optionalString(nested, "message_thread_id") ??
    optionalNestedString(nested, ["thread", "id"]) ??
    optionalNestedString(relationships, ["message_thread", "data", "id"]) ??
    "unknown"
  );
}

function channexEventFamily(eventType: string): ChannexEventFamily {
  if (eventType === "message") return "message";
  if (
    eventType === "booking" ||
    eventType.startsWith("booking.") ||
    ["booking_new", "booking_modification", "booking_cancellation"].includes(eventType)
  )
    return "booking";
  if (eventType === "review") return "review";
  if (eventType === "updated_review") return "updated_review";
  return "unsupported";
}

function previewStripeEvent(
  payload: Record<string, unknown>,
  receiptKey: string,
  eventCreatedFallback: number,
): ProviderWebhookNormalizedPreview {
  const eventType = requiredString(payload, "type", "Stripe event");
  const providerAccountRef = optionalString(payload, "account");
  const providerAccountHash = providerAccountRef ? sha256(providerAccountRef) : "platform";
  const dataObject = optionalRecord(optionalRecord(payload, "data"), "object") ?? {};
  const objectId = optionalString(dataObject, "id") ?? receiptKey;
  const eventId = requiredString(payload, "id", "Stripe event");
  if (STRIPE_SUBSCRIPTION_EVENT_TYPES.has(eventType)) {
    const subscriptionId = stripeSubscriptionId(eventType, dataObject);
    const metadata = stripeSubscriptionMetadata(eventType, dataObject);
    const propertyId =
      optionalString(metadata, "vayada_property_id") ??
      optionalString(dataObject, "client_reference_id");
    const organizationId = optionalString(metadata, "vayada_organization_id");
    const customer = dataObject["customer"];
    const customerId =
      typeof customer === "string"
        ? customer
        : optionalString(optionalRecord(dataObject, "customer"), "id");
    return {
      domainEventKey: `finance.subscription.provider-event:stripe:${eventId}:v1`,
      domainEventType: "finance.subscription.provider-event",
      resourceProduct: "finance",
      resourceType: "billing_subscription",
      resourceId: subscriptionId ?? objectId,
      jobKey: `finance.subscription-webhook:stripe:${eventId}:v1`,
      queueName: "finance.subscriptions",
      jobType: "finance.subscription-webhook",
      payload: {
        provider: "stripe",
        eventType,
        rawEventId: eventId,
        eventCreated: optionalNumber(payload, "created") ?? eventCreatedFallback,
        objectId,
        subscriptionId,
        checkoutSessionId: eventType === "checkout.session.completed" ? objectId : null,
        propertyId,
        organizationId,
        customerId,
      },
    };
  }
  const amount =
    optionalNumber(dataObject, "amount_received") ?? optionalNumber(dataObject, "amount") ?? 0;

  if (eventType === "payment_intent.amount_capturable_updated") {
    return paymentPreview({
      provider: "stripe",
      domainEventType: "payment.authorized",
      semanticAction: `stripe-event-${requiredString(payload, "id", "Stripe event")}`,
      paymentId: objectId,
      amount,
      providerAccountHash,
      domainEventKey: `payment.authorized:stripe:${providerAccountHash}:${objectId}:${amount}:v2`,
      rawPayload: payload,
    });
  }
  if (eventType === "payment_intent.succeeded") {
    return paymentPreview({
      provider: "stripe",
      domainEventType: "payment.captured",
      semanticAction: `stripe-event-${requiredString(payload, "id", "Stripe event")}`,
      paymentId: objectId,
      amount,
      providerAccountHash,
      domainEventKey: `payment.captured:stripe:${providerAccountHash}:${objectId}:${amount}:v2`,
      rawPayload: payload,
    });
  }
  if (eventType === "payment_intent.canceled" || eventType === "payment_intent.payment_failed") {
    const status = optionalString(dataObject, "status") ?? eventType;
    return paymentPreview({
      provider: "stripe",
      domainEventType: "payment.terminal",
      semanticAction: `stripe-event-${requiredString(payload, "id", "Stripe event")}`,
      paymentId: objectId,
      amount,
      providerAccountHash,
      domainEventKey: `payment.terminal:stripe:${providerAccountHash}:${objectId}:${status}:v2`,
      rawPayload: payload,
    });
  }
  if (eventType === "charge.updated") {
    const paymentIntent = dataObject["payment_intent"];
    const paymentIntentId =
      typeof paymentIntent === "string"
        ? paymentIntent
        : optionalString(optionalRecord(dataObject, "payment_intent"), "id");
    const balanceTransaction = dataObject["balance_transaction"];
    const balanceTransactionId =
      typeof balanceTransaction === "string"
        ? balanceTransaction
        : optionalString(optionalRecord(dataObject, "balance_transaction"), "id");
    if (paymentIntentId && balanceTransactionId) {
      return paymentPreview({
        provider: "stripe",
        domainEventType: "payment.fee_updated",
        semanticAction: `stripe-charge-updated-${requiredString(payload, "id", "Stripe event")}`,
        paymentId: paymentIntentId,
        amount,
        providerAccountHash,
        domainEventKey: `payment.fee-updated:stripe:${providerAccountHash}:${paymentIntentId}:${balanceTransactionId}:v1`,
        rawPayload: payload,
      });
    }
  }
  if (eventType === "account.updated") {
    const eventId = requiredString(payload, "id", "Stripe event");
    const providerAccountHash = sha256(objectId);
    const chargesEnabled = optionalBoolean(dataObject, "charges_enabled") ?? false;
    const payoutsEnabled = optionalBoolean(dataObject, "payouts_enabled") ?? false;
    const detailsSubmitted = optionalBoolean(dataObject, "details_submitted") ?? false;
    const cardPaymentsStatus = optionalString(
      optionalRecord(dataObject, "capabilities"),
      "card_payments",
    );
    return {
      domainEventKey: `finance.provider-account.updated:stripe:${providerAccountHash}:${eventId}:v1`,
      domainEventType: "finance.provider-account.updated",
      resourceProduct: "finance",
      resourceType: "provider_account",
      resourceId: providerAccountHash,
      jobKey: `finance.reconcile-provider-account:provider_account:${providerAccountHash}:${eventId}:v1`,
      queueName: "finance.webhooks",
      jobType: "finance.reconcile-provider-account",
      payload: {
        provider: "stripe",
        providerAccountHash,
        chargesEnabled,
        payoutsEnabled,
        detailsSubmitted,
        cardPaymentsStatus,
        defaultCurrency: optionalString(dataObject, "default_currency"),
        rawEventId: eventId,
        eventCreated: optionalNumber(payload, "created") ?? eventCreatedFallback,
      },
    };
  }
  if (eventType.startsWith("payout.")) {
    const status = optionalString(dataObject, "status") ?? eventType.replace("payout.", "");
    return payoutPreview({
      provider: "stripe",
      payoutId: objectId,
      providerStatus: status,
      financeStatus: financePayoutStatus("stripe", status),
      rawPayload: payload,
    });
  }
  return fallbackPreview("stripe", receiptKey, eventType, payload);
}

const STRIPE_SUBSCRIPTION_EVENT_TYPES = new Set([
  "checkout.session.completed",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.upcoming",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

function stripeSubscriptionId(
  eventType: string,
  dataObject: Record<string, unknown>,
): string | undefined {
  if (eventType.startsWith("customer.subscription.")) return optionalString(dataObject, "id");
  const subscription = dataObject["subscription"];
  if (typeof subscription === "string" && subscription.trim()) return subscription.trim();
  const parent = optionalRecord(dataObject, "parent");
  const subscriptionDetails =
    optionalRecord(parent, "subscription_details") ??
    optionalRecord(dataObject, "subscription_details");
  return optionalString(subscriptionDetails, "subscription");
}

function stripeSubscriptionMetadata(
  eventType: string,
  dataObject: Record<string, unknown>,
): Record<string, unknown> {
  if (
    eventType === "checkout.session.completed" ||
    eventType.startsWith("customer.subscription.")
  ) {
    return optionalRecord(dataObject, "metadata") ?? {};
  }
  const parent = optionalRecord(dataObject, "parent");
  const subscriptionDetails =
    optionalRecord(parent, "subscription_details") ??
    optionalRecord(dataObject, "subscription_details");
  return optionalRecord(subscriptionDetails, "metadata") ?? {};
}

function previewXenditEvent(
  payload: Record<string, unknown>,
  classification: ReturnType<typeof classifyXenditPayload>,
): ProviderWebhookNormalizedPreview {
  if (classification.kind === "invoice") {
    const amount = optionalNumber(payload, "paid_amount") ?? optionalNumber(payload, "amount") ?? 0;
    if (classification.status === "PAID" || classification.status === "SETTLED") {
      return paymentPreview({
        provider: "xendit",
        domainEventType: "payment.captured",
        semanticAction: `xendit-status-${classification.status}`,
        paymentId: classification.providerObjectId,
        amount,
        domainEventKey: `payment.captured:xendit:${classification.providerObjectId}:${amount}:v1`,
        rawPayload: payload,
      });
    }
    return paymentPreview({
      provider: "xendit",
      domainEventType: "payment.terminal",
      semanticAction: `xendit-status-${classification.status}`,
      paymentId: classification.providerObjectId,
      amount,
      domainEventKey: `payment.terminal:xendit:${classification.providerObjectId}:${classification.status}:v1`,
      rawPayload: payload,
    });
  }

  if (classification.kind === "unsupported") {
    return fallbackPreview("xendit", classification.receiptKey, classification.eventType, payload);
  }

  return payoutPreview({
    provider: "xendit",
    payoutId: classification.providerObjectId,
    providerStatus: classification.status,
    financeStatus: financePayoutStatus("xendit", classification.status),
    rawPayload: payload,
  });
}

function previewChannexEvent(
  payload: Record<string, unknown>,
  classification: ChannexClassification,
  revisionSource: "webhook_hint" | "revision_feed" = "webhook_hint",
): ProviderWebhookNormalizedPreview {
  if (
    classification.family === "message" &&
    classification.sourceMessageId &&
    classification.sourceThreadId
  ) {
    const threadId = classification.sourceThreadId;
    return {
      domainEventKey: `channex.message.ingest:${classification.propertyId}:${threadId}:${classification.sourceMessageId}:v1`,
      domainEventType: "channex.message.ingest",
      resourceProduct: "pms",
      resourceType: "channel_message",
      resourceId: classification.sourceMessageId,
      jobKey: `channex.ingest-message:channel_message:${classification.propertyId}:${classification.sourceMessageId}:v1`,
      queueName: "pms.channex.webhooks",
      jobType: "channex.ingest-message",
      payload: {
        provider: "channex",
        propertyId: classification.propertyId,
        providerPropertyId: classification.providerPropertyId ?? classification.propertyId,
        propertyOwnerResolved: classification.propertyOwnerResolved === true,
        threadId,
        sourceMessageId: classification.sourceMessageId,
        rawPayload: payload,
      },
    };
  }
  if (classification.family === "booking" && classification.channelBookingId) {
    const revision = classification.revision ?? "unknown";
    return {
      domainEventKey: `channex.booking.ingest:${classification.propertyId}:${classification.channelBookingId}:${revision}:v1`,
      domainEventType: "channex.booking.ingest",
      resourceProduct: "pms",
      resourceType: "channel_booking",
      resourceId: classification.channelBookingId,
      jobKey: `channex.ingest-booking:channel_booking:${classification.propertyId}:${classification.channelBookingId}:revision-${revision}:v1`,
      queueName: "pms.channex.webhooks",
      jobType: "channex.ingest-booking",
      payload: {
        provider: "channex",
        propertyId: classification.propertyId,
        providerPropertyId: classification.providerPropertyId ?? classification.propertyId,
        channelBookingId: classification.channelBookingId,
        revision,
        revisionSource,
        pullRequired: revisionSource === "webhook_hint",
        rawPayload: payload,
      },
    };
  }
  if (
    (classification.family === "review" || classification.family === "updated_review") &&
    classification.reviewId
  ) {
    const family = classification.family;
    const revisionMarker =
      family === "updated_review" ? `:${classification.reviewRevision ?? "unknown"}` : "";
    return {
      domainEventKey: `channex.${family}.received:${classification.propertyId}:${classification.reviewId}${revisionMarker}:v1`,
      domainEventType: `channex.${family}.received`,
      resourceProduct: "pms",
      resourceType: "channel_review",
      resourceId: classification.reviewId,
      jobKey: `channex.review-received:channel_review:${classification.propertyId}:${classification.reviewId}:${family}${revisionMarker}:v1`,
      queueName: "pms.channex.webhooks",
      jobType: "channex.review-received",
      payload: {
        provider: "channex",
        eventFamily: family,
        propertyId: classification.propertyId,
        reviewId: classification.reviewId,
        reviewRevision: classification.reviewRevision,
        rawPayload: payload,
      },
    };
  }
  return fallbackPreview("channex", classification.receiptKey, classification.eventType, payload);
}

function paymentPreview(input: {
  provider: "stripe" | "xendit";
  domainEventType:
    | "payment.authorized"
    | "payment.captured"
    | "payment.terminal"
    | "payment.fee_updated";
  semanticAction: string;
  paymentId: string;
  amount: number;
  providerAccountHash?: string | null;
  domainEventKey: string;
  rawPayload: Record<string, unknown>;
}): ProviderWebhookNormalizedPreview {
  const financeStatus =
    input.domainEventType === "payment.authorized"
      ? "authorized"
      : input.domainEventType === "payment.captured" ||
          input.domainEventType === "payment.fee_updated"
        ? "paid"
        : financePaymentTerminalStatus(input.provider, input.rawPayload);
  return {
    domainEventKey: input.domainEventKey,
    domainEventType: input.domainEventType,
    resourceProduct: "finance",
    resourceType: "payment",
    resourceId: input.paymentId,
    jobKey: `payment.reconcile-status:payment:${input.paymentId}:${input.semanticAction}:v1`,
    queueName: "finance.webhooks",
    jobType: "payment.reconcile-status",
    payload: {
      provider: input.provider,
      providerAccountHash: input.providerAccountHash ?? null,
      paymentId: input.paymentId,
      amount: input.amount,
      currency: optionalString(
        optionalRecord(optionalRecord(input.rawPayload, "data"), "object") ?? input.rawPayload,
        "currency",
      ),
      financeStatus,
    },
  };
}

function payoutPreview(input: {
  provider: "stripe" | "xendit";
  payoutId: string;
  providerStatus: string;
  financeStatus:
    | "pending"
    | "scheduled"
    | "processing"
    | "paid"
    | "failed"
    | "canceled"
    | "reversed";
  rawPayload: Record<string, unknown>;
}): ProviderWebhookNormalizedPreview {
  return {
    domainEventKey: `payout.status:${input.provider}:${input.payoutId}:${input.providerStatus}:v1`,
    domainEventType: "payout.status",
    resourceProduct: "finance",
    resourceType: "payout",
    resourceId: input.payoutId,
    jobKey: `finance.reconcile-payout:payout:${input.payoutId}:${input.provider}-status-${input.providerStatus}:v1`,
    queueName: "finance.webhooks",
    jobType: "finance.reconcile-payout",
    payload: {
      provider: input.provider,
      payoutId: input.payoutId,
      providerStatus: input.providerStatus,
      financeStatus: input.financeStatus,
      rawPayload: input.rawPayload,
    },
  };
}

function financePaymentTerminalStatus(
  provider: "stripe" | "xendit",
  rawPayload: Record<string, unknown>,
): "failed" | "canceled" {
  const dataObject = optionalRecord(optionalRecord(rawPayload, "data"), "object") ?? rawPayload;
  const providerStatus = optionalString(dataObject, "status") ?? "";
  if (
    providerStatus.toLowerCase() === "canceled" ||
    providerStatus.toUpperCase() === "EXPIRED" ||
    providerStatus.toUpperCase() === "CANCELED" ||
    providerStatus.toUpperCase() === "CANCELLED"
  ) {
    return "canceled";
  }
  return provider === "xendit" && providerStatus.toUpperCase() === "VOIDED" ? "canceled" : "failed";
}

function financePayoutStatus(
  provider: "stripe" | "xendit",
  providerStatus: string,
): "pending" | "scheduled" | "processing" | "paid" | "failed" | "canceled" | "reversed" {
  const status = providerStatus.toUpperCase();
  if (status === "PAID" || status === "SUCCEEDED" || status === "COMPLETED") return "paid";
  if (status === "FAILED" || status === "FAILURE") return "failed";
  if (status === "CANCELED" || status === "CANCELLED" || status === "VOIDED") return "canceled";
  if (status === "REVERSED" || status === "RETURNED") return "reversed";
  if (status === "SCHEDULED") return "scheduled";
  if (status === "IN_TRANSIT" || status === "PROCESSING" || status === "PENDING") {
    return provider === "stripe" && status === "PENDING" ? "pending" : "processing";
  }
  return "processing";
}

function fallbackPreview(
  provider: ProviderWebhookProvider,
  receiptKey: string,
  eventType: string,
  rawPayload: Record<string, unknown>,
): ProviderWebhookNormalizedPreview {
  const eventHash = sha256(receiptKey);
  return {
    domainEventKey: `provider.webhook.received:${provider}:${eventHash}:v1`,
    domainEventType: `${provider}.webhook.received`,
    resourceProduct: "platform",
    resourceType: "external_webhook",
    resourceId: eventHash,
    jobKey: `provider.webhook-review:external_webhook:${eventHash}:${eventType}:v1`,
    queueName: "platform.webhooks",
    jobType: "provider.webhook-review",
    payload: {
      provider,
      eventType,
      rawPayload,
    },
  };
}

function parseJsonPayload(
  payload: string,
): { ok: true; value: Record<string, unknown> } | { ok: false } {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function receiptHeaders(
  provider: ProviderWebhookProvider,
  request: FastifyRequest,
): Record<string, string> {
  if (provider === "stripe") return {};
  const sensitive = new Set(["stripe-signature", "x-callback-token", "x-vayada-webhook-token"]);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (sensitive.has(key.toLowerCase())) {
      headers[key] = "redacted";
    } else if (typeof value === "string") {
      headers[key] = value;
    }
  }
  return headers;
}

function secureCompare(received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return (
    receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

function requiredString(data: Record<string, unknown>, key: string, label: string): string {
  const value = optionalString(data, key);
  if (!value) throw new Error(`${label} is missing ${key}`);
  return value;
}

function optionalString(
  data: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = data?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(
  data: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = data?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(
  data: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = data?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function optionalRecord(
  data: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = data?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalNestedString(
  data: Record<string, unknown> | undefined,
  path: readonly string[],
): string | undefined {
  let current: unknown = data;
  for (const segment of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string" && current.trim() ? current.trim() : undefined;
}

function canonicalPayload(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload.map(canonicalPayload);
  if (!payload || typeof payload !== "object") return payload;
  const transportOnlyKeys = new Set([
    "delivery_id",
    "delivered_at",
    "request_id",
    "sent_at",
    "webhook_id",
  ]);
  return Object.fromEntries(
    Object.entries(payload as Record<string, unknown>)
      .filter(([key]) => !transportOnlyKeys.has(key))
      .map(([key, value]) => [key, canonicalPayload(value)]),
  );
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
