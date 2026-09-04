import { randomUUID } from "node:crypto";

import {
  nextPmsInboxDeliveryRunAt,
  projectPmsInboxDeliveryFailure,
  type PmsInboxDeliveryCompletion,
  type PmsInboxDeliveryProvider,
  type PmsInboxDeliveryProviderResult,
  type PmsInboxDeliveryStore,
} from "../domains/pmsInboxDelivery.js";

export type PmsInboxDeliveryProviders = Readonly<{
  channex?: PmsInboxDeliveryProvider;
  resend?: PmsInboxDeliveryProvider;
}>;

export async function runPmsInboxDeliveryJobs(
  store: PmsInboxDeliveryStore,
  providers: PmsInboxDeliveryProviders,
  options: {
    workerId?: string;
    limit?: number;
    now?: () => Date;
    random?: () => number;
  } = {},
): Promise<{
  processed: number;
  sent: number;
  retrying: number;
  held: number;
  failed: number;
  deadLettered: number;
}> {
  const totals = { processed: 0, sent: 0, retrying: 0, held: 0, failed: 0, deadLettered: 0 };
  const workerId = `${options.workerId ?? "pms-inbox-delivery"}:${randomUUID()}`;
  for (let index = 0; index < (options.limit ?? 25); index += 1) {
    const job = await store.claim(workerId);
    if (!job) break;
    const prepared = await store.prepare(job, {
      channex: Boolean(providers.channex),
      resend: Boolean(providers.resend),
    });
    let completion: PmsInboxDeliveryCompletion;
    if (prepared.state === "blocked") {
      completion = failedCompletion(job, prepared.failure, prepared.attemptId ?? null, options);
    } else if (prepared.state === "accepted") {
      completion = {
        outcome: "accepted",
        attemptId: prepared.attemptId,
        providerReference: prepared.providerReference,
      };
    } else {
      const provider = providers[prepared.adapter];
      if (!provider) {
        completion = failedCompletion(
          job,
          "provider_configuration_unavailable",
          prepared.attemptId,
          options,
        );
      } else {
        const result = await provider.send(prepared.input).catch(
          (): PmsInboxDeliveryProviderResult => ({
            ok: false,
            failure: "ambiguous_provider_outcome",
          }),
        );
        if (result.ok) {
          completion = {
            outcome: "accepted",
            attemptId: prepared.attemptId,
            providerReference: result.providerReference,
          };
        } else {
          const reconciled =
            result.failure === "ambiguous_provider_outcome" && provider.reconcile
              ? await provider
                  .reconcile(prepared.input)
                  .catch(() => ({ state: "unknown" }) as const)
              : null;
          completion =
            reconciled?.state === "accepted"
              ? {
                  outcome: "accepted",
                  attemptId: prepared.attemptId,
                  providerReference: reconciled.providerReference,
                }
              : failedCompletion(
                  job,
                  reconciled?.state === "not_accepted"
                    ? "transient_provider_failure"
                    : result.failure,
                  prepared.attemptId,
                  options,
                  result.providerRequestId,
                  result.acceptedProviderReferences,
                );
        }
      }
    }
    if (!(await store.complete(job, completion))) continue;
    totals.processed += 1;
    if (completion.outcome === "accepted") totals.sent += 1;
    else if (completion.projection.state === "retrying") totals.retrying += 1;
    else if (completion.projection.state === "held") totals.held += 1;
    else if (completion.projection.state === "failed") totals.failed += 1;
    if (completion.outcome === "failed" && completion.projection.deadLetter)
      totals.deadLettered += 1;
  }
  return totals;
}

function failedCompletion(
  job: Parameters<PmsInboxDeliveryStore["complete"]>[0],
  failure: Parameters<typeof projectPmsInboxDeliveryFailure>[0],
  attemptId: string | null,
  options: { now?: () => Date; random?: () => number },
  providerRequestId?: string,
  acceptedProviderReferences?: readonly string[],
): PmsInboxDeliveryCompletion {
  const projection = projectPmsInboxDeliveryFailure(failure, job.attemptNumber, job.maxAttempts);
  return {
    outcome: "failed",
    attemptId,
    failure: projection.reasonCode === "retry_exhausted" ? "retry_exhausted" : failure,
    projection,
    ...(providerRequestId ? { providerRequestId } : {}),
    ...(acceptedProviderReferences?.length ? { acceptedProviderReferences } : {}),
    ...(projection.retry
      ? {
          retryAt: nextPmsInboxDeliveryRunAt(
            (options.now ?? (() => new Date()))(),
            job.attemptNumber,
            options.random,
          ),
        }
      : {}),
  };
}
