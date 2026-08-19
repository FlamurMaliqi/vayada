import type { RequestContext } from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import {
  FINANCE_OTA_CHANNELS,
  FINANCE_ROUTE_CONTRACT_VERSION,
  normalizeFinanceOtaCommissionRate,
} from "@vayada/domain-finance";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import financeRouteContracts from "../../../engineering/fixtures/finance-route-contracts/cases.json" with { type: "json" };
import type { SetFinanceOtaCommissionRuleCommand } from "./domains/financeOtaCommissionRuleRepository.js";
import { registerFinanceOtaCommissionSettingsRoutes } from "./routes/financeOtaCommissionSettings.js";

const PROPERTY = "f3000000-0000-4000-8000-000000000686";
const VALID = "Bearer valid-token";
const RESOURCE = { product: "pms", resourceType: "pms_property", resourceId: PROPERTY } as const;
type ListBody = { contractVersion: string; settings: Record<"channel" | "status", string>[] };
type UpdateBody = { contractVersion: string; outcome: string; setting: { percentageRate: string } };
const RULE = {
  ruleId: "rule-1",
  propertyId: PROPERTY,
  channel: "booking_com",
  percentageRate: normalizeFinanceOtaCommissionRate("15")!,
  effectiveFrom: "2026-08-08T00:00:00.000Z",
  effectiveTo: null,
  revision: 1,
} as const;
const fixture = (caseId: string) =>
  financeRouteContracts.cases.find((candidate) => candidate.caseId === caseId)!;
const LIST_FIXTURE = fixture("ota-commission-settings-list");
const UPDATE_FIXTURE = fixture("ota-commission-settings-update");
const PATH = LIST_FIXTURE.request!.path;
const BODY = UPDATE_FIXTURE.request!.body! as Record<string, unknown>;

describe("Finance OTA commission settings routes", () => {
  let app: FastifyInstance | null = null;
  afterEach(() => app?.close());

  it("passes list and update contract fixtures without leaking private fields", async () => {
    const repository = fakeRepository();
    app = await testApp(repository);
    const listed = await injectJson<ListBody>(app, {
      method: LIST_FIXTURE.request!.method as "GET",
      url: PATH,
      headers: { authorization: VALID },
    });
    expect(listed.statusCode).toBe(LIST_FIXTURE.expected!.status);
    expect(listed.body.settings.map(({ channel }: { channel: string }) => channel)).toEqual(
      FINANCE_OTA_CHANNELS,
    );
    expect(
      listed.body.settings.filter(({ status }: { status: string }) => status === "configured"),
    ).toHaveLength(1);
    const updated = await put(app);
    expect([updated.statusCode, updated.body.outcome, updated.body.setting.percentageRate]).toEqual(
      [UPDATE_FIXTURE.expected!.status, "created", "15.0000"],
    );
    expect([listed.body.contractVersion, updated.body.contractVersion]).toEqual([
      FINANCE_ROUTE_CONTRACT_VERSION,
      FINANCE_ROUTE_CONTRACT_VERSION,
    ]);
    for (const field of UPDATE_FIXTURE.expected!.mustExclude!)
      expect(JSON.stringify([listed.body, updated.body])).not.toContain(field);
    expect(repository.commands[0]).toMatchObject({
      propertyId: PROPERTY,
      channel: "booking_com",
      expectedRevision: 0,
      audit: { actor: { userId: "user", organizationId: "organization" } },
    });
  });

  it.each([
    ["missing", "GET", undefined, 401],
    ["invalid", "GET", "Bearer invalid", 401],
    ["no-read", "GET", VALID, 403],
    ["no-manage", "PUT", VALID, 403],
    ["no-property-entitlement", "PUT", VALID, 403],
    ["no-module-entitlement", "PUT", VALID, 403],
    ["inactive-module", "PUT", VALID, 403],
    ["no-link", "PUT", VALID, 403],
    ["inactive-link", "PUT", VALID, 403],
    ["operator", "PUT", VALID, 403],
    ["finance-manager", "PUT", VALID, 201],
  ] as const)(
    "enforces %s before validation or repository access",
    async (variant, method, token, status) => {
      const repository = fakeRepository();
      app = await testApp(repository, variant);
      const response = await injectJson(app, {
        method,
        url: method === "GET" ? PATH : `${PATH}/booking_com`,
        headers: token ? { authorization: token } : {},
        payload: method === "PUT" && status === 201 ? BODY : { unsafe: true },
      });
      expect(response.statusCode).toBe(status);
      expect(repository.accesses).toHaveLength(status < 300 ? 1 : 0);
    },
  );

  it("returns stable validation and conflict errors", async () => {
    const repository = fakeRepository();
    app = await testApp(repository);
    for (const body of [
      { ...BODY, percentageRate: "101" },
      { ...BODY, effectiveFrom: "2026-08-08" },
      { ...BODY, expectedRevision: -1 },
      { ...BODY, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...BODY, commandId: "" },
      { ...BODY, idempotencyKey: " key " },
    ])
      expect((await put(app, body)).statusCode).toBe(400);
    expect((await put(app, BODY, "invalid-channel")).statusCode).toBe(400);
    expect(repository.accesses).toHaveLength(0);
    expect(await put(app, { ...BODY, effectiveFrom: "2026-08-08T02:00:00+02:00" })).toMatchObject({
      statusCode: 201,
    });
    expect(repository.commands.at(-1)?.effectiveFrom).toBe("2026-08-08T00:00:00.000Z");
    for (const reason of ["revision_conflict", "idempotency_key_reused"] as const) {
      repository.result = { status: "conflict", reason };
      expect(await put(app)).toMatchObject({ statusCode: 409, body: { code: reason } });
    }
    repository.result = { status: "applied", rule: { ...RULE, channel: "airbnb" } };
    expect((await put(app)).statusCode).toBe(500);
  });
});

