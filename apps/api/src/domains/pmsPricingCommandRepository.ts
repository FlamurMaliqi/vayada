import { createHash, randomUUID } from "node:crypto";

import {
  PMS_PRICING_CONTRACT_VERSION,
  PMS_PRICING_CURRENCY_CHANGE_BLOCKER_CODES,
  parseFlexibleRatePlanCommandResult,
  parsePropertyPricingCurrencyCommandResult,
  serializeFlexibleRatePlanFingerprint,
  serializePropertyPricingCurrencyFingerprint,
  type FlexibleRatePlanCommandError,
  type FlexibleRatePlanCommandResult,
  type FlexibleCancellationTerms,
  type PmsPricingCommandPort,
  type PmsPricingCurrency,
  type PmsPricingCurrencyChangeBlocker,
  type PmsPricingCurrencyChangeGuardPort,
  type PmsPricingSourceChangedEvent,
  type PropertyPricingCurrencyCommandError,
  type PropertyPricingCurrencyCommandResult,
  type UpsertFlexibleRatePlanCommand,
  type UpsertPropertyPricingCurrencyCommand,
} from "@vayada/domain-pms";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import {
  pmsFlexibleRatePlanSnapshotFromRow,
  pmsPricingCurrencySnapshotFromRow,
  type PmsFlexibleRatePlanRow,
  type PmsPricingCurrencyRow,
} from "./pmsPricingReadModel.js";
import { PMS_PRICING_CURRENCY_CAPABILITIES_PORT } from "./pmsPricingCurrencyCapabilities.js";

export type PmsPricingCommandClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type PmsPricingCommandPool = {
  connect(): Promise<PmsPricingCommandClient>;
  end(): Promise<void>;
};

export type PmsPricingCommandRepositoryConfig = {
  connectionString: string;
  currencyChangeGuard: PmsPricingCurrencyChangeGuardPort;
  max?: number;
  pool?: PmsPricingCommandPool;
  now?: () => Date;
  randomId?: () => string;
};

export type PmsPricingCommandRepository = PmsPricingCommandPort & { close(): Promise<void> };

type AnyCommand = UpsertPropertyPricingCurrencyCommand | UpsertFlexibleRatePlanCommand;
type AnyResult = PropertyPricingCurrencyCommandResult | FlexibleRatePlanCommandResult;

type IdempotencyRow = {
  id: string;
  status: string;
  requestFingerprintHash: string;
  responseStatusCode: number | null;
  responseBodyHash: string | null;
  idempotencyMetadata: unknown;
  expiresAt: Date | string;
};

type IdempotencyReservation = { id: string; attempt: number };

type CommandSpec<C extends AnyCommand, R extends AnyResult> = {
  operation: string;
  serializeFingerprint(command: C): string;
  parseResult(value: unknown): R | null;
  scopeFailure(): R;
  coordinationFailure(code: "idempotency_key_conflict" | "command_in_progress"): R;
};

type AcceptedChange = {
  event: PmsPricingSourceChangedEvent;
  resourceType: "property_pricing" | "flexible_rate_plan";
  resourceId: string;
};

type CommandWorkResult<R extends AnyResult> = { result: R; change?: AcceptedChange };

type LockedCurrencyRow = PmsPricingCurrencyRow;
type LockedRoomTypeRow = { roomFactsRevision: number | string };
type LocalBlockerCountsRow = {
  flexibleRatePlanCount: number | string;
  legacyRoomTypePriceCount: number | string;
  legacyRatePlanCount: number | string;
  rateRuleCount: number | string;
};
type LegacyCurrencyRow = { currency: string };

const CURRENCY_OPERATION = "pms.pricing_currency.upsert";
const PLAN_OPERATION = "pms.flexible_rate_plan.upsert";
const MANAGE_PERMISSION = "pms.operations.manage";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CURRENCY_RETURNING = `
  property_id::text AS "propertyId",
  currency::text AS currency,
  pricing_currency_revision AS "pricingCurrencyRevision",
  created_at AS "createdAt",
  updated_at AS "updatedAt"`;

const PLAN_RETURNING = `
  property_id::text AS "propertyId",
  room_type_id::text AS "roomTypeId",
  id::text AS "flexibleRatePlanId",
  flexible_rate_plan_revision AS "flexibleRatePlanRevision",
  source_room_facts_revision AS "sourceRoomFactsRevision",
  base_rate_amount::text AS "amountDecimal",
  currency::text AS currency,
  cancellation_policy_snapshot AS "cancellationTerms",
  created_at AS "createdAt",
  updated_at AS "updatedAt"`;

const CURRENCY_SPEC: CommandSpec<
  UpsertPropertyPricingCurrencyCommand,
  PropertyPricingCurrencyCommandResult
> = {
  operation: CURRENCY_OPERATION,
  serializeFingerprint: serializePropertyPricingCurrencyFingerprint,
  parseResult: parsePropertyPricingCurrencyCommandResult,
  scopeFailure: () => currencyFailure({ code: "setup_scope_unavailable" }),
  coordinationFailure: (code) => currencyFailure({ code }),
};

const PLAN_SPEC: CommandSpec<UpsertFlexibleRatePlanCommand, FlexibleRatePlanCommandResult> = {
  operation: PLAN_OPERATION,
  serializeFingerprint: serializeFlexibleRatePlanFingerprint,
  parseResult: parseFlexibleRatePlanCommandResult,
  scopeFailure: () => planFailure({ code: "setup_scope_unavailable" }),
  coordinationFailure: (code) => planFailure({ code }),
};

