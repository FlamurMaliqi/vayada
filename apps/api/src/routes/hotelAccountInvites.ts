import { UnauthorizedError, type RequestContext } from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import type { SetupTrack } from "@vayada/domain-hotels";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import pg, { type PoolClient } from "pg";

import type {
  HotelSetupTrackCommandRepository,
  HotelSetupTrackCommandResult,
} from "../domains/hotelSetupTrackCommandRepository.js";
import {
  HOTEL_ACCOUNT_INVITE_CONTRACT_VERSION,
  HOTEL_ACCOUNT_INVITE_HANDOFF_PATH,
  hotelAccountInviteOrganizationExternalId,
  hotelAccountInviteTrackCorrelationId,
  parseHotelAccountInviteCreateRequest,
  type MarketplaceAdminHotelAccountInviteCreateRequest,
} from "./marketplaceAdmin.js";
import { enforceRoutePolicy } from "./policy.js";

type HotelAccountInvitePayload = MarketplaceAdminHotelAccountInviteCreateRequest & {
  contractVersion: typeof HOTEL_ACCOUNT_INVITE_CONTRACT_VERSION;
  handoffPath: typeof HOTEL_ACCOUNT_INVITE_HANDOFF_PATH;
};

export type HotelAccountInvite = HotelAccountInvitePayload & {
  id: string;
  expiresAt: string;
  redemptionOrganizationId: string | null;
};

export type HotelAccountInviteOnboardingResolution = {
  inviteId: string;
  organizationName: string;
  organizationExternalId: string;
};

export type HotelAccountInviteLookupResponse = {
  contractVersion: typeof HOTEL_ACCOUNT_INVITE_CONTRACT_VERSION;
  identity: { emailHint: string };
  organization: HotelAccountInvitePayload["organization"];
  property: HotelAccountInvitePayload["property"];
  selectedTracks: SetupTrack[];
  handoffPath: typeof HOTEL_ACCOUNT_INVITE_HANDOFF_PATH;
  expiresAt: string;
};

export type HotelAccountInviteRedemptionResponse = {
  contractVersion: typeof HOTEL_ACCOUNT_INVITE_CONTRACT_VERSION;
  status: "redeemed" | "already_redeemed";
  selectedTracks: SetupTrack[];
  handoffPath: typeof HOTEL_ACCOUNT_INVITE_HANDOFF_PATH;
};

type ApplyInviteResult = "applied" | "track_conflict" | "temporarily_unavailable";

export type HotelAccountInviteRedemptionResult =
  | { outcome: "redeemed"; invite: HotelAccountInvite }
  | { outcome: "already_redeemed"; invite: HotelAccountInvite }
  | { outcome: "not_available" }
  | { outcome: "wrong_identity" }
  | { outcome: "wrong_organization" }
  | { outcome: "replayed_by_another_actor" }
  | { outcome: "track_conflict" }
  | { outcome: "temporarily_unavailable" };

export type HotelAccountInviteRepository = {
  lookup(input: { code: string; now: Date }): Promise<HotelAccountInvite | null>;
  resolveForOnboarding(input: {
    code: string;
    now: Date;
    actorEmail: string;
  }): Promise<HotelAccountInviteOnboardingResolution | null>;
  redeem(input: {
    code: string;
    now: Date;
    actorUserId: string;
    actorEmail: string;
    organizationId: string;
    applyTracks: (
      invite: HotelAccountInvite,
      mode: "apply" | "recover",
    ) => Promise<ApplyInviteResult>;
  }): Promise<HotelAccountInviteRedemptionResult>;
  close?(): Promise<void>;
};

export type HotelAccountInviteRoutesOptions = {
  repository: HotelAccountInviteRepository;
  trackCommandRepository: Pick<HotelSetupTrackCommandRepository, "getTrackStatus" | "updateTracks">;
  now?: () => Date;
};

type InviteCodeBody = { code?: unknown } | undefined;

type InviteRow = {
  id: string;
  status: "pending" | "redeemed" | "expired" | "revoked";
  payload: unknown;
  redeemedByUserId: string | null;
  redemptionOrganizationId: string | null;
  expiresAt: Date | string;
};

type InviteTrackBindingRow = { organizationId: string };

type PgPool = Pick<pg.Pool, "connect" | "end" | "query">;

