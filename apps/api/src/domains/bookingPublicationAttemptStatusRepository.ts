import pg, { type QueryResult, type QueryResultRow } from "pg";

export type BookingPublicationStatusTransaction = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
};

type StatusClient = BookingPublicationStatusTransaction & {
  release(): void;
};

export type BookingPublicationAttemptStatusPool = {
  connect(): Promise<StatusClient>;
  end(): Promise<void>;
};

export interface BookingPublicationAttemptStatusPort {
  markSucceeded(input: {
    operationId: string;
    propertyId: string;
    resultContentRevisionId: string;
    completedAt: Date;
  }): Promise<void>;
  /** Participates in the caller's transaction; the caller owns commit/rollback. */
  markSucceededInTransaction(
    transaction: BookingPublicationStatusTransaction,
    input: {
      operationId: string;
      propertyId: string;
      resultContentRevisionId: string;
      completedAt: Date;
    },
  ): Promise<void>;
  markFailed(input: {
    operationId: string;
    propertyId: string;
    failureCode: "projection_failed" | "source_content_changed";
    completedAt: Date;
  }): Promise<void>;
  /** Participates in the caller's transaction; the caller owns commit/rollback. */
  markFailedInTransaction(
    transaction: BookingPublicationStatusTransaction,
    input: {
      operationId: string;
      propertyId: string;
      failureCode: "projection_failed" | "source_content_changed";
      completedAt: Date;
    },
  ): Promise<void>;
  close?(): Promise<void>;
}

type AttemptRow = {
  status: "pending" | "succeeded" | "failed" | "unknown";
  resultContentRevisionId: string | null;
  failureCode: string | null;
};

/** Booking-owned terminal-state writer used only by the typed projector boundary. */
export function createPgBookingPublicationAttemptStatusRepository(config: {
  connectionString: string;
  max?: number;
  pool?: BookingPublicationAttemptStatusPool;
}): BookingPublicationAttemptStatusPort {
  if (!config.connectionString.trim()) {
    throw new Error("Booking publication status connectionString must not be empty");
  }
  const ownsPool = !config.pool;
  const pool =
    config.pool ??
    (new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    }) as BookingPublicationAttemptStatusPool);

  return {
    async markSucceeded(input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await markSucceededInTransaction(client, input);
        await client.query("COMMIT");
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },

    markSucceededInTransaction,

    async markFailed(input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await markFailedInTransaction(client, input);
        await client.query("COMMIT");
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },

    markFailedInTransaction,

    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

async function lockAttempt(
  client: BookingPublicationStatusTransaction,
  operationId: string,
  propertyId: string,
): Promise<AttemptRow | null> {
  const result = await client.query<AttemptRow>(
    `SELECT status,
            result_content_revision_id::text AS "resultContentRevisionId",
            failure_code AS "failureCode"
     FROM booking.booking_publication_attempts
     WHERE id = $1::uuid
       AND property_id = $2::uuid
     FOR UPDATE`,
    [operationId, propertyId],
  );
  return result.rows[0] ?? null;
}

async function markFailedInTransaction(
  client: BookingPublicationStatusTransaction,
  input: {
    operationId: string;
    propertyId: string;
    failureCode: "projection_failed" | "source_content_changed";
    completedAt: Date;
  },
): Promise<void> {
  const attempt = await lockAttempt(client, input.operationId, input.propertyId);
  if (!attempt) throw new Error("Booking publication attempt is unavailable");
  if (attempt.status === "failed") {
    if (attempt.failureCode !== input.failureCode) {
      throw new Error("Booking publication failure code changed");
    }
    return;
  }
  if (attempt.status === "succeeded") return;
  const updated = await client.query(
    `UPDATE booking.booking_publication_attempts
     SET status = 'failed',
         result_content_revision_id = NULL,
         failure_code = $3,
         updated_at = $4::timestamptz,
         completed_at = $4::timestamptz
     WHERE id = $1::uuid
       AND property_id = $2::uuid
       AND status IN ('pending', 'unknown')`,
    [input.operationId, input.propertyId, input.failureCode, input.completedAt.toISOString()],
  );
  if (updated.rowCount !== 1) throw new Error("Booking publication failure update failed");
}

async function markSucceededInTransaction(
  client: BookingPublicationStatusTransaction,
  input: {
    operationId: string;
    propertyId: string;
    resultContentRevisionId: string;
    completedAt: Date;
  },
): Promise<void> {
  const attempt = await lockAttempt(client, input.operationId, input.propertyId);
  if (!attempt) throw new Error("Booking publication attempt is unavailable");
  if (attempt.status === "succeeded") {
    if (attempt.resultContentRevisionId !== input.resultContentRevisionId) {
      throw new Error("Booking publication success revision changed");
    }
    return;
  }
  if (attempt.status === "failed") {
    throw new Error("A failed Booking publication cannot become succeeded");
  }
  const updated = await client.query(
    `UPDATE booking.booking_publication_attempts
     SET status = 'succeeded',
         result_content_revision_id = $3::uuid,
         failure_code = NULL,
         updated_at = $4::timestamptz,
         completed_at = $4::timestamptz
     WHERE id = $1::uuid
       AND property_id = $2::uuid
       AND status IN ('pending', 'unknown')`,
    [
      input.operationId,
      input.propertyId,
      input.resultContentRevisionId,
      input.completedAt.toISOString(),
    ],
  );
  if (updated.rowCount !== 1) throw new Error("Booking publication success update failed");
}

async function rollback(client: StatusClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}
