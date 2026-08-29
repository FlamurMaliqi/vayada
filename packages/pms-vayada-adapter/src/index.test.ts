import { describe, expect, it } from "vitest";

import {
  PMS_RESERVATION_CONTRACT_VERSION,
  type CancelPmsReservationCommand,
  type CreatePmsReservationCommand,
  type ListPmsOperationalReservationsQuery,
  type PmsOperationalReservationListResult,
  type PmsOperationalReservationReadModel,
  type UpdatePmsReservationCommand,
} from "@vayada/domain-pms";

import {
  VayadaPmsDuplicateReservationError,
  createVayadaPmsReservationAdapter,
  type VayadaPmsConnection,
  type VayadaPmsCreateReservationInput,
  type VayadaPmsIdempotencyRecord,
  type VayadaPmsOfferMapping,
  type VayadaPmsReservationRepository,
  type VayadaPmsUpdateReservationInput,
} from "./index.js";

describe("@vayada/pms-vayada-adapter", () => {
  it("creates an operational reservation through the PMS contract without leaking storage details", async () => {
    const repository = new InMemoryVayadaPmsRepository();
    const adapter = createVayadaPmsReservationAdapter(repository);
    const inventoryReservation = inventoryReceipt("C9FCCEC2-EB4C-4C35-BFD3-02A748C2E117");

    const result = await adapter.createReservation(createCommand({ inventoryReservation }));

    expect(result).toMatchObject({
      contractVersion: PMS_RESERVATION_CONTRACT_VERSION,
      commandId: "cmd_create_123",
      idempotencyKey: "idem_create_123",
      outcome: "succeeded",
      guestBookingId: "book_123",
      pmsReservationRef: "vayada-pms-res-book_123",
      operationalReservationId: "ops_book_123",
      status: "confirmed",
      auditEventId: "audit_1",
    });
    expect(result.pmsReservationRef).not.toContain("bookings");
    expect(result.pmsReservationRef).not.toContain("booking_rooms");
    // prettier-ignore
    expect(repository.lastAssignmentPayloadPatch).toEqual({ inventoryReservation: inventoryReceipt("c9fccec2-eb4c-4c35-bfd3-02a748c2e117") });
  });

  it("replays a matching idempotency key without creating a second operational reservation", async () => {
    const repository = new InMemoryVayadaPmsRepository();
    const adapter = createVayadaPmsReservationAdapter(repository);
    const command = createCommand({
      inventoryReservation: inventoryReceipt("C9FCCEC2-EB4C-4C35-BFD3-02A748C2E117"),
    });

    await expect(adapter.createReservation(command)).resolves.toMatchObject({
      outcome: "succeeded",
    });
    const lowercaseRetry = createCommand({
      inventoryReservation: inventoryReceipt("c9fccec2-eb4c-4c35-bfd3-02a748c2e117"),
    });
    await expect(adapter.createReservation(lowercaseRetry)).resolves.toMatchObject({
      outcome: "duplicate_replayed",
      pmsReservationRef: "vayada-pms-res-book_123",
      auditEventId: "audit_2",
    });
    expect(repository.createCount).toBe(1);
  });

  it("replays semantic retries when only audit metadata changes", async () => {
    const repository = new InMemoryVayadaPmsRepository();
    const adapter = createVayadaPmsReservationAdapter(repository);
    await adapter.createReservation(createCommand());

    await expect(
      adapter.createReservation(
        createCommand({
          commandId: "cmd_create_retry",
          audit: {
            ...createCommand().audit,
            requestId: "req_retry",
            correlationId: "corr_retry",
            occurredAt: "2026-09-01T10:03:00.000Z",
          },
        }),
      ),
    ).resolves.toMatchObject({
      outcome: "duplicate_replayed",
      commandId: "cmd_create_retry",
      idempotencyKey: "idem_create_123",
      pmsReservationRef: "vayada-pms-res-book_123",
    });
    expect(repository.createCount).toBe(1);
  });

  it("rejects idempotency-key reuse with a different command payload", async () => {
    const repository = new InMemoryVayadaPmsRepository();
    const adapter = createVayadaPmsReservationAdapter(repository);
    await adapter.createReservation(
      createCommand({
        inventoryReservation: inventoryReceipt("c9fccec2-eb4c-4c35-bfd3-02a748c2e117"),
      }),
    );

    const conflicting = createCommand({
      inventoryReservation: inventoryReceipt("d9fccec2-eb4c-4c35-bfd3-02a748c2e117"),
    });

    await expect(adapter.createReservation(conflicting)).resolves.toMatchObject({
      outcome: "failed",
      auditEventId: "audit_2",
      error: {
        code: "IDEMPOTENCY_CONFLICT",
        retryable: false,
      },
    });
    expect(repository.createCount).toBe(1);
  });

  it.each([
    ["disconnected", "PMS_DISCONNECTED"],
    ["setup_incomplete", "PMS_DISCONNECTED"],
  ] as const)("maps %s connections to configuration failure", async (status, code) => {
    const repository = new InMemoryVayadaPmsRepository({
      connection: { ...connectedConnection(), status },
    });
    const adapter = createVayadaPmsReservationAdapter(repository);

    await expect(adapter.createReservation(createCommand())).resolves.toMatchObject({
      outcome: "failed",
      error: {
        code,
        retryable: false,
        userVisibleCategory: "configuration_required",
      },
    });
  });

  it("returns unsupported capability before mutating reservations", async () => {
    const repository = new InMemoryVayadaPmsRepository({
      connection: {
        ...connectedConnection(),
        capabilities: ["create_reservation"],
      },
    });
    const adapter = createVayadaPmsReservationAdapter(repository);

    await expect(adapter.cancelReservation(cancelCommand())).resolves.toMatchObject({
      outcome: "failed",
      error: {
        code: "UNSUPPORTED_CAPABILITY",
      },
    });
  });

  it("returns mapping missing when the Booking offer has no PMS mapping", async () => {
    const repository = new InMemoryVayadaPmsRepository({ mapping: null });
    const adapter = createVayadaPmsReservationAdapter(repository);

    await expect(adapter.createReservation(createCommand())).resolves.toMatchObject({
      outcome: "failed",
      error: {
        code: "MAPPING_MISSING",
      },
    });
  });

  it("returns duplicate reservation when another idempotency key targets the same guest booking", async () => {
    const repository = new InMemoryVayadaPmsRepository();
    const adapter = createVayadaPmsReservationAdapter(repository);
    await adapter.createReservation(createCommand());

    await expect(
      adapter.createReservation(
        createCommand({ commandId: "cmd_create_456", idempotencyKey: "idem_create_456" }),
      ),
    ).resolves.toMatchObject({
      outcome: "failed",
      error: {
        code: "DUPLICATE_RESERVATION",
      },
    });
  });

  it("maps repository failures to retryable integration failures with retry timing", async () => {
    const repository = new InMemoryVayadaPmsRepository({ failCreates: true });
    const adapter = createVayadaPmsReservationAdapter(repository);

    await expect(adapter.createReservation(createCommand())).resolves.toMatchObject({
      outcome: "failed",
      retryAfter: "2026-09-01T10:05:00.000Z",
      error: {
        code: "RETRYABLE_INTEGRATION_FAILURE",
        retryable: true,
        userVisibleCategory: "temporary_unavailable",
      },
    });
  });

  it("reattempts retryable failures instead of replaying the previous failed result", async () => {
    const repository = new InMemoryVayadaPmsRepository({ failCreates: true });
    const adapter = createVayadaPmsReservationAdapter(repository);
    const command = createCommand();

    await expect(adapter.createReservation(command)).resolves.toMatchObject({
      outcome: "failed",
      error: { code: "RETRYABLE_INTEGRATION_FAILURE" },
    });

    repository.failCreates = false;

    await expect(adapter.createReservation(command)).resolves.toMatchObject({
      outcome: "succeeded",
      pmsReservationRef: "vayada-pms-res-book_123",
    });
    expect(repository.createCount).toBe(1);
  });

  it("maps idempotency persistence failures to typed retryable results", async () => {
    const repository = new InMemoryVayadaPmsRepository({ failIdempotencySaves: true });
    const adapter = createVayadaPmsReservationAdapter(repository);

    await expect(adapter.createReservation(createCommand())).resolves.toMatchObject({
      outcome: "failed",
      auditEventId: "audit_2",
      error: {
        code: "RETRYABLE_INTEGRATION_FAILURE",
        retryable: true,
      },
    });
    expect(repository.createCount).toBe(1);
  });

  it("updates and cancels existing operational reservations through the same sink contract", async () => {
    const repository = new InMemoryVayadaPmsRepository();
    const adapter = createVayadaPmsReservationAdapter(repository);
    await adapter.createReservation(createCommand());

    await expect(adapter.updateReservation(updateCommand())).resolves.toMatchObject({
      outcome: "succeeded",
      status: "modified",
      providerVersion: "v2",
    });
    // prettier-ignore
    expect(repository.lastUpdatePayloadPatch?.inventoryReservation?.receiptId).toBe("c9fccec2-eb4c-4c35-bfd3-02a748c2e117");
    // prettier-ignore
    await expect(adapter.updateReservation({ ...updateCommand(), inventoryReservation: inventoryReceipt("d9fccec2-eb4c-4c35-bfd3-02a748c2e117") })).resolves.toMatchObject({ outcome: "failed", error: { code: "IDEMPOTENCY_CONFLICT" } });
    await expect(adapter.cancelReservation(cancelCommand())).resolves.toMatchObject({
      outcome: "succeeded",
      status: "cancelled",
      providerVersion: "v3",
    });
  });

  it("serves operational reservation read models without exposing Booking internals", async () => {
    const repository = new InMemoryVayadaPmsRepository();
    const adapter = createVayadaPmsReservationAdapter(repository);
    await adapter.createReservation(createCommand());

    await expect(
      adapter.getOperationalReservation({
        propertyId: "prop_alpenrose",
        guestBookingId: "book_123",
      }),
    ).resolves.toMatchObject({
      provider: "vayada_pms",
      pmsReservationRef: "vayada-pms-res-book_123",
      operationalReservationId: "ops_book_123",
      guestBookingId: "book_123",
      bookingReference: "VAY-2026-0001",
      source: "direct_booking",
      assignment: {
        roomTypeId: "room_type_deluxe",
        assignmentStatus: "unassigned",
      },
    });

    await expect(
      adapter.listOperationalReservations({
        propertyId: "prop_alpenrose",
        dateRange: { from: "2026-09-01", to: "2026-09-30" },
        limit: 10,
        offset: 0,
      }),
    ).resolves.toMatchObject({
      total: 1,
      limit: 10,
      offset: 0,
      reservations: [{ pmsReservationRef: "vayada-pms-res-book_123" }],
    });
  });

  it("validates public contract scalar formats before persisting", async () => {
    const repository = new InMemoryVayadaPmsRepository();
    const adapter = createVayadaPmsReservationAdapter(repository);

    await expect(
      adapter.createReservation(
        createCommand({
          pricing: {
            roomTotal: { amountDecimal: "120.00", currency: "eur" },
            grandTotal: { amountDecimal: "120.00", currency: "eur" },
          },
        }),
      ),
    ).resolves.toMatchObject({
      outcome: "failed",
      auditEventId: "audit_1",
      error: {
        code: "VALIDATION_FAILED",
      },
    });
    expect(repository.createCount).toBe(0);

    await expect(
      adapter.createReservation(
        createCommand({
          stay: {
            checkInDate: "2026-09-15",
            checkOutDate: "2026-09-15",
            adults: 2,
            children: 0,
            numberOfRooms: 1,
          },
          idempotencyKey: "idem_invalid_dates",
        }),
      ),
    ).resolves.toMatchObject({
      outcome: "failed",
      error: {
        code: "VALIDATION_FAILED",
        sanitizedMessage: "Check-out must be after check-in.",
      },
    });
    expect(repository.createCount).toBe(0);
  });

  it("validates update and cancel commands before repository mutation", async () => {
    const repository = new InMemoryVayadaPmsRepository();
    const adapter = createVayadaPmsReservationAdapter(repository);

    await expect(
      adapter.updateReservation({
        ...updateCommand(),
        changes: {
          pricing: {
            grandTotal: { amountDecimal: "12.00", currency: "EUR" },
          },
        },
      }),
    ).resolves.toMatchObject({
      outcome: "failed",
      error: { code: "VALIDATION_FAILED" },
    });

    await expect(
      adapter.cancelReservation({
        ...cancelCommand(),
        cancellation: {
          reason: "guest_requested",
          cancelledAt: "2026-09-03 10:00:00",
        },
      }),
    ).resolves.toMatchObject({
      outcome: "failed",
      error: { code: "VALIDATION_FAILED" },
    });

    expect(repository.updateCount).toBe(0);
    expect(repository.cancelCount).toBe(0);
  });
});