export function createPgPmsPricingCommandRepository(
  config: PmsPricingCommandRepositoryConfig,
): PmsPricingCommandRepository {
  if (!config.connectionString.trim()) {
    throw new Error("PMS pricing command repository connectionString must not be empty");
  }
  if (!config.currencyChangeGuard) {
    throw new Error("PMS pricing command repository requires a currency-change guard");
  }
  const ownsPool = !config.pool;
  const pool: PmsPricingCommandPool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  const now = config.now ?? (() => new Date());
  const makeId = config.randomId ?? randomUUID;
  let closed = false;

  async function runCommand<C extends AnyCommand, R extends AnyResult>(
    command: C,
    spec: CommandSpec<C, R>,
    work: (client: PmsPricingCommandClient, acceptedAt: Date) => Promise<CommandWorkResult<R>>,
  ): Promise<R> {
    const acceptedAt = now();
    if (!validDate(acceptedAt)) throw new Error("PMS pricing command clock is invalid");
    const keyHash = sha256(command.idempotencyKey);
    const fingerprint = sha256(spec.serializeFingerprint(command));
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await lockPropertyPricingScope(client, command.propertyId);
      if (!(await lockAuthorizedScope(client, command, acceptedAt))) {
        await rollbackQuietly(client);
        return spec.scopeFailure();
      }

      const replay = await findReplay(client, command, spec, keyHash, fingerprint, acceptedAt);
      if (replay) {
        await rollbackQuietly(client);
        return replay;
      }
      const reservation = await reserveIdempotency(
        client,
        command,
        spec.operation,
        keyHash,
        fingerprint,
        acceptedAt,
      );
      if (!reservation) {
        const concurrentReplay = await findReplay(
          client,
          command,
          spec,
          keyHash,
          fingerprint,
          acceptedAt,
        );
        await rollbackQuietly(client);
        return concurrentReplay ?? spec.coordinationFailure("command_in_progress");
      }

      const worked = await work(client, acceptedAt);
      const result = spec.parseResult(worked.result);
      if (!result) throw new Error("PMS pricing command produced an invalid contract result");
      if (result.ok !== Boolean(worked.change)) {
        throw new Error("PMS pricing command change notification invariant failed");
      }

      const domainEventId = worked.change
        ? await enqueuePricingChange(
            client,
            command,
            spec.operation,
            reservation,
            keyHash,
            worked.change,
            acceptedAt,
          )
        : null;
      await recordAudit(
        client,
        command,
        spec.operation,
        reservation,
        keyHash,
        result,
        domainEventId,
        acceptedAt,
      );
      await completeIdempotency(client, reservation.id, spec.operation, result, acceptedAt);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async function prepareCurrencyCommand(
    command: UpsertPropertyPricingCurrencyCommand,
  ): Promise<
    | { kind: "result"; result: PropertyPricingCurrencyCommandResult }
    | { kind: "state"; currentCurrency: PmsPricingCurrency | null }
  > {
    const at = now();
    if (!validDate(at)) throw new Error("PMS pricing command clock is invalid");
    const keyHash = sha256(command.idempotencyKey);
    const fingerprint = sha256(CURRENCY_SPEC.serializeFingerprint(command));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockPropertyPricingScope(client, command.propertyId);
      if (!(await lockAuthorizedScope(client, command, at))) {
        await rollbackQuietly(client);
        return { kind: "result", result: CURRENCY_SPEC.scopeFailure() };
      }
      const replay = await findReplay(client, command, CURRENCY_SPEC, keyHash, fingerprint, at);
      if (replay) {
        await rollbackQuietly(client);
        return { kind: "result", result: replay };
      }
      const current = await lockPricingCurrency(client, command.propertyId);
      await client.query("ROLLBACK");
      return {
        kind: "state",
        currentCurrency: current ? pmsPricingCurrencySnapshotFromRow(current).currency : null,
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    async upsertPropertyPricingCurrency(command) {
      const prepared = await prepareCurrencyCommand(command);
      if (prepared.kind === "result") return prepared.result;

      const supported = await PMS_PRICING_CURRENCY_CAPABILITIES_PORT.isSupportedPricingCurrency(
        command.currency,
      );
      const execute = (
        guardHeld: boolean,
        guardBlockers: readonly PmsPricingCurrencyChangeBlocker[],
      ) =>
        runCommand(command, CURRENCY_SPEC, (client, acceptedAt) =>
          upsertCurrency(
            client,
            command,
            prepared.currentCurrency,
            supported,
            guardHeld,
            normalizeGuardBlockers(guardBlockers),
            acceptedAt,
          ),
        );

      if (supported && prepared.currentCurrency && prepared.currentCurrency !== command.currency) {
        let callbackStarted = false;
        try {
          return await config.currencyChangeGuard.runWithCurrencyChangeGuard(
            {
              propertyId: command.propertyId,
              currentCurrency: prepared.currentCurrency,
              requestedCurrency: command.currency,
            },
            (blockers) => {
              callbackStarted = true;
              return execute(true, blockers);
            },
          );
        } catch (error) {
          if (callbackStarted) throw error;
          return execute(false, [{ code: "dependency_check_unavailable" }]);
        }
      }
      return execute(false, []);
    },

    async upsertFlexibleRatePlan(command) {
      return runCommand(command, PLAN_SPEC, (client, acceptedAt) =>
        upsertPlan(client, command, makeId, acceptedAt),
      );
    },

    async close() {
      if (!ownsPool || closed) return;
      await pool.end();
      closed = true;
    },
  };
}

async function upsertCurrency(
  client: PmsPricingCommandClient,
  command: UpsertPropertyPricingCurrencyCommand,
  observedCurrency: PmsPricingCurrency | null,
  supported: boolean,
  guardHeld: boolean,
  guardBlockers: readonly PmsPricingCurrencyChangeBlocker[],
  at: Date,
): Promise<CommandWorkResult<PropertyPricingCurrencyCommandResult>> {
  if (!supported) return { result: currencyFailure({ code: "unsupported_pricing_currency" }) };
  const current = await lockPricingCurrency(client, command.propertyId);
  if (!current) {
    if (command.expectedPricingCurrencyRevision !== 0) {
      return {
        result: currencyFailure({
          code: "pricing_currency_revision_conflict",
          currentRevision: 0,
        }),
      };
    }
    const legacyCurrencies = await inspectLegacyCurrencies(client, command.propertyId);
    if (legacyCurrencies.some((currency) => currency !== command.currency)) {
      const blockers = await inspectLocalCurrencyBlockers(client, command.propertyId);
      return {
        result: currencyFailure({
          code: "pricing_currency_change_blocked",
          currentRevision: 0,
          blockers:
            blockers.length > 0
              ? blockers
              : Object.freeze([{ code: "other_pricing_configuration" }]),
        }),
      };
    }
    const inserted = await client.query<PmsPricingCurrencyRow>(
      `INSERT INTO pms.property_pricing_settings (
         property_id, currency, pricing_currency_revision, created_at, updated_at
       )
       VALUES ($1::uuid, $2, 1, $3::timestamptz, $3::timestamptz)
       RETURNING ${CURRENCY_RETURNING}`,
      [command.propertyId, command.currency, at.toISOString()],
    );
    const pricingCurrency = pmsPricingCurrencySnapshotFromRow(inserted.rows[0]!);
    const response = {
      contractVersion: PMS_PRICING_CONTRACT_VERSION,
      outcome: "created" as const,
      pricingCurrency,
      acceptedAt: at.toISOString(),
    };
    return {
      result: { ok: true, response },
      change: pricingChange(command.propertyId, pricingCurrency.pricingCurrencyRevision, null, {
        eventOutcome: "currency_created",
        resourceType: "property_pricing",
        resourceId: command.propertyId,
      }),
    };
  }

  const snapshot = pmsPricingCurrencySnapshotFromRow(current);
  if (snapshot.pricingCurrencyRevision !== command.expectedPricingCurrencyRevision) {
    return {
      result: currencyFailure({
        code: "pricing_currency_revision_conflict",
        currentRevision: snapshot.pricingCurrencyRevision,
      }),
    };
  }
  if (snapshot.currency === command.currency) {
    return { result: currencyFailure({ code: "pricing_currency_unchanged" }) };
  }

  const localBlockers = await inspectLocalCurrencyBlockers(client, command.propertyId);
  const safetyBlockers = [
    ...guardBlockers,
    ...(!guardHeld || observedCurrency !== snapshot.currency
      ? ([{ code: "dependency_check_unavailable" }] as const)
      : []),
  ];
  const blockers = mergeBlockers([...localBlockers, ...safetyBlockers]);
  if (blockers.length > 0) {
    return {
      result: currencyFailure({
        code: "pricing_currency_change_blocked",
        currentRevision: snapshot.pricingCurrencyRevision,
        blockers,
      }),
    };
  }

  const updated = await client.query<PmsPricingCurrencyRow>(
    `UPDATE pms.property_pricing_settings
     SET currency = $3,
         pricing_currency_revision = pricing_currency_revision + 1,
         updated_at = $4::timestamptz
     WHERE property_id = $1::uuid
       AND pricing_currency_revision = $2
     RETURNING ${CURRENCY_RETURNING}`,
    [
      command.propertyId,
      command.expectedPricingCurrencyRevision,
      command.currency,
      at.toISOString(),
    ],
  );
  if (!updated.rows[0]) throw new Error("PMS pricing currency compare-and-set failed");
  const pricingCurrency = pmsPricingCurrencySnapshotFromRow(updated.rows[0]);
  const response = {
    contractVersion: PMS_PRICING_CONTRACT_VERSION,
    outcome: "updated" as const,
    pricingCurrency,
    acceptedAt: at.toISOString(),
  };
  return {
    result: { ok: true, response },
    change: pricingChange(command.propertyId, pricingCurrency.pricingCurrencyRevision, null, {
      eventOutcome: "currency_updated",
      resourceType: "property_pricing",
      resourceId: command.propertyId,
    }),
  };
}

async function upsertPlan(
  client: PmsPricingCommandClient,
  command: UpsertFlexibleRatePlanCommand,
  makeId: () => string,
  at: Date,
): Promise<CommandWorkResult<FlexibleRatePlanCommandResult>> {
  const currencyRow = await lockPricingCurrency(client, command.propertyId);
  if (!currencyRow) return { result: planFailure({ code: "pricing_currency_not_configured" }) };
  const pricingCurrency = pmsPricingCurrencySnapshotFromRow(currencyRow);
  if (pricingCurrency.pricingCurrencyRevision !== command.expectedPricingCurrencyRevision) {
    return {
      result: planFailure({
        code: "pricing_currency_revision_conflict",
        currentRevision: pricingCurrency.pricingCurrencyRevision,
      }),
    };
  }

  const room = await client.query<LockedRoomTypeRow>(
    `SELECT room_facts_revision AS "roomFactsRevision"
     FROM pms.room_types
     WHERE property_id = $1::uuid AND id = $2::uuid AND active
     FOR UPDATE`,
    [command.propertyId, command.roomTypeId],
  );
  if (!room.rows[0]) return { result: planFailure({ code: "room_type_not_found" }) };
  const roomFactsRevision = positiveDatabaseInteger(room.rows[0].roomFactsRevision);
  if (roomFactsRevision !== command.expectedRoomFactsRevision) {
    return {
      result: planFailure({
        code: "room_facts_revision_conflict",
        currentRevision: roomFactsRevision,
      }),
    };
  }

  const canonical = await lockCanonicalPlan(client, command.propertyId, command.roomTypeId);
  let outcome: "created" | "updated";
  let planRow: PmsFlexibleRatePlanRow;
  if (canonical) {
    const currentRevision = positiveDatabaseInteger(canonical.flexibleRatePlanRevision);
    if (currentRevision !== command.expectedFlexibleRatePlanRevision) {
      return {
        result: planFailure({
          code: "flexible_rate_plan_revision_conflict",
          currentRevision,
        }),
      };
    }
    const updated = await client.query<PmsFlexibleRatePlanRow>(
      `UPDATE pms.rate_plans
       SET rate_type = 'flexible',
           meal_plan = NULL,
           payment_policy = '{}'::jsonb,
           deposit_policy = '{}'::jsonb,
           cancellation_policy_snapshot = $4::jsonb,
           base_rate_amount = $5::numeric(15, 2),
           currency = $6,
           active = TRUE,
           flexible_rate_plan_revision = flexible_rate_plan_revision + 1,
           source_room_facts_revision = $7,
           source_pricing_currency_revision = $8,
           updated_at = $9::timestamptz
       WHERE property_id = $1::uuid
         AND room_type_id = $2::uuid
         AND id = $3::uuid
         AND pricing_contract_version = '${PMS_PRICING_CONTRACT_VERSION}'
         AND flexible_rate_plan_revision = $10
       RETURNING ${PLAN_RETURNING}`,
      [
        command.propertyId,
        command.roomTypeId,
        canonical.flexibleRatePlanId,
        JSON.stringify(canonicalCancellationTerms(command.cancellationTerms)),
        command.baseAmountDecimal,
        pricingCurrency.currency,
        roomFactsRevision,
        pricingCurrency.pricingCurrencyRevision,
        at.toISOString(),
        command.expectedFlexibleRatePlanRevision,
      ],
    );
    if (!updated.rows[0]) throw new Error("PMS flexible pricing plan compare-and-set failed");
    planRow = updated.rows[0];
    outcome = "updated";
  } else {
    if (command.expectedFlexibleRatePlanRevision !== 0) {
      return {
        result: planFailure({
          code: "flexible_rate_plan_revision_conflict",
          currentRevision: 0,
        }),
      };
    }
    const planId = makeId().toLowerCase();
    if (!UUID_PATTERN.test(planId)) {
      throw new Error("PMS pricing command ID generator returned an invalid UUID");
    }
    const inserted = await client.query<PmsFlexibleRatePlanRow>(
      `INSERT INTO pms.rate_plans (
         id, property_id, room_type_id, code, name, rate_type, meal_plan,
         payment_policy, deposit_policy, cancellation_policy_snapshot,
         base_rate_amount, currency, active, pricing_contract_version,
         flexible_rate_plan_revision, source_room_facts_revision,
         source_pricing_currency_revision, created_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, 'Flexible', 'flexible', NULL,
         '{}'::jsonb, '{}'::jsonb, $5::jsonb, $6::numeric(15, 2), $7, TRUE,
         '${PMS_PRICING_CONTRACT_VERSION}', 1, $8, $9,
         $10::timestamptz, $10::timestamptz
       )
       RETURNING ${PLAN_RETURNING}`,
      [
        planId,
        command.propertyId,
        command.roomTypeId,
        `ONB15-FLEX-${planId}`,
        JSON.stringify(canonicalCancellationTerms(command.cancellationTerms)),
        command.baseAmountDecimal,
        pricingCurrency.currency,
        roomFactsRevision,
        pricingCurrency.pricingCurrencyRevision,
        at.toISOString(),
      ],
    );
    if (!inserted.rows[0]) throw new Error("PMS flexible pricing plan insert failed");
    planRow = inserted.rows[0];
    outcome = "created";
  }

  await persistFlexibleCancellationExtension(client, command, planRow.flexibleRatePlanId, at);
  const flexibleRatePlan = pmsFlexibleRatePlanSnapshotFromRow({
    ...planRow,
    cancellationTerms: command.cancellationTerms,
  });
  const response = {
    contractVersion: PMS_PRICING_CONTRACT_VERSION,
    outcome,
    flexibleRatePlan,
    acceptedAt: at.toISOString(),
  };
  return {
    result: { ok: true, response },
    change: pricingChange(
      command.propertyId,
      pricingCurrency.pricingCurrencyRevision,
      {
        id: flexibleRatePlan.flexibleRatePlanId,
        revision: flexibleRatePlan.flexibleRatePlanRevision,
      },
      {
        eventOutcome: outcome === "created" ? "flexible_plan_created" : "flexible_plan_updated",
        resourceType: "flexible_rate_plan",
        resourceId: flexibleRatePlan.flexibleRatePlanId,
      },
    ),
  };
}

function canonicalCancellationTerms(terms: FlexibleCancellationTerms) {
  return {
    type: terms.type,
    freeCancellationDeadlineDays: terms.freeCancellationDeadlineDays,
    afterDeadlinePenalty: terms.afterDeadlinePenalty,
    noShowPenalty: terms.noShowPenalty,
  };
}

async function persistFlexibleCancellationExtension(
  client: PmsPricingCommandClient,
  command: UpsertFlexibleRatePlanCommand,
  flexibleRatePlanId: string,
  at: Date,
): Promise<void> {
  const hasExtension = Object.keys(command.cancellationTerms).some(
    (key) =>
      !["type", "freeCancellationDeadlineDays", "afterDeadlinePenalty", "noShowPenalty"].includes(
        key,
      ),
  );
  if (!hasExtension) {
    await client.query(
      `DELETE FROM pms.flexible_rate_plan_cancellation_extensions
       WHERE property_id = $1::uuid
         AND room_type_id = $2::uuid
         AND flexible_rate_plan_id = $3::uuid`,
      [command.propertyId, command.roomTypeId, flexibleRatePlanId],
    );
    return;
  }
  await client.query(
    `INSERT INTO pms.flexible_rate_plan_cancellation_extensions (
       flexible_rate_plan_id, property_id, room_type_id, cancellation_terms,
       created_at, updated_at
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5::timestamptz, $5::timestamptz)
     ON CONFLICT (flexible_rate_plan_id) DO UPDATE SET
       cancellation_terms = EXCLUDED.cancellation_terms,
       updated_at = EXCLUDED.updated_at
     WHERE pms.flexible_rate_plan_cancellation_extensions.property_id = EXCLUDED.property_id
       AND pms.flexible_rate_plan_cancellation_extensions.room_type_id = EXCLUDED.room_type_id`,
    [
      flexibleRatePlanId,
      command.propertyId,
      command.roomTypeId,
      JSON.stringify(command.cancellationTerms),
      at.toISOString(),
    ],
  );
}

function pricingChange(
  propertyId: string,
  pricingCurrencyRevision: number,
  plan: { id: string; revision: number } | null,
  input: {
    eventOutcome: PmsPricingSourceChangedEvent["outcome"];
    resourceType: AcceptedChange["resourceType"];
    resourceId: string;
  },
): AcceptedChange {
  return {
    event: {
      contractVersion: PMS_PRICING_CONTRACT_VERSION,
      eventType: "pms.pricing_source.changed",
      propertyId,
      pricingCurrencyRevision,
      flexibleRatePlanId: plan?.id ?? null,
      flexibleRatePlanRevision: plan?.revision ?? null,
      outcome: input.eventOutcome,
    },
    resourceType: input.resourceType,
    resourceId: input.resourceId,
  };
}

async function lockAuthorizedScope(
  client: PmsPricingCommandClient,
  command: AnyCommand,
  at: Date,
): Promise<boolean> {
  if (command.audit.actor.kind !== "user") return false;
  const scope = await client.query(
    `SELECT property.id
     FROM hotel_catalog.properties property
     JOIN identity.organizations organization
       ON organization.id = $1::uuid
      AND organization.kind = 'hotel_group'
      AND organization.status = 'active'
     JOIN identity.organization_resource_links resource
       ON resource.organization_id = organization.id
      AND resource.product = 'pms'
      AND resource.resource_type = 'pms_property'
      AND resource.resource_id = property.id::text
      AND resource.relationship IN ('owner', 'operator')
      AND resource.status = 'active'
     JOIN identity.users actor
       ON actor.id = $3::uuid AND actor.status = 'active'
     JOIN identity.organization_memberships membership
       ON membership.organization_id = organization.id
      AND membership.user_id = actor.id
      AND membership.status = 'active'
     JOIN identity.role_permission_grants permission_grant
       ON permission_grant.organization_kind = 'hotel_group'
      AND permission_grant.role_key = membership.role_key
      AND permission_grant.permission_key = $4
     WHERE property.id = $2::uuid
     FOR SHARE OF property, organization, resource, actor, membership
     FOR KEY SHARE OF permission_grant`,
    [command.organizationId, command.propertyId, command.audit.actor.userId, MANAGE_PERMISSION],
  );
  if ((scope.rowCount ?? 0) < 1) return false;

  const entitlements = await client.query<{
    status: string;
    startsAt: Date | string | null;
    expiresAt: Date | string | null;
  }>(
    `SELECT status, starts_at AS "startsAt", expires_at AS "expiresAt"
     FROM identity.product_entitlements
     WHERE organization_id = $1::uuid
       AND product = 'pms'
       AND entitlement_key = 'property-management'
       AND (
         resource_product IS NULL
         OR (resource_product = 'pms' AND resource_type = 'pms_property'
             AND resource_id = $2::uuid::text)
       )
     FOR SHARE`,
    [command.organizationId, command.propertyId],
  );
  const applicable = entitlements.rows.filter(
    (row) =>
      (!row.startsAt || new Date(row.startsAt) <= at) &&
      (!row.expiresAt || new Date(row.expiresAt) > at),
  );
  return (
    !applicable.some(({ status }) => status === "suspended") &&
    applicable.some(({ status }) => status === "active")
  );
}

async function lockPropertyPricingScope(
  client: PmsPricingCommandClient,
  propertyId: string,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended(concat('pms-pricing-currency:', $1::uuid::text), 0)
     )`,
    [propertyId],
  );
}

async function lockPricingCurrency(
  client: PmsPricingCommandClient,
  propertyId: string,
): Promise<LockedCurrencyRow | null> {
  const result = await client.query<LockedCurrencyRow>(
    `SELECT ${CURRENCY_RETURNING}
     FROM pms.property_pricing_settings
     WHERE property_id = $1::uuid
     FOR UPDATE`,
    [propertyId],
  );
  if (result.rows.length > 1) throw new Error("PMS property pricing currency is not unique");
  return result.rows[0] ?? null;
}

async function lockCanonicalPlan(
  client: PmsPricingCommandClient,
  propertyId: string,
  roomTypeId: string,
): Promise<PmsFlexibleRatePlanRow | null> {
  const result = await client.query<PmsFlexibleRatePlanRow>(
    `SELECT ${PLAN_RETURNING}
     FROM pms.rate_plans
     WHERE property_id = $1::uuid
       AND room_type_id = $2::uuid
       AND pricing_contract_version = '${PMS_PRICING_CONTRACT_VERSION}'
     FOR UPDATE`,
    [propertyId, roomTypeId],
  );
  if (result.rows.length > 1) throw new Error("PMS canonical flexible pricing plan is not unique");
  return result.rows[0] ?? null;
}

async function inspectLegacyCurrencies(
  client: PmsPricingCommandClient,
  propertyId: string,
): Promise<readonly string[]> {
  const result = await client.query<LegacyCurrencyRow>(
    `SELECT currency::text AS currency
     FROM (
       SELECT currency FROM pms.room_types
       WHERE property_id = $1::uuid AND currency IS NOT NULL
       UNION
       SELECT currency FROM pms.rate_plans WHERE property_id = $1::uuid
     ) legacy_currency
     ORDER BY currency`,
    [propertyId],
  );
  return Object.freeze(result.rows.map(({ currency }) => currency));
}

async function inspectLocalCurrencyBlockers(
  client: PmsPricingCommandClient,
  propertyId: string,
): Promise<readonly PmsPricingCurrencyChangeBlocker[]> {
  const result = await client.query<LocalBlockerCountsRow>(
    `SELECT
       (SELECT count(*) FROM pms.rate_plans
        WHERE property_id = $1::uuid
          AND pricing_contract_version = '${PMS_PRICING_CONTRACT_VERSION}')::bigint
         AS "flexibleRatePlanCount",
       (SELECT count(*) FROM pms.room_types
        WHERE property_id = $1::uuid
          AND (base_rate_amount IS NOT NULL OR currency IS NOT NULL))::bigint
         AS "legacyRoomTypePriceCount",
       (SELECT count(*) FROM pms.rate_plans
        WHERE property_id = $1::uuid AND pricing_contract_version IS NULL)::bigint
         AS "legacyRatePlanCount",
       ((SELECT count(*) FROM pms.rate_rules
         WHERE property_id = $1::uuid)
        +
        (SELECT count(*) FROM pms.recurring_pricing_sources
         WHERE property_id = $1::uuid))::bigint AS "rateRuleCount"`,
    [propertyId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("PMS pricing dependency scan returned no row");
  const values = [
    ["flexible_rate_plan", row.flexibleRatePlanCount],
    ["legacy_room_type_price", row.legacyRoomTypePriceCount],
    ["legacy_rate_plan", row.legacyRatePlanCount],
    ["rate_rule", row.rateRuleCount],
  ] as const;
  return Object.freeze(
    values.flatMap(([code, rawCount]) => {
      const affectedCount = nonNegativeDatabaseInteger(rawCount);
      return affectedCount > 0 ? [{ code, affectedCount } as const] : [];
    }),
  );
}

function normalizeGuardBlockers(
  blockers: readonly PmsPricingCurrencyChangeBlocker[],
): readonly PmsPricingCurrencyChangeBlocker[] {
  if (!Array.isArray(blockers)) return [{ code: "dependency_check_unavailable" }];
  const parsed: PmsPricingCurrencyChangeBlocker[] = [];
  for (const blocker of blockers) {
    if (
      !isRecord(blocker) ||
      typeof blocker["code"] !== "string" ||
      !PMS_PRICING_CURRENCY_CHANGE_BLOCKER_CODES.includes(
        blocker["code"] as PmsPricingCurrencyChangeBlocker["code"],
      ) ||
      (blocker["affectedCount"] !== undefined && !isPositiveInteger(blocker["affectedCount"]))
    ) {
      return [{ code: "dependency_check_unavailable" }];
    }
    parsed.push({
      code: blocker["code"] as PmsPricingCurrencyChangeBlocker["code"],
      ...(blocker["affectedCount"] === undefined
        ? {}
        : { affectedCount: blocker["affectedCount"] as number }),
    });
  }
  return mergeBlockers(parsed);
}

function mergeBlockers(
  blockers: readonly PmsPricingCurrencyChangeBlocker[],
): readonly PmsPricingCurrencyChangeBlocker[] {
  const counts = new Map<PmsPricingCurrencyChangeBlocker["code"], number | null>();
  for (const blocker of blockers) {
    const previous = counts.get(blocker.code);
    if (blocker.affectedCount === undefined) {
      if (previous === undefined) counts.set(blocker.code, null);
    } else {
      counts.set(blocker.code, Math.min(2_147_483_647, (previous ?? 0) + blocker.affectedCount));
    }
  }
  return Object.freeze(
    PMS_PRICING_CURRENCY_CHANGE_BLOCKER_CODES.flatMap((code) => {
      const count = counts.get(code);
      if (count === undefined) return [];
      return [count === null ? { code } : { code, affectedCount: count }];
    }),
  );
}

async function findReplay<C extends AnyCommand, R extends AnyResult>(
  client: PmsPricingCommandClient,
  command: C,
  spec: CommandSpec<C, R>,
  keyHash: string,
  fingerprint: string,
  at: Date,
): Promise<R | null> {
  const result = await client.query<IdempotencyRow>(
    `SELECT id::text AS id, status,
            request_fingerprint_hash AS "requestFingerprintHash",
            response_status_code AS "responseStatusCode",
            response_body_hash AS "responseBodyHash",
            idempotency_metadata AS "idempotencyMetadata",
            expires_at AS "expiresAt"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'pms' AND operation = $1 AND key_hash = $2
       AND tenant_scope = 'property' AND organization_id IS NULL
       AND property_id = $3::uuid
     FOR UPDATE`,
    [spec.operation, keyHash, command.propertyId],
  );
  const existing = result.rows[0];
  if (!existing || new Date(existing.expiresAt) <= at) return null;
  if (existing.requestFingerprintHash !== fingerprint) {
    return spec.coordinationFailure("idempotency_key_conflict");
  }
  if (existing.status !== "completed") return spec.coordinationFailure("command_in_progress");
  const stored = isRecord(existing.idempotencyMetadata)
    ? existing.idempotencyMetadata["result"]
    : undefined;
  const parsed = spec.parseResult(stored);
  if (
    !parsed ||
    existing.responseStatusCode !== idempotencyResponseStatus(spec.operation, parsed) ||
    existing.responseBodyHash !== sha256(stableJson(idempotencyResponseBody(parsed)))
  ) {
    return spec.coordinationFailure("idempotency_key_conflict");
  }
  return parsed;
}

async function reserveIdempotency(
  client: PmsPricingCommandClient,
  command: AnyCommand,
  operation: string,
  keyHash: string,
  fingerprint: string,
  at: Date,
): Promise<IdempotencyReservation | null> {
  const result = await client.query<IdempotencyReservation>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope, operation, key_hash, request_fingerprint_hash, status,
       tenant_scope, organization_id, property_id, correlation_id,
       first_seen_at, last_seen_at, expires_at, idempotency_metadata
     ) VALUES (
       'pms', $1, $2, $3, 'in_progress', 'property', NULL, $4::uuid, $5,
       $6::timestamptz, $6::timestamptz, $6::timestamptz + interval '24 hours',
       jsonb_build_object('attempt', 1)
     )
     ON CONFLICT (operation_scope, operation, key_hash, scope_key)
     DO UPDATE SET
       request_fingerprint_hash = EXCLUDED.request_fingerprint_hash,
       status = 'in_progress', response_status_code = NULL, response_body_hash = NULL,
       response_resource_product = NULL, response_resource_type = NULL,
       response_resource_id = NULL, correlation_id = EXCLUDED.correlation_id,
       first_seen_at = EXCLUDED.first_seen_at, last_seen_at = EXCLUDED.last_seen_at,
       completed_at = NULL, expires_at = EXCLUDED.expires_at,
       idempotency_metadata = jsonb_build_object(
         'attempt', COALESCE((idempotency_keys.idempotency_metadata ->> 'attempt')::integer, 1) + 1
       )
     WHERE idempotency_keys.expires_at <= EXCLUDED.first_seen_at
     RETURNING id::text AS id,
       (idempotency_metadata ->> 'attempt')::integer AS attempt`,
    [
      operation,
      keyHash,
      fingerprint,
      command.propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      at.toISOString(),
    ],
  );
  return result.rows[0] ?? null;
}