const INVITE_PAYLOAD_KEYS = [
  "contractVersion",
  "identity",
  "organization",
  "property",
  "selectedTracks",
  "handoffPath",
] as const;
const INVITE_REDEMPTION_PAYLOAD_KEY = "redemption";
const INVITE_CODE_MAX_LENGTH = 256;
const INVITE_CODE_PATTERN = /^VAY-[A-Za-z0-9_-]{8,252}$/;
const INVITE_TRACK_OPERATION = "hotel_setup.tracks.update";

export async function registerHotelAccountInviteRoutes(
  app: FastifyInstance,
  options: HotelAccountInviteRoutesOptions,
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const redemptionAccess = new WeakMap<FastifyRequest, RequestContext>();
  const authorizeRedemption = async (request: FastifyRequest, reply: FastifyReply) => {
    const context = authorizedHotelContext(request, reply);
    if (context) redemptionAccess.set(request, context);
  };

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "private, no-store");
    return payload;
  });
  app.addHook("onClose", async () => {
    await options.repository.close?.();
  });

  app.post("/hotel-account-invites/lookup", async (request, reply) => {
    const code = parseInviteCode(request.body as InviteCodeBody);
    if (!code) return inviteNotAvailable(reply);

    const invite = await options.repository.lookup({ code, now: now() });
    if (!invite) return inviteNotAvailable(reply);

    return {
      contractVersion: HOTEL_ACCOUNT_INVITE_CONTRACT_VERSION,
      identity: { emailHint: maskEmail(invite.identity.email) },
      organization: invite.organization,
      property: invite.property,
      selectedTracks: invite.selectedTracks,
      handoffPath: HOTEL_ACCOUNT_INVITE_HANDOFF_PATH,
      expiresAt: invite.expiresAt,
    } satisfies HotelAccountInviteLookupResponse;
  });

  app.post(
    "/hotel-account-invites/redeem",
    { onRequest: authorizeRedemption },
    async (request, reply) => {
      const context = redemptionAccess.get(request);
      if (!context)
        throw new Error("Invite redemption access was not resolved before body parsing");

      const code = parseInviteCode(request.body as InviteCodeBody);
      if (!code) return inviteNotAvailable(reply);

      let result: HotelAccountInviteRedemptionResult;
      try {
        result = await options.repository.redeem({
          code,
          now: now(),
          actorUserId: context.actor.internalUserId,
          actorEmail: normalizeEmail(context.actor.email),
          organizationId: context.selectedOrganization.organizationId,
          applyTracks: (invite, mode) => applyInviteTracks(invite, context, options, mode),
        });
      } catch (error) {
        request.log.error({ err: error }, "Hotel account invite redemption failed");
        return temporarilyUnavailable(reply);
      }

      if (result.outcome === "not_available" || result.outcome === "wrong_identity") {
        return inviteNotAvailable(reply);
      }
      if (
        result.outcome === "replayed_by_another_actor" ||
        result.outcome === "wrong_organization"
      ) {
        return reply.status(409).send({
          code:
            result.outcome === "wrong_organization"
              ? "invite_wrong_organization"
              : "invite_already_redeemed",
          detail:
            result.outcome === "wrong_organization"
              ? "Choose the hotel account created for this invitation."
              : "This hotel account invitation is no longer available.",
        });
      }
      if (result.outcome === "track_conflict") {
        return reply.status(409).send({
          code: "invite_track_conflict",
          detail: "The selected hotel account has a conflicting setup route.",
        });
      }
      if (result.outcome === "temporarily_unavailable") return temporarilyUnavailable(reply);

      if (result.outcome === "already_redeemed") {
        let tracksMatch = false;
        try {
          const status = await options.trackCommandRepository.getTrackStatus({
            organizationId: context.selectedOrganization.organizationId,
          });
          tracksMatch = sameTracks(status.selectedTracks, result.invite.selectedTracks);
        } catch (error) {
          request.log.error({ err: error }, "Hotel account invite replay validation failed");
          return temporarilyUnavailable(reply);
        }
        if (!tracksMatch) {
          return reply.status(409).send({
            code: "invite_already_redeemed",
            detail: "This hotel account invitation is no longer available.",
          });
        }
      }

      return {
        contractVersion: HOTEL_ACCOUNT_INVITE_CONTRACT_VERSION,
        status: result.outcome,
        selectedTracks: result.invite.selectedTracks,
        handoffPath: HOTEL_ACCOUNT_INVITE_HANDOFF_PATH,
      } satisfies HotelAccountInviteRedemptionResponse;
    },
  );
}