class InMemoryVayadaPmsRepository implements VayadaPmsReservationRepository {
  readonly idempotency = new Map<string, VayadaPmsIdempotencyRecord>();
  readonly reservations = new Map<string, PmsOperationalReservationReadModel>();
  readonly byGuestBooking = new Map<string, string>();
  readonly connection: VayadaPmsConnection;
  readonly mapping: VayadaPmsOfferMapping | null;
  failCreates: boolean;
  readonly failIdempotencySaves: boolean;
  createCount = 0;
  updateCount = 0;
  cancelCount = 0;
  lastUpdatePayloadPatch: VayadaPmsUpdateReservationInput["assignmentPayloadPatch"] | null = null;
  lastAssignmentPayloadPatch: VayadaPmsCreateReservationInput["assignmentPayloadPatch"] | null =
    null;
  private auditCount = 0;

  constructor(
    input: Partial<{
      connection: VayadaPmsConnection;
      mapping: VayadaPmsOfferMapping | null;
      failCreates: boolean;
      failIdempotencySaves: boolean;
    }> = {},
  ) {
    this.connection = input.connection ?? connectedConnection();
    this.mapping = input.mapping === undefined ? offerMapping() : input.mapping;
    this.failCreates = input.failCreates ?? false;
    this.failIdempotencySaves = input.failIdempotencySaves ?? false;
  }