async function completeIdempotency(
  client: PmsPricingCommandClient,
  id: string,
  operation: string,
  result: AnyResult,
  at: Date,
): Promise<void> {
  const completed = await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed', response_status_code = $2, response_body_hash = $3,
         completed_at = $4::timestamptz, last_seen_at = $4::timestamptz,
         idempotency_metadata = idempotency_metadata || jsonb_build_object('result', $5::jsonb)
     WHERE id = $1::uuid AND status = 'in_progress'`,
    [
      id,
      idempotencyResponseStatus(operation, result),
      sha256(stableJson(idempotencyResponseBody(result))),
      at.toISOString(),
      JSON.stringify(result),
    ],
  );
  if (completed.rowCount !== 1) throw new Error("PMS pricing idempotency completion failed");
}

async function enqueuePricingChange(
  client: PmsPricingCommandClient,
  command: AnyCommand,
  operation: string,
  reservation: IdempotencyReservation,
  keyHash: string,
  change: AcceptedChange,
  at: Date,
): Promise<string> {
  if (command.audit.actor.kind !== "user") throw new Error("PMS pricing event requires user actor");
  const eventKey = `pms.pricing_source.changed.property.${command.propertyId}.operation.${operation}.key.${keyHash}.attempt.${reservation.attempt}.v1`;
  const event = await client.query<{ eventId: string }>(
    `WITH inserted AS (
       INSERT INTO platform.domain_events (
         source_system, event_key, event_type, event_version, occurred_at,
         tenant_scope, organization_id, property_id, resource_product,
         resource_type, resource_id, actor_type, actor_user_id, correlation_id,
         causation_id, idempotency_key_hash, payload, event_metadata, privacy_scope
       ) VALUES (
         'pms', $1, 'pms.pricing_source.changed', 1, $2::timestamptz,
         'property', NULL, $3::uuid, 'pms', $4, $5, 'user', $6::uuid, $7,
         $8, $9, $10::jsonb, $11::jsonb, 'confidential'
       )
       ON CONFLICT (source_system, event_key) DO NOTHING
       RETURNING id::text AS "eventId"
     )
     SELECT "eventId" FROM inserted
     UNION ALL
     SELECT id::text AS "eventId" FROM platform.domain_events
     WHERE source_system = 'pms' AND event_key = $1
     LIMIT 1`,
    [
      eventKey,
      at.toISOString(),
      command.propertyId,
      change.resourceType,
      change.resourceId,
      command.audit.actor.userId,
      command.audit.correlationId ?? command.audit.requestId,
      command.audit.requestId,
      keyHash,
      JSON.stringify(change.event),
      JSON.stringify({ contractVersion: PMS_PRICING_CONTRACT_VERSION, sourceReadRequired: true }),
    ],
  );
  const eventId = event.rows[0]?.eventId;
  if (!eventId) throw new Error("PMS pricing domain event insert failed");

  for (const destination of ["booking.pricing-source", "finance.pricing-source"] as const) {
    await client.query(
      `INSERT INTO platform.outbox_events (
         domain_event_id, outbox_key, destination, event_type, tenant_scope,
         organization_id, property_id, resource_product, resource_type,
         resource_id, correlation_id, idempotency_key_hash, payload, outbox_metadata
       ) VALUES (
         $1::uuid, $2, $3, 'pms.pricing_source.changed', 'property', NULL,
         $4::uuid, 'pms', $5, $6, $7, $8, $9::jsonb, $10::jsonb
       )
       ON CONFLICT (destination, outbox_key) DO NOTHING`,
      [
        eventId,
        `${destination}.pricing_source.property.${command.propertyId}.key.${keyHash}.attempt.${reservation.attempt}.v1`,
        destination,
        command.propertyId,
        change.resourceType,
        change.resourceId,
        command.audit.correlationId ?? command.audit.requestId,
        keyHash,
        JSON.stringify(change.event),
        JSON.stringify({ contractVersion: PMS_PRICING_CONTRACT_VERSION, sourceReadRequired: true }),
      ],
    );
  }
  if (change.resourceType === "flexible_rate_plan" && "roomTypeId" in command) {
    await client.query(
      `INSERT INTO platform.outbox_events (
         domain_event_id, outbox_key, destination, event_type, tenant_scope,
         organization_id, property_id, resource_product, resource_type,
         resource_id, correlation_id, idempotency_key_hash, payload, outbox_metadata
       ) VALUES (
         $1::uuid, $2, 'distribution.public-bookability', 'pms.inventory.changed',
         'property', NULL, $3::uuid, 'pms', $4, $5, $6, $7, $8::jsonb, $9::jsonb
       )
       ON CONFLICT (destination, outbox_key) DO NOTHING`,
      [
        eventId,
        `distribution.pricing_source.property.${command.propertyId}.key.${keyHash}.attempt.${reservation.attempt}.v1`,
        command.propertyId,
        change.resourceType,
        change.resourceId,
        command.audit.correlationId ?? command.audit.requestId,
        keyHash,
        JSON.stringify({ propertyId: command.propertyId, roomTypeId: command.roomTypeId }),
        JSON.stringify({ contractVersion: PMS_PRICING_CONTRACT_VERSION, sourceReadRequired: true }),
      ],
    );
  }
  return eventId;
}

async function recordAudit(
  client: PmsPricingCommandClient,
  command: AnyCommand,
  operation: string,
  reservation: IdempotencyReservation,
  keyHash: string,
  result: AnyResult,
  domainEventId: string | null,
  at: Date,
): Promise<void> {
  if (command.audit.actor.kind !== "user") throw new Error("PMS pricing audit requires user actor");
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at, tenant_scope, organization_id,
       property_id, actor_type, actor_user_id, target_resource_product,
       target_resource_type, target_resource_id, domain_event_id,
       idempotency_key_id, correlation_id, causation_id, redacted_payload,
       private_payload, audit_metadata, privacy_scope
     ) VALUES (
       $1, 'pms', $2, $3::timestamptz, 'property', NULL, $4::uuid,
       'user', $5::uuid, 'pms', $6, $7, $8::uuid, $9::uuid, $10, $11,
       $12::jsonb, '{}'::jsonb, $13::jsonb, 'confidential'
     )`,
    [
      `pms.pricing.property.${command.propertyId}.operation.${operation}.key.${keyHash}.attempt.${reservation.attempt}.v1`,
      operation,
      at.toISOString(),
      command.propertyId,
      command.audit.actor.userId,
      "roomTypeId" in command ? "flexible_rate_plan" : "property_pricing",
      resultTargetId(command, result),
      domainEventId,
      reservation.id,
      command.audit.correlationId ?? command.audit.requestId,
      command.audit.requestId,
      JSON.stringify(redactedAuditPayload(command, result)),
      JSON.stringify({
        requestId: command.audit.requestId,
        requestedAt: command.audit.requestedAt,
        actorOrganizationId: command.organizationId,
        contractVersion: PMS_PRICING_CONTRACT_VERSION,
      }),
    ],
  );
}

