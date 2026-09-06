import type { FastifyInstance } from "fastify";

export function registerShutdownSignals(
  app: FastifyInstance,
  signals: NodeJS.EventEmitter = process,
) {
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= app.close().catch((error: unknown) => {
      app.log.error({ err: error }, "API shutdown failed");
      process.exitCode = 1;
    });
  };
  signals.once("SIGTERM", close);
  signals.once("SIGINT", close);
  app.addHook("onClose", async () => {
    signals.removeListener("SIGTERM", close);
    signals.removeListener("SIGINT", close);
  });
}
