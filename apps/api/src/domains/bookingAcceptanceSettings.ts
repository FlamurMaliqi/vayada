import pg, { type QueryResult, type QueryResultRow } from "pg";

export const BOOKING_ACCEPTANCE_MODES = ["instant", "request"] as const;

export type BookingAcceptanceMode = (typeof BOOKING_ACCEPTANCE_MODES)[number];

export type BookingAcceptanceSettingsPort = {
  findAcceptanceMode(propertyId: string): Promise<BookingAcceptanceMode | null>;
  updateAcceptanceMode(
    propertyId: string,
    acceptanceMode: BookingAcceptanceMode,
  ): Promise<BookingAcceptanceMode | null>;
  close?(): Promise<void>;
};

type BookingAcceptanceSettingsPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  end(): Promise<void>;
};

type BookingAcceptanceSettingsRow = QueryResultRow & {
  acceptanceMode: BookingAcceptanceMode;
};

export function createTargetBookingAcceptanceSettingsPort(config: {
  connectionString: string;
  max?: number;
  pool?: BookingAcceptanceSettingsPool;
}): BookingAcceptanceSettingsPort {
  if (!config.connectionString.trim()) {
    throw new Error("Booking acceptance settings connectionString must not be empty");
  }
  const pool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });

  return {
    async findAcceptanceMode(propertyId) {
      const result = await pool.query<BookingAcceptanceSettingsRow>(
        `SELECT acceptance_mode AS "acceptanceMode"
           FROM booking.booking_settings
          WHERE property_id = $1::uuid`,
        [propertyId],
      );
      return result.rows[0]?.acceptanceMode ?? null;
    },
    async updateAcceptanceMode(propertyId, acceptanceMode) {
      const result = await pool.query<BookingAcceptanceSettingsRow>(
        `UPDATE booking.booking_settings
            SET acceptance_mode = $2,
                updated_at = now()
          WHERE property_id = $1::uuid
      RETURNING acceptance_mode AS "acceptanceMode"`,
        [propertyId, acceptanceMode],
      );
      return result.rows[0]?.acceptanceMode ?? null;
    },
    async close() {
      await pool.end();
    },
  };
}

export function isBookingAcceptanceMode(value: unknown): value is BookingAcceptanceMode {
  return BOOKING_ACCEPTANCE_MODES.includes(value as BookingAcceptanceMode);
}
