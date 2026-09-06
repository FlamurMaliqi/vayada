import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { registerShutdownSignals } from "./shutdown.js";

it("routes termination through preClose draining before resource closure", async () => {
  expect(
    readFileSync(new URL("../../../../scripts/start-next-api.sh", import.meta.url), "utf8"),
  ).toContain("\ncd apps/api\nexec node dist/server.js\n");
  const app = Fastify();
  const signals = new EventEmitter();
  let finishDrain!: () => void;
  const draining = new Promise<void>((resolve) => {
    finishDrain = resolve;
  });
  const drain = vi.fn(() => draining);
  const closeResources = vi.fn(async () => undefined);
  app.addHook("preClose", drain);
  app.addHook("onClose", closeResources);
  registerShutdownSignals(app, signals);
  await app.ready();
  try {
    signals.emit("SIGTERM");
    await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce());
    signals.emit("SIGINT");
    expect(closeResources).not.toHaveBeenCalled();
    finishDrain();
    await app.close();
    expect(drain).toHaveBeenCalledOnce();
    expect(closeResources).toHaveBeenCalledOnce();
    expect(signals.listenerCount("SIGTERM") + signals.listenerCount("SIGINT")).toBe(0);
  } finally {
    finishDrain();
    await app.close();
  }
});
