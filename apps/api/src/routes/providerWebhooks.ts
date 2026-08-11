import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

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
    | "failed"
    | "dead_lettered"
    | "incompatible_terminal_state";
  receiptId: string;
  domainEventId?: string;
  jobIds: string[];
  auditEventIds?: string[];
};

export type ProviderWebhookStore = {
  recordReceipt(input: ProviderWebhookReceiptInput): Promise<ProviderWebhookReceiptResult>;
  promoteReceipt(input: ProviderWebhookPromotionInput): Promise<ProviderWebhookPromotionResult>;
  close?(): Promise<void>;
};

export type ProviderWebhookRoutesOptions = {
  secrets: ProviderWebhookSecrets;
  modes?: ProviderWebhookModeConfig;
  store: ProviderWebhookStore;
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
    return handleAuthenticatedProviderWebhook({
      provider: "stripe",
      eventType,
      mode: modeFor(options, "stripe"),
      receiptKey,
      reply,
      request,
      rawPayload: payload.value,
      store: options.store,
      normalizedPreview: previewStripeEvent(payload.value, receiptKey),
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

    const classification = classifyChannexPayload(payload.value);
    return handleAuthenticatedProviderWebhook({
      provider: "channex",
      eventType: classification.eventType,
      mode: modeFor(options, "channex"),
      receiptKey: classification.receiptKey,
      reply,
      request,
      rawPayload: payload.value,
      store: options.store,
      normalizedPreview: previewChannexEvent(payload.value, classification),
    });
  });
};

async function handleAuthenticatedProviderWebhook(input: {
  provider: ProviderWebhookProvider;
  eventType: string;
  mode: ProviderWebhookMode;
  receiptKey: string;
  reply: FastifyReply;
  request: FastifyRequest<{ Body: string }>;
  rawPayload: Record<string, unknown>;
  store: ProviderWebhookStore;
  normalizedPreview: ProviderWebhookNormalizedPreview;
}) {
  const receiptKeyHash = sha256(input.receiptKey);
  const receipt = await input.store.recordReceipt({
    provider: input.provider,
    receiptKey: input.receiptKey,
    receiptKeyHash,
    providerEventId: input.receiptKey,
    eventType: input.eventType,
    payloadHash: sha256(stableStringify(canonicalPayload(input.rawPayload))),
    rawHeaders: redactedHeaders(input.request),
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
    payloadHash: sha256(stableStringify(canonicalPayload(input.rawPayload))),
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

function modeFor(options: ProviderWebhookRoutesOptions, provider: ProviderWebhookProvider) {
  return options.modes?.[provider] ?? "observe_only";
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
  sourceMessageId?: string;
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
  const propertyId =
    optionalString(payload, "property_id") ??
    optionalString(envelope.payload, "property_id") ??
    optionalNestedString(envelope.payload, ["property", "id"]) ??
    "unknown";

  if (envelope.family === "message") {
    const message =
      optionalRecord(nestedPayload, "message") ?? optionalRecord(payload, "message") ?? {};
    const messageId =
      optionalString(nestedPayload, "message_id") ??
      optionalString(nestedPayload, "source_message_id") ??
      optionalString(nestedPayload, "id") ??
      optionalString(message, "id") ??
      optionalString(message, "source_message_id");
    if (messageId) {
      return {
        eventType,
        family: envelope.family,
        propertyId,
        sourceMessageId: messageId,
        receiptKey: `webhook:channex:message:${propertyId}:${messageId}`,
      };
    }
  }

  if (envelope.family === "booking") {
    const booking =
      optionalRecord(nestedPayload, "booking") ??
      optionalRecord(nestedPayload, "revision") ??
      optionalRecord(payload, "booking") ??
      {};
    const revisionId =
      optionalString(nestedPayload, "booking_revision_id") ??
      optionalString(nestedPayload, "revision_id") ??
      optionalString(booking, "booking_revision_id") ??
      optionalString(booking, "revision_id");
    const channelBookingId =
      optionalString(nestedPayload, "channel_booking_id") ??
      optionalString(nestedPayload, "booking_id") ??
      optionalString(booking, "channel_booking_id") ??
      optionalString(booking, "id");
    const revision =
      optionalString(nestedPayload, "revision") ??
      optionalString(nestedPayload, "revision_number") ??
      optionalString(booking, "revision") ??
      optionalString(booking, "revision_number") ??
      revisionId ??
      "unknown";

    if (revisionId || channelBookingId) {
      return {
        eventType,
        family: envelope.family,
        propertyId,
        channelBookingId: channelBookingId ?? revisionId,
        revision,
        receiptKey: `webhook:channex:booking:${propertyId}:${revisionId ?? channelBookingId}:${revision}`,
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
    receiptKey: `webhook:channex:${eventType}:${propertyId}:${sha256(
      stableStringify(canonicalPayload(payload)),
    )}`,
  };
}

function channexEventFamily(eventType: string): ChannexEventFamily {
  if (eventType === "message") return "message";
  if (eventType === "booking" || eventType.startsWith("booking.")) return "booking";
  if (eventType === "review") return "review";
  if (eventType === "updated_review") return "updated_review";
  return "unsupported";
}

function previewStripeEvent(
  payload: Record<string, unknown>,
  receiptKey: string,
): ProviderWebhookNormalizedPreview {
  const eventType = requiredString(payload, "type", "Stripe event");
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
        eventCreated: optionalNumber(payload, "created"),
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
      domainEventKey: `payment.authorized:stripe:${objectId}:${amount}:v1`,
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
      domainEventKey: `payment.captured:stripe:${objectId}:${amount}:v1`,
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
      domainEventKey: `payment.terminal:stripe:${objectId}:${status}:v1`,
      rawPayload: payload,
    });
  }
  if (eventType === "account.updated") {
    const chargesEnabled = optionalBoolean(dataObject, "charges_enabled") ?? false;
    return {
      domainEventKey: `finance.provider-account.updated:stripe:${objectId}:${chargesEnabled}:v1`,
      domainEventType: "finance.provider-account.updated",
      resourceProduct: "finance",
      resourceType: "provider_account",
      resourceId: objectId,
      jobKey: `finance.reconcile-provider-account:provider_account:${objectId}:stripe-account-updated:v1`,
      queueName: "finance.webhooks",
      jobType: "finance.reconcile-provider-account",
      payload: {
        provider: "stripe",
        providerAccountId: objectId,
        chargesEnabled,
        rawEventId: requiredString(payload, "id", "Stripe event"),
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
): ProviderWebhookNormalizedPreview {
  if (classification.family === "message" && classification.sourceMessageId) {
    const threadId =
      optionalString(optionalRecord(payload, "payload"), "thread_id") ??
      optionalString(optionalRecord(payload, "payload"), "message_thread_id") ??
      optionalNestedString(optionalRecord(payload, "payload"), ["thread", "id"]) ??
      "unknown";
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
        channelBookingId: classification.channelBookingId,
        revision,
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
  domainEventType: "payment.authorized" | "payment.captured" | "payment.terminal";
  semanticAction: string;
  paymentId: string;
  amount: number;
  domainEventKey: string;
  rawPayload: Record<string, unknown>;
}): ProviderWebhookNormalizedPreview {
  const financeStatus =
    input.domainEventType === "payment.authorized"
      ? "authorized"
      : input.domainEventType === "payment.captured"
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
      paymentId: input.paymentId,
      amount: input.amount,
      financeStatus,
      rawPayload: input.rawPayload,
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

function redactedHeaders(request: FastifyRequest): Record<string, string> {
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