export function createPgHotelAccountInviteRepository(config: {
  connectionString: string;
  max?: number;
  pool?: PgPool;
}): HotelAccountInviteRepository {
  if (!config.connectionString.trim() && !config.pool) {
    throw new Error("Hotel account invite repository connectionString must not be empty");
  }
  const pool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });

  return {
    async lookup(input) {
      const result = await pool.query<InviteRow>(
        `${INVITE_SELECT}
         WHERE invite.code = $1
           AND invite.invite_type = 'hotel'
           AND invite.payload ->> 'contractVersion' = $2
           AND invite.status = 'pending'
           AND invite.expires_at > $3::timestamptz`,
        [input.code, HOTEL_ACCOUNT_INVITE_CONTRACT_VERSION, input.now.toISOString()],
      );
      return toInvite(result.rows[0]);
    },

    async resolveForOnboarding(input) {
      const code = parseInviteCode({ code: input.code });
      if (!code) return null;
      const result = await pool.query<InviteRow>(
        `${INVITE_SELECT}
         WHERE invite.code = $1
           AND invite.invite_type = 'hotel'
           AND invite.payload ->> 'contractVersion' = $2
           AND invite.status = 'pending'
           AND invite.expires_at > $3::timestamptz`,
        [code, HOTEL_ACCOUNT_INVITE_CONTRACT_VERSION, input.now.toISOString()],
      );
      const invite = toInvite(result.rows[0]);
      if (!invite || invite.identity.email !== normalizeEmail(input.actorEmail)) return null;
      return onboardingResolution(invite);
    },

    async redeem(input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query<InviteRow>(
          `${INVITE_SELECT}
           WHERE invite.code = $1
             AND invite.invite_type = 'hotel'
             AND invite.payload ->> 'contractVersion' = $2
           FOR UPDATE`,
          [input.code, HOTEL_ACCOUNT_INVITE_CONTRACT_VERSION],
        );
        const row = result.rows[0];
        const invite = toInvite(row);
        if (!row || !invite || row.status === "revoked" || row.status === "expired") {
          await client.query("ROLLBACK");
          return { outcome: "not_available" };
        }
        if (row.status === "redeemed") {
          await client.query("ROLLBACK");
          return row.redeemedByUserId === input.actorUserId &&
            row.redemptionOrganizationId === input.organizationId
            ? { outcome: "already_redeemed", invite }
            : { outcome: "replayed_by_another_actor" };
        }
        if (invite.identity.email !== input.actorEmail) {
          await client.query("ROLLBACK");
          return { outcome: "wrong_identity" };
        }

        if (!(await hasInviteOrganizationBinding(client, input.organizationId, invite.id))) {
          await client.query("ROLLBACK");
          return { outcome: "wrong_organization" };
        }

        const trackBinding = await findSuccessfulTrackBinding(client, invite.id);
        if (trackBinding && trackBinding.organizationId !== input.organizationId) {
          await client.query("ROLLBACK");
          return { outcome: "wrong_organization" };
        }

        if (!trackBinding && new Date(row.expiresAt) <= input.now) {
          await client.query(
            `UPDATE marketplace.invite_codes
             SET status = 'expired'
             WHERE id = $1::uuid
               AND status = 'pending'`,
            [row.id],
          );
          await client.query("COMMIT");
          return { outcome: "not_available" };
        }

        const applied = await input.applyTracks(invite, trackBinding ? "recover" : "apply");
        if (applied !== "applied") {
          await client.query("ROLLBACK");
          return { outcome: applied };
        }
        if (!trackBinding) {
          const persistedBinding = await findSuccessfulTrackBinding(client, invite.id);
          if (!persistedBinding || persistedBinding.organizationId !== input.organizationId) {
            throw new Error("Canonical invite track binding was not persisted");
          }
        }
        const redeemed = await client.query(
          `UPDATE marketplace.invite_codes
           SET status = 'redeemed',
               redeemed_by_user_id = $2::uuid,
               redeemed_at = $3::timestamptz,
               payload = jsonb_set(
                 payload,
                 '{redemption}',
                 jsonb_build_object('organizationId', $4::text),
                 true
               )
           WHERE id = $1::uuid
             AND status = 'pending'`,
          [row.id, input.actorUserId, input.now.toISOString(), input.organizationId],
        );
        if (redeemed.rowCount !== 1) {
          throw new Error("Hotel account invitation changed while it was locked");
        }
        await client.query("COMMIT");
        return { outcome: "redeemed", invite };
      } catch (error) {
        await rollbackQuietly(client);
        throw error;
      } finally {
        client.release();
      }
    },

    async close() {
      await pool.end();
    },
  };
}

