import { requireAuthContext } from "@vayada/backend-auth";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { bankTransferDetailsSchema } from "../domains/financeBankTransferCodec.js";
import type {
  createBankTransferRepository,
  BankTransferDestinationSummary,
} from "../domains/financeBankTransferRepository.js";
import { enforceFinancePropertyReadPolicy, enforceFinancePropertyWritePolicy } from "./finance.js";

const bodySchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("replace"),
    commandId: z.uuid(),
    expectedVersion: z.int().nonnegative(),
    details: bankTransferDetailsSchema,
  }),
  z.strictObject({
    action: z.enum(["disable", "delete"]),
    commandId: z.uuid(),
    expectedVersion: z.int().positive(),
  }),
]);
const path = "/finance/properties/:propertyId/bank-transfer-destination";
type Repository = Pick<ReturnType<typeof createBankTransferRepository>, "read" | "execute">;

export async function registerFinanceBankTransferRoutes(
  app: FastifyInstance,
  options: { repository: Repository },
) {
  for (const method of ["GET", "PUT"] as const) {
    app.route<{ Params: { propertyId: string }; Body: unknown }>({
      method,
      url: path,
      bodyLimit: 8192,
      onRequest: async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const enforce =
          method === "GET" ? enforceFinancePropertyReadPolicy : enforceFinancePropertyWritePolicy;
        if (!enforce(request, reply, request.params.propertyId)) return reply;
      },
      async handler(request, reply) {
        const propertyId = request.params.propertyId;
        if (!z.uuid().safeParse(propertyId).success)
          return reply.code(400).send({ code: "invalid_request" });
        try {
          if (method === "GET")
            return { destination: masked(await options.repository.read(propertyId), propertyId) };
          const parsed = bodySchema.safeParse(request.body);
          if (!parsed.success) return reply.code(400).send({ code: "invalid_request" });
          const result = await options.repository.execute({
            ...parsed.data,
            propertyId,
            actorId: requireAuthContext(request).actor.internalUserId,
          });
          if (result.status === "conflict")
            return reply.code(409).send({ code: "destination_conflict" });
          return { destination: masked(result.summary, propertyId) };
        } catch {
          return reply.code(503).send({ code: "bank_transfer_destination_unavailable" });
        }
      },
    });
  }
}

function masked(value: BankTransferDestinationSummary | null, propertyId: string) {
  if (!value) return null;
  if (value.propertyId !== propertyId || !/^[A-Za-z0-9]{4}$/.test(value.accountLast4))
    throw new Error();
  return {
    id: value.id,
    revision: value.revision,
    version: value.version,
    enabled: value.enabled,
    deleted: value.deleted,
    maskedAccount: value.deleted ? null : `•••• ${value.accountLast4}`,
  };
}
