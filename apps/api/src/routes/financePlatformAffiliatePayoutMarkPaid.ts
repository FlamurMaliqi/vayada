import {
  FinanceAffiliatePayoutMarkPaidError,
  normalizeFinanceAffiliatePayoutMarkPaid,
  type FinanceAffiliatePayoutMarkPaidCommand,
  type FinanceAffiliatePayoutMarkPaidResult,
  type FinanceAffiliatePayoutPaymentEvidence,
  type FinancePlatformAffiliatePayoutRepository,
  type NormalizedFinanceAffiliatePayoutMarkPaid,
} from "@vayada/domain-finance";
import { createHash } from "node:crypto";

import {
  applyAffiliatePayoutPaidState,
  cancelPendingAffiliatePayoutJobs,
  completeAffiliatePayoutIdempotency,
  insertAffiliatePayoutEvidence,
  loadAffiliatePayoutEvidence,
  lockAffiliatePayouts,
  recordAffiliatePayoutPaidAudit,
  reserveAffiliatePayoutIdempotency,
  resolveAffiliateOrganization,
  type AffiliatePayoutWriteClient,
} from "./financePlatformAffiliatePayoutMarkPaidStore.js";

export type FinancePlatformAffiliatePayoutWritePool = {
  connect?(): Promise<AffiliatePayoutWriteClient>;
};

export function createFinancePlatformAffiliatePayoutMarkPaidRepository(
  pool: FinancePlatformAffiliatePayoutWritePool,
): Pick<FinancePlatformAffiliatePayoutRepository, "markAffiliatePayoutPaid"> {
  return {
    async markAffiliatePayoutPaid(rawCommand) {
      let command: NormalizedFinanceAffiliatePayoutMarkPaid;
      try {
        command = normalizeFinanceAffiliatePayoutMarkPaid(rawCommand);
      } catch (error) {
        if (error instanceof FinanceAffiliatePayoutMarkPaidError) return invalidCommand();
        throw error;
      }
      if (Date.parse(command.payload.paidAt) > Date.parse(command.audit.requestedAt)) {
        return invalidCommand();
      }
      if (!pool.connect) {
        return failure(500, "write_unavailable", "Target Finance transactions are unavailable.");
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await markPaidInTransaction(client, command);
        await client.query(result.ok ? "COMMIT" : "ROLLBACK");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

async function markPaidInTransaction(
  client: AffiliatePayoutWriteClient,
  command: NormalizedFinanceAffiliatePayoutMarkPaid,
): Promise<FinanceAffiliatePayoutMarkPaidResult> {
  const keyHash = sha256(command.idempotencyKey);
  const fingerprint = sha256(
    JSON.stringify({
      commandType: command.commandType,
      commandId: command.commandId,
      affiliateId: command.affiliateId,
      currency: command.currency,
      actorOrganizationId: command.audit.actor.organizationId,
      payload: command.payload,
    }),
  );
  const idempotency = await reserveAffiliatePayoutIdempotency(
    client,
    command,
    keyHash,
    fingerprint,
  );
  if (idempotency.requestFingerprintHash !== fingerprint) {
    return failure(409, "idempotency_conflict", "Idempotency key has different evidence.");
  }
  if (idempotency.status === "completed") {
    const evidence = await loadAffiliatePayoutEvidence(client, idempotency.id);
    if (!evidence) throw new Error("Completed affiliate payout command has no evidence.");
    return success(command, evidence, "idempotent_replay");
  }

  const organizationId = await resolveAffiliateOrganization(
    client,
    command.affiliateId,
    command.currency,
    command.payload.payoutIds,
  );
  if (!organizationId) return staleSnapshot();

  const payouts = await lockAffiliatePayouts(
    client,
    command.affiliateId,
    organizationId,
    command.currency,
    command.payload.payoutIds,
  );
  const eligible = payouts.filter(
    (payout) =>
      ["pending", "scheduled"].includes(payout.payoutStatus) &&
      payout.providerPayoutId === null &&
      ["manual", "bank_transfer"].includes(payout.payoutMethod) &&
      Number(payout.amount) > 0,
  );
  if (payouts.length !== command.payload.payoutIds.length) return staleSnapshot();
  if (eligible.length === 0) {
    return failure(
      409,
      "invalid_status_transition",
      "The reviewed payout rows are no longer eligible to mark paid.",
    );
  }
  if (
    eligible.length !== payouts.length ||
    cents(eligible.map((payout) => payout.amount)) !== cents([command.payload.expectedAmount])
  )
    return staleSnapshot();
  const payoutIds = eligible.map((payout) => payout.payoutId);
  const evidence = await insertAffiliatePayoutEvidence(
    client,
    command,
    organizationId,
    idempotency.id,
    fingerprint,
    payoutIds,
  );
  if (!evidence) {
    return failure(409, "duplicate_reference", "External payout reference is already recorded.");
  }

  await applyAffiliatePayoutPaidState(
    client,
    command,
    organizationId,
    evidence.evidenceId,
    payoutIds,
  );
  await cancelPendingAffiliatePayoutJobs(client, command, payoutIds);
  await recordAffiliatePayoutPaidAudit(
    client,
    command,
    organizationId,
    idempotency.id,
    evidence.evidenceId,
    evidence.amount,
    payoutIds,
  );
  await completeAffiliatePayoutIdempotency(
    client,
    command,
    idempotency.id,
    evidence.evidenceId,
    sha256(JSON.stringify({ evidenceId: evidence.evidenceId, payoutIds })),
  );

  const result = await loadAffiliatePayoutEvidence(client, idempotency.id);
  if (!result) throw new Error("Affiliate payout evidence insert was not readable.");
  return success(command, result, "updated");
}

function success(
  command: FinanceAffiliatePayoutMarkPaidCommand,
  evidence: FinanceAffiliatePayoutPaymentEvidence,
  status: "updated" | "idempotent_replay",
): FinanceAffiliatePayoutMarkPaidResult {
  return {
    ok: true,
    status,
    evidence,
    commandMeta: {
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      sideEffects: ["audit_event"],
      outboxEvents: [],
      jobs: [],
    },
  };
}

function invalidCommand(): FinanceAffiliatePayoutMarkPaidResult {
  return failure(400, "invalid_command", "Affiliate payout payment evidence is invalid.");
}

function staleSnapshot(): FinanceAffiliatePayoutMarkPaidResult {
  return failure(
    409,
    "stale_payout_snapshot",
    "Affiliate payout eligibility changed. Reload the detail before recording payment.",
  );
}

function cents(amounts: string[]): bigint {
  return amounts.reduce((total, amount) => {
    const [whole, fraction = ""] = amount.split(".");
    if (!whole || !/^\d+$/.test(whole) || !/^\d{0,2}$/.test(fraction)) {
      throw new Error("Finance payout amount is not a two-decimal value.");
    }
    return total + BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  }, 0n);
}

function failure(
  statusCode: 400 | 404 | 409 | 500,
  code: Extract<FinanceAffiliatePayoutMarkPaidResult, { ok: false }>["code"],
  message: string,
): FinanceAffiliatePayoutMarkPaidResult {
  return { ok: false, statusCode, code, message };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