function fakeRepository() {
  const privateRule = { ...RULE, providerSecret: "secret", guestEmail: "guest@example.test" };
  const repository = {
    rules: [privateRule],
    accesses: [] as string[],
    commands: [] as SetFinanceOtaCommissionRuleCommand[],
    result: { status: "applied", rule: privateRule, previousRuleId: null } as unknown,
    async list() {
      repository.accesses.push("list");
      return repository.rules;
    },
    async setRule(command: SetFinanceOtaCommissionRuleCommand) {
      repository.accesses.push("set");
      repository.commands.push(command);
      return repository.result as never;
    },
  };
  return repository;
}

async function testApp(repository: ReturnType<typeof fakeRepository>, variant = "owner") {
  const instance = Fastify({ logger: false });
  instance.decorateRequest("authContext", null);
  instance.addHook("onRequest", async (request) => {
    if (request.headers.authorization === VALID) request.authContext = context(variant);
  });
  await instance.register(registerFinanceOtaCommissionSettingsRoutes, {
    prefix: "/api",
    repository,
  });
  return instance;
}

function context(variant: string): RequestContext {
  const value = {
    actor: { internalUserId: "user" },
    selectedOrganization: { organizationId: "organization", kind: "hotel_group" },
    membership: { permissions: ["pms.finance.read", "pms.finance.manage"] },
    linkedResources: [{ ...RESOURCE, relationship: "owner", status: "active" }],
    entitlements: [
      { product: "pms", key: "property-management", status: "active", resource: RESOURCE },
      { product: "pms", key: "module:financials", status: "active", resource: RESOURCE },
    ],
    audit: { requestId: "request", correlationId: "correlation", receivedAt: "now" },
  } as RequestContext;
  if (variant === "no-read") value.membership.permissions = ["pms.finance.manage"];
  if (variant === "no-manage") value.membership.permissions = ["pms.finance.read"];
  if (variant === "finance-manager") value.linkedResources[0]!.relationship = "finance_manager";
  if (variant === "operator") value.linkedResources[0]!.relationship = "operator";
  if (variant === "no-link") value.linkedResources = [];
  if (variant === "inactive-link") value.linkedResources[0]!.status = "suspended";
  if (variant === "no-property-entitlement") value.entitlements.splice(0, 1);
  if (variant === "no-module-entitlement") value.entitlements.splice(1, 1);
  if (variant === "inactive-module") value.entitlements[1]!.status = "suspended";
  return value;
}
async function put(app: FastifyInstance, body = BODY, channel?: string) {
  return injectJson<UpdateBody>(app, {
    method: UPDATE_FIXTURE.request!.method as "PUT",
    url: channel ? `${PATH}/${channel}` : UPDATE_FIXTURE.request!.path,
    headers: { authorization: VALID },
    payload: body,
  });
}