  async getConnection(input: {
    propertyId: string;
    connectionId: string;
  }): Promise<VayadaPmsConnection | null> {
    if (
      this.connection.propertyId !== input.propertyId ||
      this.connection.connectionId !== input.connectionId
    ) {
      return null;
    }
    return this.connection;
  }

  async getIdempotencyRecord(idempotencyKey: string): Promise<VayadaPmsIdempotencyRecord | null> {
    return this.idempotency.get(idempotencyKey) ?? null;
  }

  async saveIdempotencyRecord(record: VayadaPmsIdempotencyRecord): Promise<void> {
    if (this.failIdempotencySaves) {
      throw new Error("idempotency store unavailable");
    }
    this.idempotency.set(record.idempotencyKey, record);
  }

  async resolveCreateMapping(
    command: CreatePmsReservationCommand,
  ): Promise<VayadaPmsOfferMapping | null> {
    if (
      command.target.propertyId !== this.connection.propertyId ||
      command.target.connectionId !== this.connection.connectionId
    ) {
      return null;
    }
    return this.mapping;
  }

  async createOperationalReservation(
    input: VayadaPmsCreateReservationInput,
  ): Promise<PmsOperationalReservationReadModel> {
    if (this.failCreates) {
      throw new Error("write unavailable");
    }
    this.lastAssignmentPayloadPatch = input.assignmentPayloadPatch;
    const { command, mapping } = input;
    if (
      this.byGuestBooking.has(`${command.target.propertyId}:${command.guestBooking.guestBookingId}`)
    ) {
      throw new VayadaPmsDuplicateReservationError();
    }
    this.createCount += 1;
    const reservation = reservationFromCommand(command, mapping);
    this.reservations.set(reservation.pmsReservationRef, reservation);
    this.byGuestBooking.set(
      `${reservation.propertyId}:${command.guestBooking.guestBookingId}`,
      reservation.pmsReservationRef,
    );
    return reservation;
  }