function redactedAuditPayload(command: AnyCommand, result: AnyResult): Record<string, unknown> {
  const base: Record<string, unknown> = {
    propertyId: command.propertyId,
    ...(command.expectedPricingCurrencyRevision === undefined
      ? {}
      : { expectedPricingCurrencyRevision: command.expectedPricingCurrencyRevision }),
    ...(command && "roomTypeId" in command
      ? {
          roomTypeId: command.roomTypeId,
          expectedRoomFactsRevision: command.expectedRoomFactsRevision,
          expectedFlexibleRatePlanRevision: command.expectedFlexibleRatePlanRevision,
        }
      : {}),
  };
  if (result.ok) {
    return "pricingCurrency" in result.response
      ? {
          ...base,
          outcome: result.response.outcome,
          resultingPricingCurrencyRevision: result.response.pricingCurrency.pricingCurrencyRevision,
        }
      : {
          ...base,
          outcome: result.response.outcome,
          flexibleRatePlanId: result.response.flexibleRatePlan.flexibleRatePlanId,
          resultingFlexibleRatePlanRevision:
            result.response.flexibleRatePlan.flexibleRatePlanRevision,
          sourceRoomFactsRevision: result.response.flexibleRatePlan.sourceRoomFactsRevision,
        };
  }
  const payload = { ...base, outcome: result.error.code } as Record<string, unknown>;
  if ("currentRevision" in result.error) payload["currentRevision"] = result.error.currentRevision;
  if ("blockers" in result.error) payload["blockers"] = result.error.blockers;
  return payload;
}