async function applyInviteTracks(
  invite: HotelAccountInvite,
  context: RequestContext,
  options: HotelAccountInviteRoutesOptions,
  mode: "apply" | "recover",
): Promise<ApplyInviteResult> {
  let current;
  try {
    current = await options.trackCommandRepository.getTrackStatus({
      organizationId: context.selectedOrganization.organizationId,
    });
  } catch {
    return "temporarily_unavailable";
  }

  if (mode === "recover") {
    return sameTracks(current.selectedTracks, invite.selectedTracks) ? "applied" : "track_conflict";
  }
  if (current.selectedTracks.some((track) => !invite.selectedTracks.includes(track))) {
    return "track_conflict";
  }

  let result: HotelSetupTrackCommandResult;
  try {
    result = await options.trackCommandRepository.updateTracks({
      organizationId: context.selectedOrganization.organizationId,
      actorUserId: context.actor.internalUserId,
      selectedTracks: invite.selectedTracks,
      expectedRevision: current.trackRevision,
      idempotencyKey: inviteTrackIdempotencyKey(invite.id, current.trackRevision),
      audit: {
        ...context.audit,
        correlationId: hotelAccountInviteTrackCorrelationId(invite.id),
      },
    });
  } catch {
    return "temporarily_unavailable";
  }
  if (result.ok) return "applied";
  return result.error.code === "track_revision_conflict" ||
    result.error.code === "command_in_progress"
    ? "temporarily_unavailable"
    : "track_conflict";
}

function authorizedHotelContext(
  request: FastifyRequest,
  reply: FastifyReply,
): RequestContext | null {
  let context: RequestContext;
  try {
    context = enforceRoutePolicy(request, { permission: "hotel_catalog.products.manage" });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      reply.status(401).send({
        code: "unauthenticated",
        detail: "Sign in before accepting a hotel account invitation.",
      });
      return null;
    }
    if (error instanceof AuthorizationError) {
      reply.status(403).send({
        code: "missing_permission",
        detail: "Hotel product management permission is required to accept this invitation.",
      });
      return null;
    }
    throw error;
  }
  if (
    context.actor.status !== "active" ||
    context.selectedOrganization.kind !== "hotel_group" ||
    context.selectedOrganization.status !== "active" ||
    context.membership.status !== "active"
  ) {
    reply.status(403).send({
      code: "invalid_organization_scope",
      detail: "Choose an active hotel account before accepting this invitation.",
    });
    return null;
  }
  return context;
}

function parseInviteCode(body: InviteCodeBody): string | null {
  if (!body || Object.keys(body).length !== 1 || typeof body.code !== "string") return null;
  const code = body.code.trim();
  if (code.length > INVITE_CODE_MAX_LENGTH || !INVITE_CODE_PATTERN.test(code)) return null;
  return code;
}

function parsePayload(value: unknown): HotelAccountInvitePayload | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  const hasRedemption = Object.prototype.hasOwnProperty.call(value, INVITE_REDEMPTION_PAYLOAD_KEY);
  if (
    keys.length !== INVITE_PAYLOAD_KEYS.length + (hasRedemption ? 1 : 0) ||
    !keys.every(
      (key) =>
        INVITE_PAYLOAD_KEYS.includes(key as (typeof INVITE_PAYLOAD_KEYS)[number]) ||
        key === INVITE_REDEMPTION_PAYLOAD_KEY,
    )
  ) {
    return null;
  }
  if (hasRedemption) {
    const redemption = value.redemption;
    if (
      !isRecord(redemption) ||
      !hasOnlyKeys(redemption, ["organizationId"]) ||
      typeof redemption.organizationId !== "string"
    ) {
      return null;
    }
  }
  if (
    value.contractVersion !== HOTEL_ACCOUNT_INVITE_CONTRACT_VERSION ||
    value.handoffPath !== HOTEL_ACCOUNT_INVITE_HANDOFF_PATH
  ) {
    return null;
  }
  const parsed = parseHotelAccountInviteCreateRequest({
    identity: value.identity,
    organization: value.organization,
    property: value.property,
    selectedTracks: value.selectedTracks,
  });
  if (typeof parsed === "string") return null;
  return {
    contractVersion: HOTEL_ACCOUNT_INVITE_CONTRACT_VERSION,
    ...parsed,
    handoffPath: HOTEL_ACCOUNT_INVITE_HANDOFF_PATH,
  };
}

