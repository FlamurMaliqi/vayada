import {
  PMS_RESERVATION_CONTRACT_VERSION,
  parsePmsInventoryReservationReceipt,
  type CancelPmsReservationCommand,
  type CreatePmsReservationCommand,
  type ListPmsOperationalReservationsQuery,
  type PmsCapability,
  type PmsConnectionStatus,
  type PmsExternalReference,
  type PmsInventoryReservationReceipt,
  type PmsOperationalReservationListResult,
  type PmsOperationalReservationReadModel,
  type PmsOperationalReservationReadPort,
  type PmsProviderKey,
  type PmsReservationError,
  type PmsReservationErrorCode,
  type PmsReservationHandoffResult,
  type PmsReservationSink,
  type UpdatePmsReservationCommand,
} from "@vayada/domain-pms";

export type VayadaPmsReservationAdapter = PmsReservationSink & PmsOperationalReservationReadPort;

export type VayadaPmsConnection = {
  provider: Extract<PmsProviderKey, "vayada_pms">;
  connectionId: string;
  propertyId: string;
  status: PmsConnectionStatus;
  capabilities: PmsCapability[];
};

export type VayadaPmsOfferMapping = {
  roomTypeRef: PmsExternalReference;
  ratePlanRef?: PmsExternalReference;
};

export type VayadaPmsCreateReservationInput = {
  command: CreatePmsReservationCommand;
  mapping: VayadaPmsOfferMapping;
  assignmentPayloadPatch: {
    inventoryReservation?: PmsInventoryReservationReceipt;
  };
};

// prettier-ignore
export type VayadaPmsUpdateReservationInput = { command: UpdatePmsReservationCommand; assignmentPayloadPatch: VayadaPmsCreateReservationInput["assignmentPayloadPatch"] };

export type VayadaPmsIdempotencyRecord = {
  idempotencyKey: string;
  commandFingerprint: string;
  result: PmsReservationHandoffResult;
};

export type VayadaPmsAuditEventInput = {
  action: "create_reservation" | "update_reservation" | "cancel_reservation" | "read_reservation";
  commandId?: string;
  idempotencyKey?: string;
  correlationId?: string;
  requestId?: string;
  propertyId: string;
  guestBookingId?: string;
  pmsReservationRef?: string;
  outcome?: PmsReservationHandoffResult["outcome"];
  errorCode?: PmsReservationErrorCode;
};

export type VayadaPmsReservationRepository = {
  getConnection(input: {
    propertyId: string;
    connectionId: string;
  }): Promise<VayadaPmsConnection | null>;
  getIdempotencyRecord(idempotencyKey: string): Promise<VayadaPmsIdempotencyRecord | null>;
  saveIdempotencyRecord(record: VayadaPmsIdempotencyRecord): Promise<void>;
  resolveCreateMapping(command: CreatePmsReservationCommand): Promise<VayadaPmsOfferMapping | null>;
  createOperationalReservation(
    input: VayadaPmsCreateReservationInput,
  ): Promise<PmsOperationalReservationReadModel>;
  updateOperationalReservation(
    input: VayadaPmsUpdateReservationInput,
  ): Promise<PmsOperationalReservationReadModel | null>;
  cancelOperationalReservation(
    command: CancelPmsReservationCommand,
  ): Promise<PmsOperationalReservationReadModel | null>;
  getOperationalReservation(input: {
    propertyId: string;
    pmsReservationRef?: string;
    operationalReservationId?: string;
    guestBookingId?: string;
  }): Promise<PmsOperationalReservationReadModel | null>;
  listOperationalReservations(
    query: ListPmsOperationalReservationsQuery,
  ): Promise<PmsOperationalReservationListResult>;
  recordAuditEvent(event: VayadaPmsAuditEventInput): Promise<string>;
};

export class VayadaPmsDuplicateReservationError extends Error {
  constructor(message = "Operational reservation already exists for this guest booking.") {
    super(message);
    this.name = "VayadaPmsDuplicateReservationError";
  }
}