function resultTargetId(command: AnyCommand, result: AnyResult): string {
  if (result.ok && "flexibleRatePlan" in result.response) {
    return result.response.flexibleRatePlan.flexibleRatePlanId;
  }
  return "roomTypeId" in command ? command.roomTypeId : command.propertyId;
}

function idempotencyResponseBody(result: AnyResult): unknown {
  return result.ok ? result.response : result.error;
}

function idempotencyResponseStatus(operation: string, result: AnyResult): number {
  if (result.ok) return result.response.outcome === "created" ? 201 : 200;
  if (
    result.error.code === "setup_scope_unavailable" ||
    result.error.code === "room_type_not_found"
  ) {
    return 404;
  }
  if (result.error.code === "unsupported_pricing_currency") return 422;
  return 409;
}

function currencyFailure(
  error: PropertyPricingCurrencyCommandError,
): PropertyPricingCurrencyCommandResult {
  return { ok: false, error };
}

function planFailure(error: FlexibleRatePlanCommandError): FlexibleRatePlanCommandResult {
  return { ok: false, error };
}

function positiveDatabaseInteger(value: number | string): number {
  const parsed = databaseInteger(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("PMS pricing database revision is invalid");
  }
  return parsed;
}

function nonNegativeDatabaseInteger(value: number | string): number {
  const parsed = databaseInteger(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("PMS pricing database blocker count is invalid");
  }
  return parsed;
}

function databaseInteger(value: number | string): number {
  if (typeof value === "number") return value;
  return /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : Number.NaN;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, sortJsonValue(entry)]),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function rollbackQuietly(client: PmsPricingCommandClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original command error.
  }
}
