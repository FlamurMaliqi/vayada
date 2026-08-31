import { createHash } from "node:crypto";

import {
  parseFinanceFolioWrite,
  type FinanceCommandAudit,
  type FinanceFolioLineWrite,
  type FinanceFolioPaymentReference,
  type FinanceFolioRevisionCommand,
  type FinanceFolioStoredState,
  type FinanceFolioWrite,
} from "@vayada/domain-finance";
import pg from "pg";

import type {
  FinanceFolioRecipientDecoder,
  FinanceFolioRecipientEncoder,
  FinanceFolioRecipientEvidence,
} from "./financeFolioRecipientCodec.js";

type Base = { propertyId: string; audit: FinanceCommandAudit };
export type CreateFinanceFolioCommand = Base & FinanceFolioWrite;
export type CorrectFinanceFolioCommand = Base & FinanceFolioWrite & { folioId: string };
export type TransitionFinanceFolioCommand = Base &
  FinanceFolioRevisionCommand & { folioId: string };
export type FinanceFolioCommandResult =
  | { status: "created" | "updated" | "replayed"; folioId: string; revision: number }
  | { status: "not_found" | "invalid_evidence" }
  | {
      status: "conflict";
      reason:
        | "revision_conflict"
        | "revision_exhausted"
        | "invalid_state"
        | "idempotency_key_reused"
        | "command_in_progress";
    };

type IdempotencyRow = {
  status: string;
  fingerprint: string;
  responseHash: string | null;
  metadata: unknown;
};
type Scope = { currency: string };
type Latest = {
  revisionId: string;
  revision: number;
  state: FinanceFolioStoredState;
  recipientCiphertext: Buffer;
  recipientScheme: "envelope_aead_v1";
  recipientKeyVersion: string;
  recipientFingerprint: string;
  recipientFingerprintKeyVersion: string;
  sourceDigest: string;
  lineCount: number;
};
type Receipt = {
  folioId: string;
  revisionId: string;
  revision: number;
  state: FinanceFolioStoredState;
};
type Resolved = { currency: string; sourceFreshness: Record<string, string> };
type Mutation =
  | {
      action: "create" | "correct";
      command: CreateFinanceFolioCommand | CorrectFinanceFolioCommand;
    }
  | {
      action: "ready" | "archive";
      command: TransitionFinanceFolioCommand;
      state: "ready" | "archived";
    };

const MAX_REVISION = 2_147_483_647;
const OPERATION = "finance.folio";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function createPgFinanceFolioCommandRepository(config: {
  connectionString: string;
  recipientEncoder: FinanceFolioRecipientEncoder;
  recipientDecoder: FinanceFolioRecipientDecoder;
}) {
  const pool = new pg.Pool({ connectionString: config.connectionString });
  return {
    create: (command: CreateFinanceFolioCommand) =>
      mutate(pool, config, { action: "create", command }),
    correct: (command: CorrectFinanceFolioCommand) =>
      mutate(pool, config, { action: "correct", command }),
    ready: (command: TransitionFinanceFolioCommand) =>
      mutate(pool, config, { action: "ready", command, state: "ready" }),
    archive: (command: TransitionFinanceFolioCommand) =>
      mutate(pool, config, { action: "archive", command, state: "archived" }),
    close: () => pool.end(),
  };
}