export function createVayadaPmsReservationAdapter(
  repository: VayadaPmsReservationRepository,
): VayadaPmsReservationAdapter {
  return new DefaultVayadaPmsReservationAdapter(repository);
}

class DefaultVayadaPmsReservationAdapter implements VayadaPmsReservationAdapter {
  constructor(private readonly repository: VayadaPmsReservationRepository) {}

  async createReservation(
    command: CreatePmsReservationCommand,
  ): Promise<PmsReservationHandoffResult> {
    const validationError = validateCommand(command);
    if (validationError) {
      return this.persistResultOrFailure(command, this.failed(command, validationError));
    }
    const inventoryReservation = parsePmsInventoryReservationReceipt(command.inventoryReservation);
    if (inventoryReservation) command = { ...command, inventoryReservation };

    const replay = await this.idempotencyReplay(command);
    if (replay) {
      return replay;
    }

    const connectionFailure = await this.connectionFailure(command, ["create_reservation"]);
    if (connectionFailure) {
      return this.persistResultOrFailure(command, connectionFailure);
    }

    const mapping = await this.repository.resolveCreateMapping(command);
    if (!mapping) {
      return this.persistResultOrFailure(command, this.failed(command, mappingMissingError()));
    }

    try {
      const assignmentPayloadPatch = command.inventoryReservation
        ? { inventoryReservation: command.inventoryReservation }
        : {};
      const reservation = await this.repository.createOperationalReservation({
        command,
        mapping,
        assignmentPayloadPatch,
      });
      return await this.persistResultOrFailure(
        command,
        await this.succeeded(command, reservation, "succeeded"),
      );
    } catch (error) {
      if (error instanceof VayadaPmsDuplicateReservationError) {
        return this.persistResultOrFailure(
          command,
          this.failed(command, duplicateReservationError()),
        );
      }
      return this.persistResultOrFailure(
        command,
        this.failed(command, retryableIntegrationError(error)),
      );
    }
  }

  async updateReservation(
    command: UpdatePmsReservationCommand,
  ): Promise<PmsReservationHandoffResult> {
    const validationError = validateCommand(command);
    if (validationError) {
      return this.persistResultOrFailure(command, this.failed(command, validationError));
    }
    const inventoryReservation = parsePmsInventoryReservationReceipt(command.inventoryReservation);
    if (inventoryReservation) command = { ...command, inventoryReservation };

    const replay = await this.idempotencyReplay(command);
    if (replay) {
      return replay;
    }

    const connectionFailure = await this.connectionFailure(
      command,
      command.target.requiredCapabilities,
    );
    if (connectionFailure) {
      return this.persistResultOrFailure(command, connectionFailure);
    }

    try {
      const assignmentPayloadPatch = command.inventoryReservation
        ? { inventoryReservation: command.inventoryReservation }
        : {};
      const reservation = await this.repository.updateOperationalReservation({
        command,
        assignmentPayloadPatch,
      });
      if (!reservation) {
        return this.persistResultOrFailure(command, this.failed(command, mappingMissingError()));
      }
      return await this.persistResultOrFailure(
        command,
        await this.succeeded(command, reservation, "succeeded"),
      );
    } catch (error) {
      return this.persistResultOrFailure(
        command,
        this.failed(command, retryableIntegrationError(error)),
      );
    }
  }

  async cancelReservation(
    command: CancelPmsReservationCommand,
  ): Promise<PmsReservationHandoffResult> {
    const validationError = validateCommand(command);
    if (validationError) {
      return this.persistResultOrFailure(command, this.failed(command, validationError));
    }

    const replay = await this.idempotencyReplay(command);
    if (replay) {
      return replay;
    }

    const connectionFailure = await this.connectionFailure(
      command,
      command.target.requiredCapabilities,
    );
    if (connectionFailure) {
      return this.persistResultOrFailure(command, connectionFailure);
    }

    try {
      const reservation = await this.repository.cancelOperationalReservation(command);
      if (!reservation) {
        return this.persistResultOrFailure(command, this.failed(command, mappingMissingError()));
      }
      return await this.persistResultOrFailure(
        command,
        await this.succeeded(command, reservation, "succeeded"),
      );
    } catch (error) {
      return this.persistResultOrFailure(
        command,
        this.failed(command, retryableIntegrationError(error)),
      );
    }
  }