function toInvite(row: InviteRow | undefined): HotelAccountInvite | null {
  if (!row) return null;
  const payload = parsePayload(row.payload);
  if (!payload) return null;
  return {
    id: row.id,
    ...payload,
    expiresAt: new Date(row.expiresAt).toISOString(),
    redemptionOrganizationId: row.redemptionOrganizationId,
  };
}

function inviteTrackIdempotencyKey(inviteId: string, expectedRevision: number): string {
  return `${hotelAccountInviteTrackCorrelationId(inviteId)}:r${expectedRevision}`;
}

function onboardingResolution(invite: HotelAccountInvite): HotelAccountInviteOnboardingResolution {
  return {
    inviteId: invite.id,
    organizationName: invite.organization.displayName,
    organizationExternalId: hotelAccountInviteOrganizationExternalId(invite.id),
  };
}

async function hasInviteOrganizationBinding(
  client: PoolClient,
  organizationId: string,
  inviteId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
     FROM identity.organizations
     WHERE id = $1::uuid
       AND kind = 'hotel_group'
       AND status = 'active'
       AND workos_external_id = $2
     LIMIT 1`,
    [organizationId, hotelAccountInviteOrganizationExternalId(inviteId)],
  );
  return result.rowCount === 1;
}

async function findSuccessfulTrackBinding(
  client: PoolClient,
  inviteId: string,
): Promise<InviteTrackBindingRow | null> {
  const result = await client.query<InviteTrackBindingRow>(
    `SELECT redemption.organization_id::text AS "organizationId"
     FROM platform.idempotency_keys redemption
     JOIN identity.organizations organization
       ON organization.id = redemption.organization_id
     WHERE redemption.operation_scope = 'hotel_catalog'
       AND redemption.operation = $1
       AND redemption.correlation_id = $2
       AND redemption.tenant_scope = 'organization'
       AND redemption.status = 'completed'
       AND redemption.response_status_code = 200
       AND organization.workos_external_id = $3
     ORDER BY redemption.completed_at, redemption.id
     LIMIT 2`,
    [
      INVITE_TRACK_OPERATION,
      hotelAccountInviteTrackCorrelationId(inviteId),
      hotelAccountInviteOrganizationExternalId(inviteId),
    ],
  );
  if (result.rows.length > 1) {
    throw new Error("Hotel account invite has multiple canonical organization bindings");
  }
  return result.rows[0] ?? null;
}

function sameTracks(actual: readonly SetupTrack[], expected: readonly SetupTrack[]): boolean {
  return actual.length === expected.length && expected.every((track) => actual.includes(track));
}

function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@", 2);
  const visible = local.slice(0, 1);
  return `${visible}${"*".repeat(Math.max(3, Math.min(local.length - 1, 8)))}@${domain}`;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function inviteNotAvailable(reply: FastifyReply) {
  return reply.status(404).send({
    code: "invite_not_available",
    detail: "This hotel account invitation is invalid or no longer available.",
  });
}

function temporarilyUnavailable(reply: FastifyReply) {
  return reply.status(503).send({
    code: "invite_redemption_unavailable",
    detail: "The hotel account invitation could not be accepted. Try again.",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowedKeys.length && keys.every((key) => allowedKeys.includes(key));
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}

const INVITE_SELECT = `SELECT
  invite.id::text AS id,
  invite.status,
  invite.payload,
  invite.redeemed_by_user_id::text AS "redeemedByUserId",
  invite.payload -> 'redemption' ->> 'organizationId' AS "redemptionOrganizationId",
  invite.expires_at AS "expiresAt"
FROM marketplace.invite_codes invite`;
