import pg, { type QueryResult, type QueryResultRow } from "pg";

import type { AuthSurface } from "../routes/authSession.js";

export type AuthHandoffRoutingHints = {
  hotelId?: string;
  organizationId?: string;
  propertyId?: string;
  workosOrganizationId?: string;
};

export type AuthSessionHandoff = {
  sealedSession: string;
  sourceSurface: AuthSurface;
  targetPath: string;
  targetPublicOrigin: string;
  targetSurface: AuthSurface;
  routingHints: AuthHandoffRoutingHints;
};

export type AuthSessionHandoffRepository = {
  create(
    input: AuthSessionHandoff & {
      codeDigest: string;
      expiresAt: Date;
      sourcePublicOrigin: string;
    },
  ): Promise<boolean>;
  claim(input: {
    codeDigest: string;
    now: Date;
    redemptionId: string;
    targetPublicOrigin: string;
    targetSurface: AuthSurface;
  }): Promise<AuthSessionHandoff | null>;
  complete(input: { now: Date; redemptionId: string }): Promise<boolean>;
  release(input: { redemptionId: string }): Promise<void>;
  scrubExpired(input: { deleteBefore: Date; now: Date }): Promise<void>;
};

type HandoffRow = QueryResultRow & {
  routingHints: AuthHandoffRoutingHints;
  sealedSession: string;
  sourceSurface: AuthSurface;
  targetPath: string;
  targetPublicOrigin: string;
  targetSurface: AuthSurface;
};

type PgClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
};

export function createPgAuthSessionHandoffRepository(config: {
  connectionString: string;
  pool?: PgClient;
}): AuthSessionHandoffRepository {
  const pool: PgClient =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: 8,
      idleTimeoutMillis: 30_000,
    });

  return {
    async create(input) {
      const result = await pool.query<{ handoffId: string }>(
        `WITH expired AS (
           DELETE FROM identity.auth_session_handoffs
           WHERE expires_at <= now()
             AND (
               redemption_id IS NULL
               OR redemption_started_at <= now() - interval '30 seconds'
             )
         )
         INSERT INTO identity.auth_session_handoffs (
           code_digest, source_surface, target_surface,
           source_public_origin, target_public_origin,
           sealed_session, target_path, routing_hints, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
         ON CONFLICT (code_digest) DO NOTHING
         RETURNING id::text AS "handoffId"`,
        [
          input.codeDigest,
          input.sourceSurface,
          input.targetSurface,
          input.sourcePublicOrigin,
          input.targetPublicOrigin,
          input.sealedSession,
          input.targetPath,
          JSON.stringify(input.routingHints),
          input.expiresAt,
        ],
      );
      return Boolean(result.rows[0]);
    },

    async claim(input) {
      const result = await pool.query<HandoffRow>(
        `WITH expired AS (
           DELETE FROM identity.auth_session_handoffs
           WHERE expires_at <= $4
             AND (
               redemption_id IS NULL
               OR redemption_started_at <= $4 - interval '30 seconds'
             )
         )
         UPDATE identity.auth_session_handoffs
         SET redemption_id = $5,
             redemption_started_at = $4
         WHERE code_digest = $1
           AND target_surface = $2
           AND target_public_origin = $3
           AND (
             redemption_id IS NULL
             OR redemption_started_at <= $4 - interval '30 seconds'
           )
           AND consumed_at IS NULL
           AND expires_at > $4
         RETURNING
           sealed_session AS "sealedSession",
           source_surface AS "sourceSurface",
           target_surface AS "targetSurface",
           target_public_origin AS "targetPublicOrigin",
           target_path AS "targetPath",
           routing_hints AS "routingHints"`,
        [
          input.codeDigest,
          input.targetSurface,
          input.targetPublicOrigin,
          input.now,
          input.redemptionId,
        ],
      );
      return result.rows[0] ?? null;
    },

    async complete(input) {
      const result = await pool.query<{ handoffId: string }>(
        `UPDATE identity.auth_session_handoffs
         SET consumed_at = $2,
             sealed_session = NULL,
             redemption_id = NULL,
             redemption_started_at = NULL
         WHERE redemption_id = $1
           AND consumed_at IS NULL
         RETURNING id::text AS "handoffId"`,
        [input.redemptionId, input.now],
      );
      return Boolean(result.rows[0]);
    },

    async release(input) {
      await pool.query(
        `UPDATE identity.auth_session_handoffs
         SET redemption_id = NULL,
             redemption_started_at = NULL
         WHERE redemption_id = $1
           AND consumed_at IS NULL`,
        [input.redemptionId],
      );
    },

    async scrubExpired(input) {
      await pool.query(
        `UPDATE identity.auth_session_handoffs
         SET consumed_at = COALESCE(consumed_at, expires_at),
             sealed_session = NULL,
             redemption_id = NULL,
             redemption_started_at = NULL
         WHERE expires_at <= $1
           AND (
             redemption_id IS NULL
             OR redemption_started_at <= $1 - interval '30 seconds'
           )
           AND sealed_session IS NOT NULL`,
        [input.now],
      );
      await pool.query(
        `DELETE FROM identity.auth_session_handoffs
         WHERE expires_at < $1
           AND sealed_session IS NULL`,
        [input.deleteBefore],
      );
    },
  };
}
