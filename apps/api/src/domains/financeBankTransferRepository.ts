import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import type { createBankTransferCodec, BankTransferDetails } from "./financeBankTransferCodec.js";

type Codec = ReturnType<typeof createBankTransferCodec>;
export type BankTransferQueryable = {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
};
export type BankTransferDestinationSummary = {
  id: string;
  propertyId: string;
  revision: number;
  version: number;
  enabled: boolean;
  accountLast4: string;
  deleted: boolean;
};
export type BankTransferDestinationCommand = {
  propertyId: string;
  commandId: string;
  expectedVersion: number;
  actorId: string;
  action: "replace" | "disable" | "delete";
  details?: BankTransferDetails;
};
const columns = `id::text, property_id::text AS "propertyId", revision, state_version AS version, enabled,
  account_last4 AS "accountLast4", deleted_at IS NOT NULL AS deleted`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function createBankTransferRepository(connectionString: string, codec?: Codec) {
  const pool = new pg.Pool({ connectionString });
  async function read(propertyId: string, queryable: Pick<pg.Pool, "query"> = pool) {
    return (
      (
        await queryable.query<BankTransferDestinationSummary>(
          `SELECT ${columns} FROM finance.bank_transfer_destinations
       WHERE property_id = $1::uuid ORDER BY revision DESC LIMIT 1`,
          [propertyId],
        )
      ).rows[0] ?? null
    );
  }
  return {
    read,
    async execute(command: BankTransferDestinationCommand) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s'");
        const property = await client.query(
          "SELECT id FROM hotel_catalog.properties WHERE id=$1::uuid FOR UPDATE",
          [command.propertyId],
        );
        if (!property.rowCount) throw new Error();
        const keyHash = hash(`${command.propertyId}:${command.commandId}`);
        const fingerprint = hash(
          JSON.stringify({
            propertyId: command.propertyId,
            commandId: command.commandId,
            expectedVersion: command.expectedVersion,
            actorId: command.actorId,
            action: command.action,
            details: command.details
              ? Object.entries(command.details).sort(([a], [b]) => a.localeCompare(b))
              : null,
          }),
        );
        const replay = (
          await client.query<{ fingerprint: string; summary: BankTransferDestinationSummary }>(
            `SELECT request_fingerprint_hash AS fingerprint, idempotency_metadata->'summary' AS summary
           FROM platform.idempotency_keys WHERE operation_scope='finance'
           AND operation='bank_transfer_destination' AND key_hash=$1
           AND property_id=$2::uuid`,
            [keyHash, command.propertyId],
          )
        ).rows[0];
        if (replay) {
          await client.query("ROLLBACK");
          return replay.fingerprint === fingerprint
            ? { status: "replayed" as const, summary: replay.summary }
            : { status: "conflict" as const };
        }
        const previous = await read(command.propertyId, client);
        if (
          (previous?.version ?? 0) !== command.expectedVersion ||
          (command.action !== "replace" && !previous)
        ) {
          await client.query("ROLLBACK");
          return { status: "conflict" as const };
        }
        let id = previous?.id ?? randomUUID();
        if (command.action === "replace") {
          if (!codec) throw new Error();
          id = randomUUID();
          const revision = (previous?.revision ?? 0) + 1;
          const encrypted = await codec.encrypt(
            { propertyId: command.propertyId, id, revision },
            command.details,
          );
          await client.query(
            "UPDATE finance.bank_transfer_destinations SET enabled=FALSE WHERE property_id=$1::uuid AND enabled",
            [command.propertyId],
          );
          await client.query(
            `INSERT INTO finance.bank_transfer_destinations
            (id, property_id, revision, ciphertext, key_arn, account_last4, state_version)
            VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7)`,
            [
              id,
              command.propertyId,
              revision,
              encrypted.ciphertext,
              encrypted.keyArn,
              encrypted.accountLast4,
              (previous?.version ?? 0) + 1,
            ],
          );
        } else {
          await client.query(
            command.action === "delete"
              ? `UPDATE finance.bank_transfer_destinations SET enabled=FALSE, state_version=state_version+1, ciphertext=NULL,
               deleted_at=COALESCE(deleted_at,now()) WHERE property_id=$1::uuid`
              : "UPDATE finance.bank_transfer_destinations SET enabled=FALSE, state_version=state_version+1 WHERE property_id=$1::uuid",
            [command.propertyId],
          );
        }
        const summary = (await read(command.propertyId, client))!;
        await recordBankTransferAudit(client, {
          propertyId: command.propertyId,
          id,
          actorId: command.actorId,
          auditKey: keyHash,
          action:
            command.action === "replace"
              ? previous
                ? "replaced"
                : "created"
              : `${command.action}d`,
        });
        await client.query(
          `INSERT INTO platform.idempotency_keys
          (operation_scope, operation, key_hash, request_fingerprint_hash, status,
           tenant_scope, property_id, expires_at, completed_at, response_status_code, response_body_hash, idempotency_metadata)
          VALUES ('finance','bank_transfer_destination',$1,$2,'completed','property',$3::uuid,
                  'infinity'::timestamptz,now(),200,$4,$5::jsonb)`,
          [
            keyHash,
            fingerprint,
            command.propertyId,
            hash(JSON.stringify(summary)),
            JSON.stringify({ summary }),
          ],
        );
        await client.query("COMMIT");
        return { status: "applied" as const, summary };
      } catch {
        await client.query("ROLLBACK");
        throw new Error("Bank transfer destination unavailable.");
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export async function recordBankTransferAudit(
  queryable: BankTransferQueryable,
  input: {
    propertyId: string;
    id: string;
    action: string;
    actorId?: string;
    auditKey: string;
    bookingId?: string;
  },
) {
  await queryable.query(
    `INSERT INTO platform.product_audit_events
    (audit_key, product, action, action_version, occurred_at, tenant_scope, property_id,
     actor_type, actor_user_id, target_resource_product, target_resource_type, target_resource_id,
     redacted_payload, private_payload, audit_metadata, retention_class, privacy_scope)
    VALUES ($1,'finance',$2,1,now(),'property',$3::uuid,$4,$5::uuid,'finance',
      'bank_transfer_destination',$6,$7::jsonb,'{}'::jsonb,'{}'::jsonb,'financial','confidential')
    ON CONFLICT (product,audit_key) DO NOTHING`,
    [
      `bank-transfer:${input.auditKey}`,
      `finance.bank_transfer_destination.${input.action}`,
      input.propertyId,
      input.actorId ? "user" : "system",
      input.actorId ?? null,
      input.id,
      JSON.stringify({ destinationId: input.id, bookingId: input.bookingId ?? null }),
    ],
  );
}