  async getOperationalReservation(input: {
    propertyId: string;
    pmsReservationRef?: string;
    operationalReservationId?: string;
    guestBookingId?: string;
  }): Promise<PmsOperationalReservationReadModel | null> {
    await this.repository.recordAuditEvent({
      action: "read_reservation",
      propertyId: input.propertyId,
      pmsReservationRef: input.pmsReservationRef,
      guestBookingId: input.guestBookingId,
    });
    return this.repository.getOperationalReservation(input);
  }

  async listOperationalReservations(
    query: ListPmsOperationalReservationsQuery,
  ): Promise<PmsOperationalReservationListResult> {
    await this.repository.recordAuditEvent({
      action: "read_reservation",
      propertyId: query.propertyId,
    });
    return this.repository.listOperationalReservations(query);
  }

  private async idempotencyReplay(
    command:
      CreatePmsReservationCommand | UpdatePmsReservationCommand | CancelPmsReservationCommand,
  ): Promise<PmsReservationHandoffResult | null> {
    const existing = await this.repository.getIdempotencyRecord(command.idempotencyKey);
    if (!existing) {
      return null;
    }

    const fingerprint = fingerprintCommand(command);
    if (existing.commandFingerprint !== fingerprint) {
      return this.auditOnlyFailure(command, idempotencyConflictError());
    }

    if (existing.result.outcome === "failed" && !existing.result.error.retryable) {
      return existing.result;
    }
    if (existing.result.outcome === "failed") {
      return null;
    }

    return {
      ...existing.result,
      outcome: "duplicate_replayed",
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      guestBookingId: command.guestBooking.guestBookingId,
      auditEventId: await this.repository.recordAuditEvent({
        action: actionForCommand(command),
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        correlationId: command.audit.correlationId,
        requestId: command.audit.requestId,
        propertyId: command.target.propertyId,
        guestBookingId: command.guestBooking.guestBookingId,
        outcome: "duplicate_replayed",
      }),
    };
  }

  private async connectionFailure(
    command:
      CreatePmsReservationCommand | UpdatePmsReservationCommand | CancelPmsReservationCommand,
    requiredCapabilities: PmsCapability[],
  ): Promise<PmsReservationHandoffResult | null> {
    if (command.target.provider !== "vayada_pms") {
      return this.failed(
        command,
        unsupportedCapabilityError("Vayada PMS adapter only handles vayada_pms."),
      );
    }

    const connection = await this.repository.getConnection({
      propertyId: command.target.propertyId,
      connectionId: command.target.connectionId,
    });
    if (
      !connection ||
      connection.provider !== "vayada_pms" ||
      connection.propertyId !== command.target.propertyId ||
      connection.connectionId !== command.target.connectionId ||
      connection.status === "disconnected" ||
      connection.status === "setup_incomplete"
    ) {
      return this.failed(command, pmsDisconnectedError());
    }
    if (connection.status === "suspended") {
      return this.failed(command, unsupportedCapabilityError("PMS connection is suspended."));
    }
    if (!requiredCapabilities.every((capability) => connection.capabilities.includes(capability))) {
      return this.failed(
        command,
        unsupportedCapabilityError("PMS connection does not support this operation."),
      );
    }

    return null;
  }

