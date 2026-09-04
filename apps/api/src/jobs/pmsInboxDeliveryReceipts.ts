import pg, { type QueryResultRow } from "pg";

type Pool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
  end?(): Promise<void>;
};

export type PmsInboxDeliveryReceiptPort = {
  recordTrustedProviderReceipt(input: {
    adapter: "channex" | "resend";
    providerReference: string;
    receiptType: "delivered" | "read";
    providerReceiptId: string;
    acknowledgedAt: Date;
  }): Promise<{ matched: boolean; recorded: boolean }>;
  close(): Promise<void>;
};

export function createPgPmsInboxDeliveryReceiptPort(config: {
  connectionString: string;
  pool?: Pool;
}): PmsInboxDeliveryReceiptPort {
  const ownsPool = !config.pool;
  const pool = config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: 2 });
  return {
    async recordTrustedProviderReceipt(input) {
      if (
        !input.providerReference.trim() ||
        !input.providerReceiptId.trim() ||
        !Number.isFinite(input.acknowledgedAt.getTime())
      )
        throw new Error("PMS Inbox delivery receipt is invalid");
      const result = await pool.query<{ matched: boolean; recorded: boolean }>(
        `WITH accepted AS (
           SELECT attempt.id, attempt.property_id, attempt.message_id
           FROM pms.message_delivery_attempts attempt
           WHERE attempt.adapter = $1 AND attempt.provider_reference = $2
             AND attempt.outcome = 'accepted'
           ORDER BY attempt.completed_at DESC, attempt.id DESC
           LIMIT 1
         ), inserted AS (
           INSERT INTO pms.message_delivery_receipts (
             property_id, message_id, attempt_id, receipt_type,
             provider_receipt_id, acknowledged_at, receipt_metadata
           )
           SELECT accepted.property_id, accepted.message_id, accepted.id, $3, $4, $5::timestamptz,
                  jsonb_build_object('source', 'trusted-provider-adapter')
           FROM accepted
           ON CONFLICT (property_id, provider_receipt_id)
             WHERE provider_receipt_id IS NOT NULL DO NOTHING
           RETURNING property_id, message_id, acknowledged_at
         ), projected AS (
           UPDATE pms.messages message
           SET latest_provider_receipt_at = GREATEST(
             COALESCE(message.latest_provider_receipt_at, '-infinity'::timestamptz),
             inserted.acknowledged_at
           )
           FROM inserted
           WHERE message.property_id = inserted.property_id AND message.id = inserted.message_id
           RETURNING message.id
         )
         SELECT EXISTS (SELECT 1 FROM accepted) AS matched,
                EXISTS (SELECT 1 FROM projected) AS recorded`,
        [
          input.adapter,
          input.providerReference.trim(),
          input.receiptType,
          input.providerReceiptId.trim(),
          input.acknowledgedAt.toISOString(),
        ],
      );
      return {
        matched: result.rows[0]?.matched ?? false,
        recorded: result.rows[0]?.recorded ?? false,
      };
    },
    async close() {
      if (ownsPool) await pool.end?.();
    },
  };
}