  async updateOperationalReservation({
    command,
    assignmentPayloadPatch,
  }: VayadaPmsUpdateReservationInput): Promise<PmsOperationalReservationReadModel | null> {
    this.updateCount += 1;
    this.lastUpdatePayloadPatch = assignmentPayloadPatch;
    const existing = this.reservations.get(command.target.pmsReservationRef);
    if (!existing) {
      return null;
    }
    const updated = {
      ...existing,
      status: "modified" as const,
      stay: {
        ...existing.stay,
        ...command.changes.stay,
        adults: command.changes.stay?.adults ?? existing.stay.adults,
        children: command.changes.stay?.children ?? existing.stay.children,
      },
      version: "v2",
    };
    this.reservations.set(updated.pmsReservationRef, updated);
    return updated;
  }

  async cancelOperationalReservation(
    command: CancelPmsReservationCommand,
  ): Promise<PmsOperationalReservationReadModel | null> {
    this.cancelCount += 1;
    const existing = this.reservations.get(command.target.pmsReservationRef);
    if (!existing) {
      return null;
    }
    const cancelled = {
      ...existing,
      status: "cancelled" as const,
      version: "v3",
    };
    this.reservations.set(cancelled.pmsReservationRef, cancelled);
    return cancelled;
  }

  async getOperationalReservation(input: {
    propertyId: string;
    pmsReservationRef?: string;
    operationalReservationId?: string;
    guestBookingId?: string;
  }): Promise<PmsOperationalReservationReadModel | null> {
    const reservations = [...this.reservations.values()];
    return (
      reservations.find(
        (reservation) =>
          reservation.propertyId === input.propertyId &&
          (reservation.pmsReservationRef === input.pmsReservationRef ||
            reservation.operationalReservationId === input.operationalReservationId ||
            reservation.guestBookingId === input.guestBookingId),
      ) ?? null
    );
  }