  private async succeeded(
    command:
      CreatePmsReservationCommand | UpdatePmsReservationCommand | CancelPmsReservationCommand,
    reservation: PmsOperationalReservationReadModel,
    outcome: Exclude<PmsReservationHandoffResult["outcome"], "failed">,
  ): Promise<PmsReservationHandoffResult> {
    return {
      contractVersion: PMS_RESERVATION_CONTRACT_VERSION,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      outcome,
      guestBookingId: command.guestBooking.guestBookingId,
      pmsReservationRef: reservation.pmsReservationRef,
      operationalReservationId: reservation.operationalReservationId,
      externalReference: reservation.externalReference,
      status: reservation.status,
      providerVersion: reservation.version,
      auditEventId: await this.repository.recordAuditEvent({
        action: actionForCommand(command),
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        correlationId: command.audit.correlationId,
        requestId: command.audit.requestId,
        propertyId: command.target.propertyId,
        guestBookingId: command.guestBooking.guestBookingId,
        pmsReservationRef: reservation.pmsReservationRef,
        outcome,
      }),
    };
  }

  private failed(
    command:
      CreatePmsReservationCommand | UpdatePmsReservationCommand | CancelPmsReservationCommand,
    error: PmsReservationError,
  ): PmsReservationHandoffResult {
    return {
      contractVersion: PMS_RESERVATION_CONTRACT_VERSION,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      outcome: "failed",
      guestBookingId: command.guestBooking.guestBookingId,
      auditEventId: "pending_audit",
      retryAfter: error.retryable ? retryAfterFiveMinutes(command.audit.occurredAt) : undefined,
      error,
    };
  }

  private async auditOnlyFailure(
    command:
      CreatePmsReservationCommand | UpdatePmsReservationCommand | CancelPmsReservationCommand,
    error: PmsReservationError,
  ): Promise<PmsReservationHandoffResult> {
    const result = this.failed(command, error);
    return {
      ...result,
      auditEventId: await this.repository.recordAuditEvent({
        action: actionForCommand(command),
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        correlationId: command.audit.correlationId,
        requestId: command.audit.requestId,
        propertyId: command.target.propertyId,
        guestBookingId: command.guestBooking.guestBookingId,
        outcome: result.outcome,
        errorCode: error.code,
      }),
    };
  }

  private async persistResult(
    command:
      CreatePmsReservationCommand | UpdatePmsReservationCommand | CancelPmsReservationCommand,
    result: PmsReservationHandoffResult,
  ): Promise<PmsReservationHandoffResult> {
    const resultWithAudit =
      result.auditEventId === "pending_audit"
        ? {
            ...result,
            auditEventId: await this.repository.recordAuditEvent({
              action: actionForCommand(command),
              commandId: command.commandId,
              idempotencyKey: command.idempotencyKey,
              correlationId: command.audit.correlationId,
              requestId: command.audit.requestId,
              propertyId: command.target.propertyId,
              guestBookingId: command.guestBooking.guestBookingId,
              outcome: result.outcome,
              errorCode: result.outcome === "failed" ? result.error.code : undefined,
            }),
          }
        : result;

    await this.repository.saveIdempotencyRecord({
      idempotencyKey: command.idempotencyKey,
      commandFingerprint: fingerprintCommand(command),
      result: resultWithAudit,
    });
    return resultWithAudit;
  }

  private async persistResultOrFailure(
    command:
      CreatePmsReservationCommand | UpdatePmsReservationCommand | CancelPmsReservationCommand,
    result: PmsReservationHandoffResult,
  ): Promise<PmsReservationHandoffResult> {
    try {
      return await this.persistResult(command, result);
    } catch (error) {
      return this.auditOnlyFailure(command, retryableIntegrationError(error));
    }
  }
}

function actionForCommand(
  command: CreatePmsReservationCommand | UpdatePmsReservationCommand | CancelPmsReservationCommand,
): VayadaPmsAuditEventInput["action"] {
  if ("cancellation" in command) {
    return "cancel_reservation";
  }
  if ("changes" in command) {
    return "update_reservation";
  }
  return "create_reservation";
}

