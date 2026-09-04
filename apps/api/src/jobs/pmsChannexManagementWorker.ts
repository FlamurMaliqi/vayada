import type {
  ChannexConnectedChannel,
  ChannexManagementOperationType,
  ChannexRatePlanMapping,
  ChannexRoomTypeMapping,
} from "@vayada/domain-pms-channex";

import type { PmsChannexManagementCommandInput } from "../domains/pmsChannexManagementCommands.js";

export type ChannexManagementJob = {
  jobId: string;
  propertyId: string;
  correlationId: string | null;
  attemptNumber: number;
  maxAttempts: number;
  input: PmsChannexManagementCommandInput;
};

export type ChannexManagementProviderSuccess = {
  ok: true;
  providerRequestId?: string;
  externalPropertyId?: string;
  connectionStatus?: "connected" | "disconnected";
  messagingAppInstalled?: boolean;
  channels?: ChannexConnectedChannel[];
  roomTypeMappings?: ChannexRoomTypeMapping[];
  ratePlanMappings?: ChannexRatePlanMapping[];
};

export type ChannexManagementProviderFailure = {
  ok: false;
  code:
    | "rate_limited"
    | "timeout"
    | "provider_unavailable"
    | "provider_rejected"
    | "mapping_missing"
    | "invalid_state"
    | "invalid_payload";
  message: string;
  statusCode?: number;
  providerRequestId?: string;
};

export type ChannexManagementProvider = {
  execute(
    job: ChannexManagementJob,
    input?: { onProgress?: () => Promise<void> },
  ): Promise<ChannexManagementProviderSuccess | ChannexManagementProviderFailure>;
};

export type ChannexManagementWorkerStore = {
  claim(input: { workerId: string; now: Date }): Promise<ChannexManagementJob | null>;
  heartbeat(job: ChannexManagementJob, input: { workerId: string }): Promise<void>;
  succeed(
    job: ChannexManagementJob,
    result: ChannexManagementProviderSuccess,
    input: { workerId: string; now: Date },
  ): Promise<void>;
  fail(
    job: ChannexManagementJob,
    failure: ChannexManagementProviderFailure,
    input: { workerId: string; now: Date; retryable: boolean; retryAt: Date | null },
  ): Promise<"retry_scheduled" | "dead_lettered">;
  close?(): Promise<void>;
};

export type ChannexManagementWorkerResult =
  | { outcome: "idle" }
  | { outcome: "succeeded"; jobId: string; operationType: ChannexManagementOperationType }
  | {
      outcome: "retry_scheduled" | "dead_lettered";
      jobId: string;
      operationType: ChannexManagementOperationType;
      errorCode: string;
    };

export async function runPmsChannexManagementWorkerOnce(input: {
  store: ChannexManagementWorkerStore;
  provider: ChannexManagementProvider;
  workerId: string;
  now?: Date;
}): Promise<ChannexManagementWorkerResult> {
  const clock = input.now ? () => input.now! : () => new Date();
  const now = clock();
  const job = await input.store.claim({ workerId: input.workerId, now });
  if (!job) return { outcome: "idle" };

  let result: ChannexManagementProviderSuccess | ChannexManagementProviderFailure;
  try {
    result = await input.provider.execute(job, {
      onProgress: () => input.store.heartbeat(job, { workerId: input.workerId }),
    });
  } catch (error) {
    result = {
      ok: false,
      code: "provider_unavailable",
      message: safeMessage(error),
    };
  }
  if (result.ok) {
    await input.store.succeed(job, result, { workerId: input.workerId, now: clock() });
    return { outcome: "succeeded", jobId: job.jobId, operationType: job.input.operationType };
  }

  const retryable = channexManagementFailureIsRetryable(result);
  const completedAt = clock();
  const retryAt =
    retryable && job.attemptNumber < job.maxAttempts
      ? new Date(completedAt.getTime() + retryDelayMs(job.attemptNumber))
      : null;
  const outcome = await input.store.fail(job, result, {
    workerId: input.workerId,
    now: completedAt,
    retryable,
    retryAt,
  });
  return {
    outcome,
    jobId: job.jobId,
    operationType: job.input.operationType,
    errorCode: result.code,
  };
}

export function channexManagementFailureIsRetryable(
  failure: ChannexManagementProviderFailure,
): boolean {
  return (
    failure.code === "timeout" ||
    failure.code === "rate_limited" ||
    failure.code === "provider_unavailable" ||
    (failure.statusCode !== undefined && failure.statusCode >= 500)
  );
}

function retryDelayMs(attemptNumber: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, attemptNumber - 1));
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Channex provider request failed";
  return message.slice(0, 500);
}
