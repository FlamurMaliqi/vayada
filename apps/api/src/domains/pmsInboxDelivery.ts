export const PMS_INBOX_DELIVERY_QUEUE = "pms.guest-message.delivery";
export const PMS_INBOX_DELIVERY_JOB_TYPE = "pms.guest-message.deliver";
export const PMS_INBOX_DELIVERY_MAX_ATTEMPTS = 5;

export type PmsInboxDeliveryFailure =
  | "transient_provider_failure"
  | "ambiguous_provider_outcome"
  | "access_unavailable"
  | "provider_configuration_unavailable"
  | "resource_deleted"
  | "invalid_delivery_payload"
  | "provider_rejected";

export type PmsInboxDeliveryProjection =
  | {
      attemptOutcome: "transient_failure";
      state: "retrying";
      reasonCode: "transient_provider_failure";
      retry: true;
      deadLetter: false;
    }
  | {
      attemptOutcome: "terminal_failure";
      state: "held" | "failed";
      reasonCode:
        | "ambiguous_provider_outcome"
        | "access_unavailable"
        | "provider_configuration_unavailable"
        | "invalid_delivery_payload"
        | "provider_rejected"
        | "retry_exhausted";
      retry: false;
      deadLetter: boolean;
    }
  | {
      attemptOutcome: "terminal_failure";
      state: null;
      reasonCode: "resource_deleted";
      retry: false;
      deadLetter: true;
    };

export function pmsInboxDeliveryJobKey(messageId: string): string {
  return `${PMS_INBOX_DELIVERY_JOB_TYPE}:message:${messageId}:manual-send:v1`;
}

export function pmsInboxProviderIdempotencyReference(messageId: string): string {
  return `message:${messageId}`;
}

export function projectPmsInboxDeliveryFailure(
  failure: PmsInboxDeliveryFailure,
  attemptNumber: number,
  maxAttempts = PMS_INBOX_DELIVERY_MAX_ATTEMPTS,
): PmsInboxDeliveryProjection {
  if (failure === "transient_provider_failure") {
    if (attemptNumber < maxAttempts)
      return {
        attemptOutcome: "transient_failure",
        state: "retrying",
        reasonCode: failure,
        retry: true,
        deadLetter: false,
      };
    return terminal("failed", "retry_exhausted", true);
  }
  if (failure === "resource_deleted")
    return {
      attemptOutcome: "terminal_failure",
      state: null,
      reasonCode: failure,
      retry: false,
      deadLetter: true,
    };
  if (failure === "ambiguous_provider_outcome") return terminal("held", failure, false);
  if (failure === "access_unavailable") return terminal("held", failure, false);
  if (failure === "provider_configuration_unavailable") return terminal("held", failure, false);
  return terminal("failed", failure, false);
}

export function nextPmsInboxDeliveryRunAt(
  now: Date,
  attemptNumber: number,
  random: () => number = Math.random,
): Date {
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1)
    throw new Error("PMS Inbox delivery attempt number must be positive");
  const exponentialMs = Math.min(30_000 * 2 ** (attemptNumber - 1), 15 * 60_000);
  const jitter = Math.max(0, Math.min(1, random()));
  return new Date(now.getTime() + Math.round(exponentialMs * (0.8 + jitter * 0.4)));
}

function terminal(
  state: "held" | "failed",
  reasonCode: Exclude<
    PmsInboxDeliveryProjection["reasonCode"],
    "transient_provider_failure" | "resource_deleted"
  >,
  deadLetter: boolean,
): PmsInboxDeliveryProjection {
  return {
    attemptOutcome: "terminal_failure",
    state,
    reasonCode,
    retry: false,
    deadLetter,
  };
}
