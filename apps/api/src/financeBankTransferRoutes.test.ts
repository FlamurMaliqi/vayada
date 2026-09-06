import type { RequestContext } from "@vayada/backend-auth";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { registerFinanceBankTransferRoutes } from "./routes/financeBankTransfer.js";
import { loadConfig } from "./config.js";

const propertyId = "14660000-0000-4000-8000-000000000002";
const resource = { product: "pms", resourceType: "pms_property", resourceId: propertyId } as const;
const details = {
  accountHolder: "Private Holder",
  accountType: "iban",
  accountNumber: "DE89370400440532013000",
  bankName: "Private Bank",
  bicSwift: "COBADEFFXXX",
  instructions: "Private instructions",
};
const body = {
  action: "replace",
  commandId: "14660000-0000-4000-8000-000000000003",
  expectedVersion: 0,
  details,
};
const summary = {
  id: body.commandId,
  propertyId,
  revision: 1,
  version: 1,
  enabled: true,
  deleted: false,
  accountLast4: "3000",
};
const path = `/api/finance/properties/${propertyId}/bank-transfer-destination`;

it.each([
  "missing",
  "invalid",
  "permission",
  "entitlement",
  "inactive",
  "link",
  "operator",
  "allowed",
  "booking-only",
  "unassigned",
  "no-canonical",
])("enforces %s authorization before reading or writing secrets", async (variant) => {
  const repository = {
    read: vi.fn(async () => summary),
    execute: vi.fn(async () => ({ status: "applied" as const, summary })),
  };
  const app = Fastify();
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (["missing", "invalid"].includes(variant)) return;
    request.authContext = {
      actor: { internalUserId: "14660000-0000-4000-8000-000000000004", status: "active" },
      selectedOrganization: { organizationId: "org", kind: "hotel_group", status: "active" },
      membership: {
        roleKey: "hotel_owner",
        status: "active",
        permissions:
          variant === "permission"
            ? []
            : ["pms.finance.read", "pms.operations.manage", "booking.settings.manage"],
      },
      linkedResources:
        variant === "link"
          ? []
          : [
              ...(variant === "no-canonical"
                ? []
                : [
                    {
                      product: "hotel_catalog",
                      resourceType: "property",
                      resourceId: propertyId,
                      relationship: "owner",
                      status: "active",
                    },
                  ]),
              {
                ...resource,
                relationship: variant === "operator" ? "operator" : "owner",
                status: "active",
              },
            ],
      entitlements:
        variant === "entitlement"
          ? []
          : [
              {
                product: variant === "booking-only" ? "booking" : "pms",
                key: variant === "booking-only" ? "direct-booking-finance" : "property-management",
                status: variant === "inactive" ? "suspended" : "active",
                resource,
              },
            ],
      audit: { requestId: "request", receivedAt: "2026-09-05T00:00:00Z" },
    } as RequestContext;
  });
  const publisher = { publish: vi.fn(async () => null) };
  await app.register(registerFinanceBankTransferRoutes, {
    prefix: "/api",
    repository,
    propertyAccessRepository: {
      findMembershipPropertyScope: async () => ({
        mode: "assigned",
        roleKey: "hotel_owner",
        accessOrigin: "agency",
        assignedPropertyIds: variant === "unassigned" ? [] : [propertyId],
      }),
    },
    publicBookabilityPublisher: publisher,
  });
  try {
    for (const method of ["GET", "PUT"] as const) {
      if (method === "PUT" && ["unassigned", "no-canonical"].includes(variant)) continue;
      const response = await app.inject({
        method,
        url: path,
        ...(method === "PUT" ? { payload: body } : {}),
      });
      const allowed =
        ["allowed", "booking-only"].includes(variant) ||
        (variant === "operator" && method === "GET");
      expect(response.statusCode).toBe(
        allowed ? 200 : ["missing", "invalid"].includes(variant) ? 401 : 403,
      );
      expect(method === "GET" ? repository.read : repository.execute).toHaveBeenCalledTimes(
        allowed ? 1 : 0,
      );
      expect(response.body).not.toContain(details.accountNumber);
      if (allowed) expect(response.json().destination.maskedAccount).toBe("•••• 3000");
    }
    expect(publisher.publish).toHaveBeenCalledTimes(
      ["allowed", "booking-only"].includes(variant) ? 1 : 0,
    );
    if (variant === "allowed") {
      repository.execute.mockRejectedValueOnce(new Error(details.accountNumber));
      expect((await app.inject({ method: "PUT", url: path, payload: body })).json()).toEqual({
        code: "bank_transfer_destination_unavailable",
      });
      const invalid = await app.inject({
        method: "PUT",
        url: path,
        payload: { ...body, details: { ...details, accountHolder: "" } },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.body).not.toContain(details.accountNumber);
      repository.read.mockResolvedValueOnce({ ...summary, propertyId: body.commandId });
      expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(503);
    }
  } finally {
    await app.close();
  }
});

it("validates optional bank transfer KMS configuration without sharing provider onboarding state", () => {
  const arn = "arn:aws:kms:eu-west-1:123456789012:key/11111111-2222-3333-4444-555555555555";
  expect(loadConfig({}).financeBankTransferKms).toBeUndefined();
  expect(
    loadConfig({
      FINANCE_BANK_TRANSFER_KMS_CURRENT_KEY_ARN: arn,
      FINANCE_BANK_TRANSFER_KMS_ALLOWED_KEY_ARNS: arn,
    }).financeBankTransferKms,
  ).toEqual({ currentKeyArn: arn, allowedKeyArns: [arn], region: "eu-west-1" });
  expect(() => loadConfig({ FINANCE_BANK_TRANSFER_KMS_CURRENT_KEY_ARN: arn })).toThrow(
    "Bank transfer KMS configuration is invalid",
  );
});