function validateCommand(
  command: CreatePmsReservationCommand | UpdatePmsReservationCommand | CancelPmsReservationCommand,
): PmsReservationError | null {
  if (command.contractVersion !== PMS_RESERVATION_CONTRACT_VERSION) {
    return validationError("Unsupported PMS reservation contract version.");
  }
  if (!isUtcDateTime(command.audit.occurredAt)) {
    return validationError("Timestamps must be UTC ISO-8601 values.");
  }

  // This portable single-offer adapter has no production repository. Target API
  // handoff adopts bundles through its transactional PMS job consumer instead.
  const offer = isCreateCommand(command)
    ? command.bookedOffer
    : isUpdateCommand(command) ? command.changes.bookedOffer : undefined;
  if (offer && ("roomSelection" in offer || "roomLines" in offer)) {
    return unsupportedCapabilityError("Complete room selections require atomic PMS bundle handoff.");
  }

  if (isCreateCommand(command)) {
    if (
      command.inventoryReservation !== undefined &&
      !parsePmsInventoryReservationReceipt(command.inventoryReservation)
    ) {
      return validationError("Inventory reservation receipt is invalid.");
    }
    if (
      !isIsoDate(command.stay.checkInDate) ||
      !isIsoDate(command.stay.checkOutDate) ||
      !isUtcDateTime(command.guestBooking.createdAt)
    ) {
      return validationError("Stay dates must use YYYY-MM-DD and timestamps must be UTC ISO-8601.");
    }
    if (!isCheckOutAfterCheckIn(command.stay.checkInDate, command.stay.checkOutDate)) {
      return validationError("Check-out must be after check-in.");
    }
    const moneyError = validateMoneyValues([
      command.pricing.roomTotal,
      command.pricing.taxesAndFees,
      command.pricing.discounts,
      command.pricing.addonsTotal,
      command.pricing.grandTotal,
      command.payment.depositAmount,
      command.payment.balanceAmount,
    ]);
    if (moneyError) {
      return moneyError;
    }
  }

  if (isUpdateCommand(command)) {
    if (
      command.inventoryReservation !== undefined &&
      !parsePmsInventoryReservationReceipt(command.inventoryReservation)
    ) {
      return validationError("Inventory reservation receipt is invalid.");
    }
    // prettier-ignore
    if (command.inventoryReservation !== undefined && Object.keys(command.changes.stay ?? {}).length === 0 && command.changes.bookedOffer?.roomTypeId === undefined) return validationError("Inventory reservation receipt requires a stay or room-type update.");
    const stay = command.changes.stay;
    if (
      (stay?.checkInDate !== undefined && !isIsoDate(stay.checkInDate)) ||
      (stay?.checkOutDate !== undefined && !isIsoDate(stay.checkOutDate))
    ) {
      return validationError("Stay dates must use YYYY-MM-DD format.");
    }
    const moneyError = validateMoneyValues([
      command.changes.pricing?.roomTotal,
      command.changes.pricing?.taxesAndFees,
      command.changes.pricing?.discounts,
      command.changes.pricing?.addonsTotal,
      command.changes.pricing?.grandTotal,
      command.changes.payment?.depositAmount,
      command.changes.payment?.balanceAmount,
    ]);
    if (moneyError) {
      return moneyError;
    }
  }

  if (isCancelCommand(command) && !isUtcDateTime(command.cancellation.cancelledAt)) {
    return validationError("Cancellation timestamp must be a UTC ISO-8601 value.");
  }

  return null;
}

function validateMoneyValues(
  moneyValues: Array<{ amountDecimal: string; currency: string } | undefined>,
): PmsReservationError | null {
  for (const money of moneyValues) {
    if (!money) {
      continue;
    }
    if (!/^[A-Z]{3}$/.test(money.currency) || !/^(0|[1-9]\d*)(\.\d+)?$/.test(money.amountDecimal)) {
      return validationError("Money values must use uppercase ISO currency and decimal strings.");
    }
  }
  return null;
}

function fingerprintCommand(command: unknown): string {
  return stableStringify(canonicalIdempotencyPayload(command));
}