async function mutate(
  pool: pg.Pool,
  codecs: {
    recipientEncoder: FinanceFolioRecipientEncoder;
    recipientDecoder: FinanceFolioRecipientDecoder;
  },
  mutation: Mutation,
): Promise<FinanceFolioCommandResult> {
  const { command, action } = mutation;
  validate(command, action);
  const folioId =
    action === "create" ? command.commandId : "folioId" in command ? command.folioId : "";
  const operation = `${OPERATION}.${action}`;
  const acceptedAt = new Date().toISOString();
  const keyHash = hash(command.idempotencyKey);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='15s'");
    const scope = await propertyScope(client, command.propertyId);
    if (!scope) return stop(client, { status: "not_found" });
    const aggregate =
      action === "create" ? null : await scopedFolio(client, command.propertyId, folioId);
    if (action !== "create" && !aggregate) return stop(client, { status: "not_found" });

    let resolved: Resolved | null = null;
    let encoded: FinanceFolioRecipientEvidence | null = null;
    let prior: Latest | null = null;
    if (action === "create" || action === "correct") {
      const scoped = await resolveEvidence(client, command, scope, acceptedAt, true);
      if (!scoped) return stop(client, { status: "invalid_evidence" });
    }
    const existing = await idempotency(client, operation, keyHash, command.propertyId);
    if (existing)
      return stop(
        client,
        await replay(client, codecs.recipientDecoder, existing, mutation, folioId),
      );

    if (action === "create" || action === "correct") {
      if (action === "correct" && (command.bookingId ?? null) !== aggregate!.bookingId)
        return stop(client, { status: "invalid_evidence" });
      const revision = action === "create" ? 1 : command.expectedRevision! + 1;
      encoded = await codecs.recipientEncoder.encode({
        propertyId: command.propertyId,
        folioId,
        revision,
        recipient: command.recipient,
      });
      resolved = await resolveEvidence(client, command, scope, acceptedAt, false);
      if (!resolved) return stop(client, { status: "invalid_evidence" });
    } else {
      prior = await exactRevision(client, command.propertyId, folioId, command.expectedRevision!);
      if (!prior) return stop(client, { status: "conflict", reason: "revision_conflict" });
      if (prior.revision === MAX_REVISION)
        return stop(client, { status: "conflict", reason: "revision_exhausted" });
      if (prior.state === "archived" || (action === "ready" && prior.state !== "draft"))
        return stop(client, { status: "conflict", reason: "invalid_state" });
      if (action === "ready" && prior.lineCount === 0)
        return stop(client, { status: "invalid_evidence" });
      const recipient = await codecs.recipientDecoder.decode({
        propertyId: command.propertyId,
        folioId,
        revision: prior.revision,
        ciphertext: prior.recipientCiphertext,
        encryptionScheme: prior.recipientScheme,
        keyVersion: prior.recipientKeyVersion,
      });
      if (!recipientValue(recipient)) throw new Error("folio recipient decoder contract violation");
      encoded = await codecs.recipientEncoder.encode({
        propertyId: command.propertyId,
        folioId,
        revision: prior.revision + 1,
        recipient,
      });
    }
    const fingerprint = commandFingerprint(mutation, folioId, encoded);
    const reservationId = await reserve(
      client,
      operation,
      keyHash,
      fingerprint,
      command.propertyId,
      command.audit,
    );
    if (!reservationId) return stop(client, { status: "conflict", reason: "command_in_progress" });

    let revision: number;
    if (action === "create") {
      const inserted = await client.query(
        `INSERT INTO finance.folios(id,property_id,guest_booking_id)
         VALUES ($1::uuid,$2::uuid,$3::uuid) ON CONFLICT DO NOTHING RETURNING id`,
        [folioId, command.propertyId, command.bookingId ?? null],
      );
      if (inserted.rowCount !== 1)
        return stop(client, { status: "conflict", reason: "idempotency_key_reused" });
      revision = 1;
    } else {
      await client.query(
        "SELECT id FROM finance.folios WHERE id=$1::uuid AND property_id=$2::uuid FOR UPDATE",
        [folioId, command.propertyId],
      );
      const current = await latestRevision(client, command.propertyId, folioId);
      if (!current || current.revision !== command.expectedRevision)
        return stop(client, { status: "conflict", reason: "revision_conflict" });
      if (current.revision === MAX_REVISION)
        return stop(client, { status: "conflict", reason: "revision_exhausted" });
      if (current.state === "archived" || (action === "ready" && current.state !== "draft"))
        return stop(client, { status: "conflict", reason: "invalid_state" });
      revision = current.revision + 1;
      prior = current;
    }

    const revisionId = command.commandId;
    const state: FinanceFolioStoredState =
      action === "ready" ? "ready" : action === "archive" ? "archived" : "draft";
    const write = action === "create" || action === "correct" ? command : null;
    const sourceDigest = write ? digest(write) : prior!.sourceDigest;
    const totalAmount = write ? total(write.lines) : null;
    await insertRevision(client, {
      revisionId,
      folioId,
      propertyId: command.propertyId,
      revision,
      state,
      encoded: encoded!,
      write,
      currency: resolved?.currency ?? scope.currency,
      totalAmount,
      sourceDigest,
      sourceFreshness: resolved?.sourceFreshness,
      priorRevisionId: write ? null : prior!.revisionId,
    });
    const receipt = { folioId, revisionId, revision, state } satisfies Receipt;
    await audit(
      client,
      command,
      operation,
      keyHash,
      reservationId,
      receipt,
      sourceDigest,
      acceptedAt,
    );
    await complete(client, reservationId, receipt, acceptedAt);
    await client.query("COMMIT");
    return { status: action === "create" ? "created" : "updated", folioId, revision };
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

async function resolveEvidence(
  client: pg.PoolClient,
  command: CreateFinanceFolioCommand | CorrectFinanceFolioCommand,
  scope: Scope,
  acceptedAt: string,
  scopeOnly: boolean,
): Promise<Resolved | null> {
  const currencies = [
    ...command.lines.map((line) => line.unitAmount.currency),
    ...command.paymentRefs.map((payment) => payment.amount.currency),
  ];
  if (currencies.some((currency) => currency !== scope.currency)) return null;
  const sourceKeys = command.lines.map(
    (line) => `${line.source.type}\u0000${line.source.id}\u0000${line.source.revision}`,
  );
  if (new Set(sourceKeys).size !== sourceKeys.length) return null;
  if (command.bookingId) {
    const booking = await client.query(
      `SELECT id FROM booking.guest_bookings
       WHERE id=$1::uuid AND property_id=$2::uuid AND currency=$3::char(3)`,
      [command.bookingId, command.propertyId, scope.currency],
    );
    if (booking.rowCount !== 1) return null;
  }
  if (!(await validLines(client, command, scope.currency, scopeOnly))) return null;
  if (!(await validPayments(client, command, scope.currency, scopeOnly))) return null;
  return {
    currency: scope.currency,
    sourceFreshness: Object.fromEntries(
      [...new Set([...command.lines.map((line) => line.source.type), "finance.payments"])]
        .filter((source) => source !== "finance.payments" || command.paymentRefs.length > 0)
        .map((source) => [source, acceptedAt]),
    ),
  };
}

async function validLines(
  client: pg.PoolClient,
  command: CreateFinanceFolioCommand | CorrectFinanceFolioCommand,
  currency: string,
  scopeOnly: boolean,
): Promise<boolean> {
  const groups = new Map<string, FinanceFolioLineWrite[]>();
  for (const line of command.lines)
    groups.set(line.source.type, [...(groups.get(line.source.type) ?? []), line]);
  if ([...groups.keys()].some((type) => !SOURCE_TYPES.has(type))) return false;
  const bookingId = command.bookingId;
  const nights = groups.get("booking.nightly_revenue") ?? [];
  if (nights.length) {
    if ((!scopeOnly && !bookingId) || nights.some((line) => !uuid(line.source.id))) return false;
    const rows = await client.query<{
      id: string;
      bookingId: string;
      revision: number;
      currency: string;
      amount: string | null;
      nights: number;
      event: string;
      serviceOn: string;
    }>(
      `SELECT evidence_id::text AS id,guest_booking_id::text AS "bookingId",
              source_revision::int AS revision,currency::text, gross_room_amount::text AS amount,
              occupied_room_nights::int AS nights,economic_event AS event,stay_date::text AS "serviceOn"
       FROM booking.finance_nightly_revenue_evidence
       WHERE property_id=$1::uuid AND evidence_id=ANY($2::uuid[])`,
      [command.propertyId, nights.map((line) => line.source.id)],
    );
    const found = new Map(rows.rows.map((row) => [row.id, row]));
    if (
      nights.some((line) => {
        const row = found.get(line.source.id);
        return !row || (!scopeOnly && !nightMatches(line, row, bookingId!, currency));
      })
    )
      return false;
  }
  const addons = groups.get("booking.addon_purchase") ?? [];
  if (addons.length) {
    if ((!scopeOnly && !bookingId) || addons.some((line) => !uuid(line.source.id))) return false;
    const rows = await client.query<{
      id: string;
      bookingId: string;
      currency: string;
      quantity: string;
      amount: string;
      serviceOn: string;
    }>(
      `SELECT selection_id::text AS id,guest_booking_id::text AS "bookingId",currency::text,
              quantity::text,gross_amount::text AS amount,service_date::text AS "serviceOn"
       FROM booking.finance_addon_purchase_evidence
       WHERE property_id=$1::uuid AND selection_id=ANY($2::uuid[])`,
      [command.propertyId, addons.map((line) => line.source.id)],
    );
    const found = new Map(rows.rows.map((row) => [row.id, row]));
    if (
      addons.some((line) => {
        const row = found.get(line.source.id);
        return !row || (!scopeOnly && !addonMatches(line, row, bookingId!, currency));
      })
    )
      return false;
  }
  const fees = groups.get("finance.provider_fee") ?? [];
  if (fees.length) {
    if (fees.some((line) => !uuid(line.source.id))) return false;
    const rows = await client.query<{
      id: string;
      revision: number;
      currency: string;
      amount: string | null;
      serviceOn: string;
    }>(
      `SELECT provider_fee_evidence_id::text AS id,settlement_revision::int AS revision,
              currency::text,fee_amount::text AS amount,evidence_on::text AS "serviceOn"
       FROM finance.provider_fee_reporting_evidence
       WHERE property_id=$1::uuid AND provider_fee_evidence_id=ANY($2::uuid[])
         AND evidence_state<>'missing'`,
      [command.propertyId, fees.map((line) => line.source.id)],
    );
    const found = new Map(rows.rows.map((row) => [row.id, row]));
    if (
      fees.some((line) => {
        const row = found.get(line.source.id);
        return !row || (!scopeOnly && !feeMatches(line, row, currency));
      })
    )
      return false;
  }
  return true;
}

const SOURCE_TYPES = new Set([
  "booking.nightly_revenue",
  "booking.addon_purchase",
  "finance.provider_fee",
]);

function nightMatches(
  line: FinanceFolioLineWrite,
  row:
    | {
        bookingId: string;
        revision: number;
        currency: string;
        amount: string | null;
        nights: number;
        event: string;
        serviceOn: string;
      }
    | undefined,
  bookingId: string,
  currency: string,
): boolean {
  const kind =
    row?.event === "room_night" || row?.event === "room_night_reversal" ? "room" : "adjustment";
  return (
    !!row &&
    row.amount !== null &&
    row.bookingId === bookingId &&
    row.revision === line.source.revision &&
    row.currency === currency &&
    line.kind === kind &&
    line.serviceOn === row.serviceOn &&
    decimal4(line.quantity) === decimal4(String(Math.max(1, Math.abs(row.nights)))) &&
    lineTotal(line) === decimal4(row.amount)
  );
}

function addonMatches(
  line: FinanceFolioLineWrite,
  row:
    | { bookingId: string; currency: string; quantity: string; amount: string; serviceOn: string }
    | undefined,
  bookingId: string,
  currency: string,
): boolean {
  return (
    !!row &&
    line.source.revision === 1 &&
    row.bookingId === bookingId &&
    row.currency === currency &&
    line.kind === "addon" &&
    line.serviceOn === row.serviceOn &&
    decimal4(line.quantity) === decimal4(row.quantity) &&
    lineTotal(line) === decimal4(row.amount)
  );
}

function feeMatches(
  line: FinanceFolioLineWrite,
  row: { revision: number; currency: string; amount: string | null; serviceOn: string } | undefined,
  currency: string,
): boolean {
  return (
    !!row &&
    row.amount !== null &&
    row.revision === line.source.revision &&
    row.currency === currency &&
    line.kind === "fee" &&
    line.serviceOn === row.serviceOn &&
    decimal4(line.quantity) === "1.0000" &&
    lineTotal(line) === decimal4(row.amount)
  );
}

async function validPayments(
  client: pg.PoolClient,
  command: CreateFinanceFolioCommand | CorrectFinanceFolioCommand,
  currency: string,
  scopeOnly: boolean,
): Promise<boolean> {
  if (!command.paymentRefs.length) return true;
  const result = await client.query<{ id: string; amount: string }>(
    `SELECT id::text,amount::text FROM finance.payments
     WHERE property_id=$1::uuid AND currency=$2::char(3) AND id=ANY($3::uuid[])
       AND ($4::boolean OR status NOT IN ('requires_action','failed','canceled'))
     ${scopeOnly ? "" : "FOR SHARE"}`,
    [command.propertyId, currency, command.paymentRefs.map((item) => item.paymentId), scopeOnly],
  );
  const found = new Map(result.rows.map((row) => [row.id, decimal4(row.amount)]));
  return command.paymentRefs.every((payment) => {
    const amount = found.get(payment.paymentId);
    return amount !== undefined && (scopeOnly || scaled(payment.amount.amount) <= scaled(amount));
  });
}

async function insertRevision(
  client: pg.PoolClient,
  input: {
    revisionId: string;
    folioId: string;
    propertyId: string;
    revision: number;
    state: FinanceFolioStoredState;
    encoded: FinanceFolioRecipientEvidence;
    write: CreateFinanceFolioCommand | CorrectFinanceFolioCommand | null;
    currency: string;
    totalAmount: string | null;
    sourceDigest: string;
    sourceFreshness?: Record<string, string>;
    priorRevisionId: string | null;
  },
) {
  const { write } = input;
  await client.query(
    `INSERT INTO finance.folio_revisions
       (id,folio_id,property_id,revision,state,recipient_snapshot_ciphertext,
        recipient_encryption_scheme,recipient_key_version,recipient_fingerprint,
        recipient_fingerprint_key_version,service_from,service_to,currency,total_amount,
        source_digest,source_freshness)
     SELECT $1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10,
            COALESCE($11::date,prior.service_from),COALESCE($12::date,prior.service_to),
            COALESCE($13::char(3),prior.currency),COALESCE($14::numeric,prior.total_amount),
            $15,COALESCE($16::jsonb,prior.source_freshness)
     FROM (SELECT NULL::date service_from,NULL::date service_to,NULL::char(3) currency,
                  NULL::numeric total_amount,NULL::jsonb source_freshness
           WHERE $17::uuid IS NULL
           UNION ALL SELECT service_from,service_to,currency,total_amount,source_freshness
           FROM finance.folio_revisions WHERE id=$17::uuid) prior`,
    [
      input.revisionId,
      input.folioId,
      input.propertyId,
      input.revision,
      input.state,
      input.encoded.ciphertext,
      input.encoded.encryptionScheme,
      input.encoded.keyVersion,
      input.encoded.fingerprint,
      input.encoded.fingerprintKeyVersion,
      write?.serviceFrom ?? null,
      write?.serviceTo ?? null,
      write ? input.currency : null,
      input.totalAmount,
      input.sourceDigest,
      input.sourceFreshness ? JSON.stringify(input.sourceFreshness) : null,
      input.priorRevisionId,
    ],
  );
  if (write) {
    await client.query(
      `INSERT INTO finance.folio_lines
         (folio_revision_id,folio_id,property_id,folio_revision,currency,position,kind,
          description,quantity,unit_amount,service_on,source_type,source_id,source_revision)
       SELECT $1::uuid,$2::uuid,$3::uuid,$4,$5::char(3),item.position,item.kind,item.description,
              item.quantity::numeric,item.unit_amount::numeric,item.service_on::date,
              item.source_type,item.source_id,item.source_revision
       FROM jsonb_to_recordset($6::jsonb) AS item(position int,kind text,description text,
         quantity text,unit_amount text,service_on text,source_type text,source_id text,source_revision bigint)`,
      [
        input.revisionId,
        input.folioId,
        input.propertyId,
        input.revision,
        input.currency,
        JSON.stringify(
          write.lines.map((line) => ({
            position: line.position,
            kind: line.kind,
            description: line.description,
            quantity: line.quantity,
            unit_amount: line.unitAmount.amount,
            service_on: line.serviceOn,
            source_type: line.source.type,
            source_id: line.source.id,
            source_revision: line.source.revision,
          })),
        ),
      ],
    );
    await client.query(
      `INSERT INTO finance.folio_payment_references
         (folio_revision_id,folio_id,property_id,folio_revision,currency,position,payment_id,amount)
       SELECT $1::uuid,$2::uuid,$3::uuid,$4,$5::char(3),item.position,item.payment_id::uuid,item.amount::numeric
       FROM jsonb_to_recordset($6::jsonb) AS item(position int,payment_id text,amount text)`,
      [
        input.revisionId,
        input.folioId,
        input.propertyId,
        input.revision,
        input.currency,
        JSON.stringify(
          write.paymentRefs.map((payment, index) => ({
            position: index + 1,
            payment_id: payment.paymentId,
            amount: payment.amount.amount,
          })),
        ),
      ],
    );
  } else {
    await client.query(
      `INSERT INTO finance.folio_lines
         (folio_revision_id,folio_id,property_id,folio_revision,currency,position,kind,
          description,quantity,unit_amount,service_on,source_type,source_id,source_revision)
       SELECT $1::uuid,$2::uuid,$3::uuid,$4,currency,position,kind,description,quantity,
              unit_amount,service_on,source_type,source_id,source_revision
       FROM finance.folio_lines WHERE folio_revision_id=$5::uuid`,
      [input.revisionId, input.folioId, input.propertyId, input.revision, input.priorRevisionId],
    );
    await client.query(
      `INSERT INTO finance.folio_payment_references
         (folio_revision_id,folio_id,property_id,folio_revision,currency,position,payment_id,amount)
       SELECT $1::uuid,$2::uuid,$3::uuid,$4,currency,position,payment_id,amount
       FROM finance.folio_payment_references WHERE folio_revision_id=$5::uuid`,
      [input.revisionId, input.folioId, input.propertyId, input.revision, input.priorRevisionId],
    );
  }
}

async function propertyScope(client: pg.PoolClient, propertyId: string): Promise<Scope | null> {
  const result = await client.query<{ currency: string }>(
    `SELECT pricing.currency::text FROM hotel_catalog.properties property
     JOIN pms.property_pricing_settings pricing ON pricing.property_id=property.id
     WHERE property.id=$1::uuid`,
    [propertyId],
  );
  return result.rows[0] ?? null;
}

async function scopedFolio(client: pg.PoolClient, propertyId: string, folioId: string) {
  const result = await client.query<{ bookingId: string | null }>(
    `SELECT guest_booking_id::text AS "bookingId" FROM finance.folios
     WHERE id=$1::uuid AND property_id=$2::uuid`,
    [folioId, propertyId],
  );
  return result.rows[0] ?? null;
}

async function latestRevision(client: pg.PoolClient, propertyId: string, folioId: string) {
  const result = await client.query<Latest>(
    `SELECT id::text AS "revisionId",revision::int,state,
            recipient_snapshot_ciphertext AS "recipientCiphertext",
            recipient_encryption_scheme AS "recipientScheme",recipient_key_version AS "recipientKeyVersion",
            recipient_fingerprint AS "recipientFingerprint",
            recipient_fingerprint_key_version AS "recipientFingerprintKeyVersion",
            source_digest AS "sourceDigest",
            (SELECT count(*)::int FROM finance.folio_lines
             WHERE folio_revision_id=finance.folio_revisions.id) AS "lineCount"
     FROM finance.folio_revisions WHERE property_id=$1::uuid AND folio_id=$2::uuid
     ORDER BY revision DESC LIMIT 1`,
    [propertyId, folioId],
  );
  return result.rows[0] ?? null;
}

async function exactRevision(
  client: pg.PoolClient,
  propertyId: string,
  folioId: string,
  revision: number,
) {
  const result = await client.query<Latest>(
    `SELECT id::text AS "revisionId",revision::int,state,
            recipient_snapshot_ciphertext AS "recipientCiphertext",
            recipient_encryption_scheme AS "recipientScheme",recipient_key_version AS "recipientKeyVersion",
            recipient_fingerprint AS "recipientFingerprint",
            recipient_fingerprint_key_version AS "recipientFingerprintKeyVersion",
            source_digest AS "sourceDigest",
            (SELECT count(*)::int FROM finance.folio_lines
             WHERE folio_revision_id=finance.folio_revisions.id) AS "lineCount"
     FROM finance.folio_revisions WHERE property_id=$1::uuid AND folio_id=$2::uuid AND revision=$3`,
    [propertyId, folioId, revision],
  );
  return result.rows[0] ?? null;
}

async function idempotency(
  client: pg.PoolClient,
  operation: string,
  keyHash: string,
  propertyId: string,
) {
  const result = await client.query<IdempotencyRow>(
    `SELECT status,request_fingerprint_hash AS fingerprint,response_body_hash AS "responseHash",
            idempotency_metadata AS metadata
     FROM platform.idempotency_keys WHERE operation_scope='finance' AND operation=$1 AND key_hash=$2
       AND tenant_scope='property' AND property_id=$3::uuid FOR UPDATE`,
    [operation, keyHash, propertyId],
  );
  return result.rows[0] ?? null;
}

async function reserve(
  client: pg.PoolClient,
  operation: string,
  keyHash: string,
  fingerprint: string,
  propertyId: string,
  auditValue: FinanceCommandAudit,
) {
  const result = await client.query<{ id: string }>(
    `INSERT INTO platform.idempotency_keys
       (operation_scope,operation,key_hash,request_fingerprint_hash,status,tenant_scope,
        property_id,correlation_id,expires_at)
     VALUES ('finance',$1,$2,$3,'in_progress','property',$4::uuid,$5,'infinity')
     ON CONFLICT DO NOTHING RETURNING id::text`,
    [operation, keyHash, fingerprint, propertyId, auditValue.correlationId ?? auditValue.requestId],
  );
  return result.rows[0]?.id ?? null;
}

async function replay(
  client: pg.PoolClient,
  decoder: FinanceFolioRecipientDecoder,
  row: IdempotencyRow,
  mutation: Mutation,
  requestedFolioId: string,
): Promise<FinanceFolioCommandResult> {
  if (row.status !== "completed") return { status: "conflict", reason: "command_in_progress" };
  const receipt = parseReceipt(record(row.metadata)?.["result"]);
  if (!receipt || row.responseHash !== receiptHash(receipt))
    throw new Error("folio idempotency evidence is invalid");
  const target = await exactRevision(
    client,
    mutation.command.propertyId,
    receipt.folioId,
    receipt.revision,
  );
  if (!target || target.revisionId !== receipt.revisionId || target.state !== receipt.state)
    throw new Error("folio idempotency target is invalid");
  let fingerprint: string;
  if (mutation.action === "create" || mutation.action === "correct") {
    const recipient = await decoder.decode({
      propertyId: mutation.command.propertyId,
      folioId: receipt.folioId,
      revision: receipt.revision,
      ciphertext: target.recipientCiphertext,
      encryptionScheme: target.recipientScheme,
      keyVersion: target.recipientKeyVersion,
    });
    if (!recipientValue(recipient)) throw new Error("folio recipient decoder contract violation");
    if (
      recipient.name !== mutation.command.recipient.name ||
      recipient.email !== mutation.command.recipient.email
    )
      return { status: "conflict", reason: "idempotency_key_reused" };
    fingerprint = commandFingerprint(mutation, requestedFolioId, {
      fingerprint: target.recipientFingerprint,
      fingerprintKeyVersion: target.recipientFingerprintKeyVersion,
    });
  } else {
    fingerprint = commandFingerprint(mutation, requestedFolioId, null);
  }
  if (row.fingerprint !== fingerprint)
    return { status: "conflict", reason: "idempotency_key_reused" };
  return { status: "replayed", folioId: receipt.folioId, revision: receipt.revision };
}

async function audit(
  client: pg.PoolClient,
  command: Base & { commandId: string },
  operation: string,
  keyHash: string,
  reservationId: string,
  receipt: Receipt,
  sourceDigest: string,
  acceptedAt: string,
) {
  const actor = command.audit.actor;
  await client.query(
    `INSERT INTO platform.product_audit_events
       (audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,actor_user_id,
        target_resource_product,target_resource_type,target_resource_id,idempotency_key_id,
        correlation_id,causation_id,redacted_payload,private_payload,audit_metadata,
        retention_class,privacy_scope)
     VALUES ($1,'finance',$2,$3::timestamptz,'property',$4::uuid,'user',$5::uuid,
       'finance','folio',$6,$7::uuid,$8,$9,$10::jsonb,jsonb_build_object('reason',$11::text),
       jsonb_build_object('requestId',$9::text,'requestedAt',$12::text,'actorOrganizationId',$13::text),
       'financial','confidential')`,
    [
      `${operation}.property.${command.propertyId}.folio.${receipt.folioId}.key.${keyHash}.v1`,
      operation,
      acceptedAt,
      command.propertyId,
      actor.kind === "user" ? actor.userId : null,
      receipt.folioId,
      reservationId,
      command.audit.correlationId ?? command.audit.requestId,
      command.audit.requestId,
      JSON.stringify({
        commandId: command.commandId,
        revision: receipt.revision,
        state: receipt.state,
        sourceDigest,
      }),
      command.audit.reason,
      command.audit.requestedAt,
      actor.kind === "user" ? actor.organizationId : null,
    ],
  );
}

async function complete(
  client: pg.PoolClient,
  reservationId: string,
  receipt: Receipt,
  acceptedAt: string,
) {
  const result = await client.query(
    `UPDATE platform.idempotency_keys SET status='completed',response_status_code=200,
       response_body_hash=$2,completed_at=$3::timestamptz,idempotency_metadata=jsonb_build_object('result',$4::jsonb)
     WHERE id=$1::uuid AND status='in_progress'`,
    [reservationId, receiptHash(receipt), acceptedAt, JSON.stringify(receipt)],
  );
  if (result.rowCount !== 1) throw new Error("folio idempotency completion failed");
}

function commandFingerprint(
  mutation: Mutation,
  folioId: string,
  encoded: Pick<FinanceFolioRecipientEvidence, "fingerprint" | "fingerprintKeyVersion"> | null,
) {
  const { command, action } = mutation;
  const write = action === "create" || action === "correct" ? command : null;
  return hash(
    JSON.stringify([
      action,
      command.commandId,
      folioId,
      command.expectedRevision ?? null,
      write?.bookingId ?? null,
      write ? (encoded?.fingerprint ?? null) : null,
      write ? (encoded?.fingerprintKeyVersion ?? null) : null,
      write?.serviceFrom ?? null,
      write?.serviceTo ?? null,
      write?.lines ?? null,
      write?.paymentRefs ?? null,
    ]),
  );
}

function digest(write: FinanceFolioWrite): string {
  return hash(
    JSON.stringify([
      write.bookingId ?? null,
      write.serviceFrom,
      write.serviceTo,
      write.lines.map((line) => [
        line.position,
        line.kind,
        line.quantity,
        line.unitAmount,
        line.serviceOn,
        line.source,
      ]),
      write.paymentRefs,
    ]),
  );
}

function receiptHash(receipt: Receipt): string {
  return hash(
    JSON.stringify([receipt.folioId, receipt.revisionId, receipt.revision, receipt.state]),
  );
}

function total(lines: readonly FinanceFolioLineWrite[]): string {
  return fromScaled(lines.reduce((sum, line) => sum + scaled(lineTotal(line)), 0n));
}

function lineTotal(line: FinanceFolioLineWrite): string {
  const product = scaled(line.quantity) * scaled(line.unitAmount.amount);
  const negative = product < 0n;
  const absolute = negative ? -product : product;
  const rounded = (absolute + 5_000n) / 10_000n;
  return fromScaled(negative ? -rounded : rounded);
}

function scaled(value: string): bigint {
  if (!/^-?(?:0|[1-9]\d{0,14})(?:\.\d{1,4})?$/.test(value))
    throw new Error("folio decimal failed contract validation");
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const result = BigInt(whole!) * 10_000n + BigInt(fraction.padEnd(4, "0"));
  return negative ? -result : result;
}

function fromScaled(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / 10_000n}.${String(absolute % 10_000n).padStart(4, "0")}`;
}

function decimal4(value: string): string {
  return fromScaled(scaled(value));
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
function recipientValue(value: unknown): value is { name: string; email: string | null } {
  const item = record(value);
  return (
    item !== null &&
    typeof item.name === "string" &&
    (item.email === null || typeof item.email === "string")
  );
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function parseReceipt(value: unknown): Receipt | null {
  const item = record(value);
  return item &&
    Object.keys(item).sort().join(" ") === "folioId revision revisionId state" &&
    uuid(item.folioId) &&
    uuid(item.revisionId) &&
    Number.isSafeInteger(item.revision) &&
    Number(item.revision) >= 1 &&
    ["draft", "ready", "archived"].includes(String(item.state))
    ? (item as Receipt)
    : null;
}

function validate(
  command: Base & {
    commandId: string;
    idempotencyKey: string;
    expectedRevision?: number;
    folioId?: string;
  },
  action: Mutation["action"],
) {
  const actor = command.audit?.actor;
  if (action === "create" || action === "correct") {
    const write = { ...command } as Record<string, unknown>;
    delete write["propertyId"];
    delete write["audit"];
    delete write["folioId"];
    if (!parseFinanceFolioWrite(write, action))
      throw new Error("folio command failed contract validation");
  }
  if (
    !uuid(command.propertyId) ||
    !uuid(command.commandId) ||
    !trimmed(command.idempotencyKey, 200) ||
    (action !== "create" && !uuid(command.folioId)) ||
    (action === "create"
      ? command.expectedRevision !== undefined
      : !revision(command.expectedRevision)) ||
    actor?.kind !== "user" ||
    !uuid(actor.userId) ||
    !uuid(actor.organizationId) ||
    !trimmed(command.audit.requestId, 200) ||
    (command.audit.correlationId !== undefined && !trimmed(command.audit.correlationId, 200)) ||
    !trimmed(command.audit.reason, 500) ||
    !utc(command.audit.requestedAt)
  )
    throw new Error("folio command failed contract validation");
}
function trimmed(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_REVISION;
}
function utc(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(new Date(value).getTime())
  );
}
async function stop<T>(client: pg.PoolClient, result: T): Promise<T> {
  await client.query("ROLLBACK");
  return result;
}
async function rollback(client: pg.PoolClient) {
  try {
    await client.query("ROLLBACK");
  } catch {}
}
