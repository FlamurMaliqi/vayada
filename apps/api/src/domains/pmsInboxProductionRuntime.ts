import pg, { type QueryResult, type QueryResultRow } from "pg";

import type {
  PmsInboxAssistancePort,
  PmsInboxEmailReplyRouteReadPort,
  PmsInboxMarkReadPort,
  PmsInboxProviderActionPort,
  PmsInboxQuickReplyPort,
  PmsInboxReadPort,
  PmsInboxReplyPort,
  PmsInboxStaffCommandPort,
  PmsInboxStartDirectEmailPort,
  PmsInboxTriagePort,
} from "./pmsInbox.js";
import {
  createPgPmsInboxAssistancePort,
  type PmsInboxAssistanceServicePort,
} from "./pmsInboxAssistance.js";
import { createPgPmsInboxMarkReadPort } from "./pmsInboxMarkReadCommand.js";
import { createPgPmsInboxProviderActionPort } from "./pmsInboxProviderActionCommand.js";
import { createPgPmsInboxQuickReplyPort } from "./pmsInboxQuickReply.js";
import { createPgPmsInboxReadPort } from "./pmsInboxReadModel.js";
import { createPgPmsInboxReplyPort } from "./pmsInboxReplyCommand.js";
import { createPgPmsInboxStaffCommandPort } from "./pmsInboxStaffCommand.js";
import { createPgPmsInboxStartDirectEmailPort } from "./pmsInboxStartDirectEmailCommand.js";
import { createPgPmsInboxTriagePort } from "./pmsInboxTriageCommand.js";

type PmsInboxRuntimeClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type PmsInboxRuntimePool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  connect(): Promise<PmsInboxRuntimeClient>;
  end(): Promise<void>;
};

export type PmsInboxProductionRoutes = Readonly<{
  pmsInboxAssistancePort?: PmsInboxAssistancePort;
  pmsInboxReadPort: PmsInboxReadPort;
  pmsInboxMarkReadPort: PmsInboxMarkReadPort;
  pmsInboxProviderActionPort: PmsInboxProviderActionPort;
  pmsInboxQuickReplyPort: PmsInboxQuickReplyPort;
  pmsInboxReplyPort: PmsInboxReplyPort;
  pmsInboxStartDirectEmailPort: PmsInboxStartDirectEmailPort;
  pmsInboxTriagePort: PmsInboxTriagePort;
  pmsInboxStaffCommandPort: PmsInboxStaffCommandPort;
}>;

export type PmsInboxProductionRuntime = Readonly<{
  routes: PmsInboxProductionRoutes;
  emailReplyRoutes: PmsInboxEmailReplyRouteReadPort;
  close(): Promise<void>;
}>;

export type PmsInboxRuntimeFactories = Readonly<{
  createPool(input: { connectionString: string; max: number }): PmsInboxRuntimePool;
}>;

const productionFactories: PmsInboxRuntimeFactories = {
  createPool: (input) => new pg.Pool(input),
};

export function createPmsInboxProductionRuntime(
  input: {
    connectionString: string;
    attachmentMediaAccessEnabled: boolean;
    emailReplyRoutes?: PmsInboxEmailReplyRouteReadPort;
    assistanceService?: PmsInboxAssistanceServicePort;
    pool?: PmsInboxRuntimePool;
    max?: number;
  },
  factories: PmsInboxRuntimeFactories = productionFactories,
): PmsInboxProductionRuntime {
  if (!input.pool && !input.connectionString.trim())
    throw new Error("PMS Inbox production connectionString must not be empty");
  const ownsPool = !input.pool;
  const pool =
    input.pool ??
    factories.createPool({ connectionString: input.connectionString, max: input.max ?? 10 });
  const emailReplyRoutes =
    input.emailReplyRoutes ?? createUnavailablePmsInboxEmailReplyRouteReadPort();
  const assistance = input.assistanceService
    ? createPgPmsInboxAssistancePort({
        connectionString: input.connectionString,
        pool,
        service: input.assistanceService,
      })
    : undefined;
  let closed = false;
  let closing: Promise<void> | undefined;

  const routes: PmsInboxProductionRoutes = Object.freeze({
    ...(assistance ? { pmsInboxAssistancePort: assistance } : {}),
    pmsInboxReadPort: createPgPmsInboxReadPort({
      connectionString: input.connectionString,
      pool,
      emailReplyRoutes,
      attachmentMediaAccessEnabled: input.attachmentMediaAccessEnabled,
    }),
    pmsInboxMarkReadPort: createPgPmsInboxMarkReadPort({
      connectionString: input.connectionString,
      pool,
    }),
    pmsInboxProviderActionPort: createPgPmsInboxProviderActionPort({
      connectionString: input.connectionString,
      pool,
    }),
    pmsInboxQuickReplyPort: createPgPmsInboxQuickReplyPort({
      connectionString: input.connectionString,
      pool,
    }),
    pmsInboxReplyPort: createPgPmsInboxReplyPort({
      connectionString: input.connectionString,
      pool,
      emailReplyRoutes,
    }),
    pmsInboxStartDirectEmailPort: createPgPmsInboxStartDirectEmailPort({
      connectionString: input.connectionString,
      pool,
      emailReplyRoutes,
    }),
    pmsInboxTriagePort: createPgPmsInboxTriagePort({
      connectionString: input.connectionString,
      pool,
    }),
    pmsInboxStaffCommandPort: createPgPmsInboxStaffCommandPort({
      connectionString: input.connectionString,
      pool,
    }),
  });

  return Object.freeze({
    routes,
    emailReplyRoutes,
    async close() {
      if (closed) return;
      closing ??= (async () => {
        const results = await Promise.allSettled([
          Promise.resolve().then(() => assistance?.close?.()),
          ...(ownsPool ? [Promise.resolve().then(() => pool.end())] : []),
        ]);
        closed = true;
        const failure = results.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failure) throw failure.reason;
      })();
      try {
        await closing;
      } finally {
        closing = undefined;
      }
    },
  });
}

export function createUnavailablePmsInboxEmailReplyRouteReadPort(): PmsInboxEmailReplyRouteReadPort {
  return Object.freeze({
    async resolveReplyRoutes({ propertyId, threads }) {
      return threads.map(({ threadId, guestEmail }) => ({
        propertyId,
        threadId,
        route: guestEmail
          ? {
              state: "held" as const,
              channel: null,
              providerChannel: null,
              reasonCode: "approved_sender_unavailable" as const,
            }
          : {
              state: "held" as const,
              channel: null,
              providerChannel: null,
              reasonCode: "guest_email_unavailable" as const,
            },
      }));
    },
  });
}