function canonicalIdempotencyPayload(command: unknown): unknown {
  if (isCreateCommand(command)) {
    return stripUndefined({
      contractVersion: command.contractVersion,
      target: command.target,
      guestBooking: command.guestBooking,
      inventoryReservation: command.inventoryReservation,
      stay: command.stay,
      guests: command.guests,
      bookedOffer: command.bookedOffer,
      pricing: command.pricing,
      payment: command.payment,
      policy: command.policy,
    });
  }
  if (isUpdateCommand(command)) {
    return stripUndefined({
      contractVersion: command.contractVersion,
      target: command.target,
      guestBooking: command.guestBooking,
      inventoryReservation: command.inventoryReservation,
      changes: command.changes,
      expectedPreviousVersion: command.expectedPreviousVersion,
    });
  }
  if (isCancelCommand(command)) {
    return stripUndefined({
      contractVersion: command.contractVersion,
      target: command.target,
      guestBooking: command.guestBooking,
      cancellation: command.cancellation,
    });
  }
  return stripUndefined(command);
}

function isCreateCommand(command: unknown): command is CreatePmsReservationCommand {
  return typeof command === "object" && command !== null && "stay" in command;
}

function isUpdateCommand(command: unknown): command is UpdatePmsReservationCommand {
  return typeof command === "object" && command !== null && "changes" in command;
}

function isCancelCommand(command: unknown): command is CancelPmsReservationCommand {
  return typeof command === "object" && command !== null && "cancellation" in command;
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUndefined);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .map(([key, entryValue]) => [key, stripUndefined(entryValue)]),
    );
  }
  return value;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isUtcDateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);
}

function isCheckOutAfterCheckIn(checkInDate: string, checkOutDate: string): boolean {
  return Date.parse(`${checkOutDate}T00:00:00.000Z`) > Date.parse(`${checkInDate}T00:00:00.000Z`);
}

function retryAfterFiveMinutes(occurredAt: string): string {
  const parsed = new Date(occurredAt).valueOf();
  const parsedOrNow = Number.isNaN(parsed) ? Date.now() : parsed;
  const base = Math.max(parsedOrNow, Date.now());
  return new Date(base + 5 * 60_000).toISOString();
}

function pmsDisconnectedError(): PmsReservationError {
  return {
    code: "PMS_DISCONNECTED",
    retryable: false,
    userVisibleCategory: "configuration_required",
    sanitizedMessage: "Vayada PMS connection is not ready for reservation handoff.",
  };
}

function unsupportedCapabilityError(message: string): PmsReservationError {
  return {
    code: "UNSUPPORTED_CAPABILITY",
    retryable: false,
    userVisibleCategory: "configuration_required",
    sanitizedMessage: message,
  };
}

function mappingMissingError(): PmsReservationError {
  return {
    code: "MAPPING_MISSING",
    retryable: false,
    userVisibleCategory: "configuration_required",
    sanitizedMessage: "Required PMS property, room, or rate mapping is missing.",
  };
}

function duplicateReservationError(): PmsReservationError {
  return {
    code: "DUPLICATE_RESERVATION",
    retryable: false,
    userVisibleCategory: "already_exists",
    sanitizedMessage: "An operational reservation already exists for this guest booking.",
  };
}

function idempotencyConflictError(): PmsReservationError {
  return {
    code: "IDEMPOTENCY_CONFLICT",
    retryable: false,
    userVisibleCategory: "invalid_request",
    sanitizedMessage: "Idempotency key was reused with a different reservation command.",
  };
}

function validationError(message: string): PmsReservationError {
  return {
    code: "VALIDATION_FAILED",
    retryable: false,
    userVisibleCategory: "invalid_request",
    sanitizedMessage: message,
  };
}

function retryableIntegrationError(_error: unknown): PmsReservationError {
  return {
    code: "RETRYABLE_INTEGRATION_FAILURE",
    retryable: true,
    userVisibleCategory: "temporary_unavailable",
    sanitizedMessage: "Vayada PMS operation failed.",
  };
}
