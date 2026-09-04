import pg, { type QueryResultRow } from "pg";

type Pool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
  end?(): Promise<void>;
};

export type PmsInboxDeliveryReceiptPort = {
  recordTrustedReceipt(input: {
    propertyId: string;
    messageId: string;
    attemptNumber: number;
    receiptType: "delivered" | "read";
    providerReceiptId: string;
    acknowledgedAt: Date;
  }): Promise<{ recorded: boolean }>;
  close(): Promise<void>;
};

export function createPgPmsInboxDeliveryReceiptPort(config: {
  connectionString: string;
  pool?: Pool;
}): PmsInboxDeliveryReceiptPort {
  const ownsPool = !config.pool;
  const pool = config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: 2 });
  return {
    async recordTrustedReceipt(input) {
      if (
        !Number.isInteger(input.attemptNumber) ||
        input.attemptNumber < 1 ||
        !input.providerReceiptId.trim() ||
        !Number.isFinite(input.acknowledgedAt.getTime())
      )
        throw new Error("PMS Inbox delivery receipt is invalid");
      const result = await pool.query<{ recorded: boolean }>(
        `WITH accepted AS (
           SELECT attempt.id
           FROM pms.message_delivery_attempts attempt
           WHERE attempt.property_id = $1::uuid AND attempt.message_id = $2::uuid
             AND attempt.attempt_number = $3 AND attempt.outcome = 'accepted'
         ), inserted AS (
           INSERT INTO pms.message_delivery_receipts (
             property_id, message_id, attempt_id, receipt_type,
             provider_receipt_id, acknowledged_at, receipt_metadata
           )
           SELECT $1::uuid, $2::uuid, accepted.id, $4, $5, $6::timestamptz,
                  jsonb_build_object('source', 'trusted-provider-adapter')
           FROM accepted
           ON CONFLICT (property_id, provider_receipt_id)
             WHERE provider_receipt_id IS NOT NULL DO NOTHING
           RETURNING acknowledged_at
         ), projected AS (
           UPDATE pms.messages message
           SET latest_provider_receipt_at = GREATEST(
             COALESCE(message.latest_provider_receipt_at, '-infinity'::timestamptz),
             inserted.acknowledged_at
           )
           FROM inserted
           WHERE message.property_id = $1::uuid AND message.id = $2::uuid
           RETURNING message.id
         )
         SELECT EXISTS (SELECT 1 FROM projected) AS recorded`,
        [
          input.propertyId,
          input.messageId,
          input.attemptNumber,
          input.receiptType,
          input.providerReceiptId.trim(),
          input.acknowledgedAt.toISOString(),
        ],
      );
      return { recorded: result.rows[0]?.recorded ?? false };
    },
    async close() {
      if (ownsPool) await pool.end?.();
    },
  };
}