  async listOperationalReservations(
    query: ListPmsOperationalReservationsQuery,
  ): Promise<PmsOperationalReservationListResult> {
    const reservations = [...this.reservations.values()].filter(
      (reservation) => reservation.propertyId === query.propertyId,
    );
    return {
      reservations: reservations.slice(query.offset, query.offset + query.limit),
      total: reservations.length,
      limit: query.limit,
      offset: query.offset,
    };
  }

  async recordAuditEvent(): Promise<string> {
    this.auditCount += 1;
    return `audit_${this.auditCount}`;
  }
}

function connectedConnection(): VayadaPmsConnection {
  return {
    provider: "vayada_pms",
    connectionId: "conn_vayada_pms_alpenrose",
    propertyId: "prop_alpenrose",
    status: "connected",
    capabilities: [
      "create_reservation",
      "update_stay_dates",
      "update_guest_details",
      "update_room_type",
      "cancel_reservation",
      "read_operational_reservation",
    ],
  };
}

function offerMapping(): VayadaPmsOfferMapping {
  return {
    roomTypeRef: {
      provider: "vayada_pms",
      connectionId: "conn_vayada_pms_alpenrose",
      externalRoomTypeId: "pms_room_type_deluxe",
    },
    ratePlanRef: {
      provider: "vayada_pms",
      connectionId: "conn_vayada_pms_alpenrose",
      externalRatePlanId: "pms_rate_standard",
    },
  };
}

function reservationFromCommand(
  command: CreatePmsReservationCommand,
  mapping: VayadaPmsOfferMapping,
): PmsOperationalReservationReadModel {
  return {
    operationalReservationId: `ops_${command.guestBooking.guestBookingId}`,
    pmsReservationRef: `vayada-pms-res-${command.guestBooking.guestBookingId}`,
    guestBookingId: command.guestBooking.guestBookingId,
    bookingReference: command.guestBooking.bookingReference,
    propertyId: command.target.propertyId,
    provider: "vayada_pms",
    source: "direct_booking",
    status: "confirmed",
    stay: {
      checkInDate: command.stay.checkInDate,
      checkOutDate: command.stay.checkOutDate,
      adults: command.stay.adults,
      children: command.stay.children,
    },
    assignment: {
      roomTypeId: command.bookedOffer.roomTypeId,
      roomTypeName: command.bookedOffer.roomName,
      assignmentStatus: "unassigned",
    },
    guestSummary: {
      displayName: `${command.guests.primary.firstName} ${command.guests.primary.lastName}`,
      email: command.guests.primary.email,
      phone: command.guests.primary.phone,
    },
    financialSummary: {
      total: command.pricing.grandTotal,
    },
    externalReference: mapping.roomTypeRef,
    version: "v1",
  };
}

