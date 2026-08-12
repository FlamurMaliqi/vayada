import {
  parseBookingGuestPolicyChangedEvent,
  parseBookingGuestPolicyProjectionReceipt,
  parseBookingGuestPolicyPublicProjection,
  type BookingGuestPolicyCatalogProjectionPort,
  type BookingGuestPolicyProjectionHandlerPort,
  type BookingGuestPolicyProjectionMessage,
  type BookingGuestPolicyProjectionReceiptPort,
  type BookingGuestPolicyReadPort,
} from "@vayada/domain-booking";

export function createBookingGuestPolicyProjectionHandler(dependencies: {
  read: Pick<BookingGuestPolicyReadPort, "getGuestPolicyPublicProjection">;
  catalog: BookingGuestPolicyCatalogProjectionPort;
  receipts: BookingGuestPolicyProjectionReceiptPort;
}): BookingGuestPolicyProjectionHandlerPort {
  return {
    async handleGuestPolicyProjection(input) {
      const message = parseMessage(input);
      if (!message) return rejected("malformed_message");
      let projectionValue: Awaited<
        ReturnType<BookingGuestPolicyReadPort["getGuestPolicyPublicProjection"]>
      >;
      try {
        projectionValue = await dependencies.read.getGuestPolicyPublicProjection({
          organizationId: message.organizationId,
          propertyId: message.event.propertyId,
          revisionId: message.event.revisionId,
          guestPolicyRevision: message.event.guestPolicyRevision,
          outboxEventId: message.outboxEventId,
        });
      } catch {
        return retry("system");
      }
      if (projectionValue === null) return rejected("projection_not_found");
      const projection = parseBookingGuestPolicyPublicProjection(projectionValue);
      if (
        !projection ||
        projection.propertyId !== message.event.propertyId ||
        projection.guestPolicyRevision !== message.event.guestPolicyRevision
      )
        return rejected("projection_contract_violation");

      let resultValue: Awaited<
        ReturnType<BookingGuestPolicyCatalogProjectionPort["projectApprovedGuestPolicy"]>
      >;
      try {
        resultValue = await dependencies.catalog.projectApprovedGuestPolicy({
          outboxEventId: message.outboxEventId,
          projection,
        });
      } catch {
        return retry("provider");
      }
      const result = parseCatalogProjectionResult(resultValue);
      if (!result) return rejected("catalog_projection_malformed");
      if (result.outcome === "unavailable") return retry(result.errorSource);
      if (result.outcome === "malformed") return rejected("catalog_projection_malformed");
      if (
        result.outcome === "source_revision_conflict" &&
        result.observedCatalogProfileRevision === projection.catalogProfileSourceRevision
      )
        return rejected("catalog_projection_malformed");

      try {
        const receiptValue = await dependencies.receipts.recordProjectionReceipt({
          organizationId: message.organizationId,
          propertyId: projection.propertyId,
          revisionId: message.event.revisionId,
          guestPolicyRevision: projection.guestPolicyRevision,
          sourceOutboxEventId: message.outboxEventId,
          bundleHash: projection.bundleHash,
          sourceFingerprint: projection.sourceFingerprint,
          catalogProfileSourceRevision: projection.catalogProfileSourceRevision,
          result,
          recordedAt: message.processedAt,
        });
        const receipt = parseBookingGuestPolicyProjectionReceipt(receiptValue);
        if (
          !receipt ||
          receipt.outcome !== result.outcome ||
          receipt.sourceOutboxEventId !== message.outboxEventId ||
          receipt.projectedGuestPolicyRevision !== projection.guestPolicyRevision ||
          receipt.projectedBundleHash !== projection.bundleHash ||
          receipt.projectedSourceFingerprint !== projection.sourceFingerprint ||
          receipt.catalogProfileSourceRevision !== projection.catalogProfileSourceRevision
        )
          return retry("system");
        if (
          result.outcome === "applied" &&
          (receipt.outcome !== "applied" ||
            receipt.catalogPolicyProjectionRevision !== result.catalogPolicyProjectionRevision)
        )
          return retry("system");
        if (
          result.outcome === "source_revision_conflict" &&
          (receipt.outcome !== "source_revision_conflict" ||
            receipt.observedCatalogProfileRevision !== result.observedCatalogProfileRevision)
        )
          return retry("system");
        return Object.freeze({ outcome: result.outcome, receipt });
      } catch {
        return retry("system");
      }
    },
  };
}

function parseCatalogProjectionResult(
  value: unknown,
): Awaited<
  ReturnType<BookingGuestPolicyCatalogProjectionPort["projectApprovedGuestPolicy"]>
> | null {
  if (
    exactDataRecord(value, ["outcome", "catalogPolicyProjectionRevision"]) &&
    value.outcome === "applied" &&
    positiveRevision(value.catalogPolicyProjectionRevision)
  )
    return Object.freeze({
      outcome: "applied",
      catalogPolicyProjectionRevision: value.catalogPolicyProjectionRevision,
    });
  if (
    exactDataRecord(value, ["outcome", "observedCatalogProfileRevision"]) &&
    value.outcome === "source_revision_conflict" &&
    profileRevision(value.observedCatalogProfileRevision)
  )
    return Object.freeze({
      outcome: "source_revision_conflict",
      observedCatalogProfileRevision: value.observedCatalogProfileRevision,
    });
  if (
    exactDataRecord(value, ["outcome", "errorSource"]) &&
    value.outcome === "unavailable" &&
    (value.errorSource === "provider" || value.errorSource === "system")
  )
    return Object.freeze({ outcome: "unavailable", errorSource: value.errorSource });
  return exactDataRecord(value, ["outcome"]) && value.outcome === "malformed"
    ? Object.freeze({ outcome: "malformed" })
    : null;
}

function parseMessage(value: unknown): BookingGuestPolicyProjectionMessage | null {
  if (
    !exactDataRecord(value, ["organizationId", "outboxEventId", "event", "processedAt"]) ||
    !canonicalUuid(value.organizationId) ||
    !canonicalUuid(value.outboxEventId) ||
    !canonicalIso(value.processedAt)
  )
    return null;
  const event = parseBookingGuestPolicyChangedEvent(value.event);
  return event
    ? Object.freeze({
        organizationId: value.organizationId,
        outboxEventId: value.outboxEventId,
        event,
        processedAt: value.processedAt,
      })
    : null;
}

function rejected(
  code: Extract<
    Awaited<ReturnType<BookingGuestPolicyProjectionHandlerPort["handleGuestPolicyProjection"]>>,
    { outcome: "rejected" }
  >["code"],
) {
  return Object.freeze({ outcome: "rejected" as const, code });
}

function retry(errorSource: "provider" | "system") {
  return Object.freeze({ outcome: "retry" as const, errorSource });
}

function positiveRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 2_147_483_647;
}

function profileRevision(value: unknown): value is string {
  return typeof value === "string" && /^profile:[1-9][0-9]*$/.test(value);
}

function canonicalUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function exactDataRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return (
    Object.keys(descriptors).length === keys.length &&
    Object.keys(descriptors).every((key) => keys.includes(key)) &&
    Object.values(descriptors).every(
      (descriptor) => "value" in descriptor && descriptor.enumerable === true,
    )
  );
}