function createCommand(
  overrides: Partial<CreatePmsReservationCommand> = {},
): CreatePmsReservationCommand {
  return {
    contractVersion: PMS_RESERVATION_CONTRACT_VERSION,
    commandId: "cmd_create_123",
    idempotencyKey: "idem_create_123",
    audit: {
      requestId: "req_123",
      correlationId: "corr_123",
      organizationId: "org_alpenrose",
      propertyId: "prop_alpenrose",
      actorType: "guest",
      source: "booking_engine",
      occurredAt: "2026-09-01T10:00:00.000Z",
    },
    target: {
      propertyId: "prop_alpenrose",
      provider: "vayada_pms",
      connectionId: "conn_vayada_pms_alpenrose",
      requiredCapabilities: ["create_reservation"],
    },
    guestBooking: {
      guestBookingId: "book_123",
      bookingReference: "VAY-2026-0001",
      status: "confirmed",
      createdAt: "2026-09-01T09:59:30.000Z",
      source: "direct_booking",
      locale: "en",
    },
    stay: {
      checkInDate: "2026-09-12",
      checkOutDate: "2026-09-15",
      adults: 2,
      children: 0,
      numberOfRooms: 1,
    },
    guests: {
      primary: {
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
      },
    },
    bookedOffer: {
      roomTypeId: "room_type_deluxe",
      ratePlanId: "rate_standard",
      roomName: "Deluxe Room",
    },
    pricing: {
      roomTotal: { amountDecimal: "360.00", currency: "EUR" },
      grandTotal: { amountDecimal: "396.00", currency: "EUR" },
    },
    payment: {
      paymentStatus: "authorized",
      paymentMethod: "card",
    },
    policy: {},
    ...overrides,
  };
}

function inventoryReceipt(receiptId: string) {
  return {
    contractVersion: "pms-inventory-reservation-lifecycle.v1" as const,
    owner: "pms" as const,
    receiptId,
  };
}

function updateCommand(): UpdatePmsReservationCommand {
  return {
    contractVersion: PMS_RESERVATION_CONTRACT_VERSION,
    commandId: "cmd_update_123",
    idempotencyKey: "idem_update_123",
    audit: {
      requestId: "req_update",
      correlationId: "corr_update",
      organizationId: "org_alpenrose",
      propertyId: "prop_alpenrose",
      actorType: "hotel_user",
      source: "pms_admin",
      occurredAt: "2026-09-02T10:00:00.000Z",
    },
    target: {
      propertyId: "prop_alpenrose",
      provider: "vayada_pms",
      connectionId: "conn_vayada_pms_alpenrose",
      pmsReservationRef: "vayada-pms-res-book_123",
      requiredCapabilities: ["update_stay_dates"],
    },
    guestBooking: {
      guestBookingId: "book_123",
      bookingReference: "VAY-2026-0001",
    },
    inventoryReservation: inventoryReceipt("C9FCCEC2-EB4C-4C35-BFD3-02A748C2E117"),
    changes: {
      stay: {
        checkOutDate: "2026-09-16",
      },
    },
    expectedPreviousVersion: "v1",
  };
}

function cancelCommand(): CancelPmsReservationCommand {
  return {
    contractVersion: PMS_RESERVATION_CONTRACT_VERSION,
    commandId: "cmd_cancel_123",
    idempotencyKey: "idem_cancel_123",
    audit: {
      requestId: "req_cancel",
      correlationId: "corr_cancel",
      organizationId: "org_alpenrose",
      propertyId: "prop_alpenrose",
      actorType: "hotel_user",
      source: "pms_admin",
      occurredAt: "2026-09-03T10:00:00.000Z",
    },
    target: {
      propertyId: "prop_alpenrose",
      provider: "vayada_pms",
      connectionId: "conn_vayada_pms_alpenrose",
      pmsReservationRef: "vayada-pms-res-book_123",
      requiredCapabilities: ["cancel_reservation"],
    },
    guestBooking: {
      guestBookingId: "book_123",
      bookingReference: "VAY-2026-0001",
    },
    cancellation: {
      reason: "guest_requested",
      cancelledAt: "2026-09-03T10:00:00.000Z",
    },
  };
}
