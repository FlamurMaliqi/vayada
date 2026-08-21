import type {
  LinkedResource,
  PermissionKey,
  ProductEntitlement,
  RequestContext,
} from "@vayada/backend-auth";
import type { FinanceFolioDetailResponse, FinanceFolioListResponse } from "@vayada/domain-finance";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import {
  FinanceFolioCursorError,
  FinanceFolioEvidenceError,
} from "./domains/financeFolioReadRepository.js";
import type { FinanceFolioRoutesOptions } from "./routes/financeFolios.js";

const propertyId = "11320000-0000-4000-8000-000000000001";
const otherPropertyId = "11320000-0000-4000-8000-000000000002";
const folioId = "11320000-0000-4000-8000-000000000003";
const bookingId = "11320000-0000-4000-8000-000000000004";
const lineId = "11320000-0000-4000-8000-000000000005";
const paymentId = "11320000-0000-4000-8000-000000000006";
const now = "2026-08-21T10:00:00.000Z";
const root = `/api/finance/properties/${propertyId}/financials/folios`;
const money = { amount: "12.0000", currency: "EUR" };
const base = {
  contractVersion: "pms-financials.v1" as const,
  propertyId,
  currency: "EUR",
  timeZone: "Europe/Berlin",
  generatedAt: now,
  sourceFreshness: { financeFolios: now },
  incompleteEvidence: [],
};
const summary = {
  folioId,
  bookingId,
  revision: 2,
  state: "ready" as const,
  serviceFrom: "2026-08-20",
  serviceTo: "2026-08-21",
  total: money,
  createdAt: now,
};
const list: FinanceFolioListResponse = {
  ...base,
  page: { items: [summary], nextCursor: "cursor", limit: 1 },
};
// prettier-ignore
const detail: FinanceFolioDetailResponse = { ...base, item: { ...summary, propertyId, recipient: { name: "Ada Lovelace", email: "ada@example.com" }, currency: "EUR", lines: [{ lineId, position: 1, kind: "room", description: "Stay", quantity: "1.0000", unitAmount: money, total: money, serviceOn: "2026-08-20", source: { type: "booking_night", id: bookingId, revision: 3 } }], paymentRefs: [{ paymentId, amount: money }], sourceDigest: "a".repeat(64), sourceFreshness: { booking: now } } };

type Ports = FinanceFolioRoutesOptions["repository"] & {
  list: ReturnType<typeof vi.fn>;
  detail: ReturnType<typeof vi.fn>;
};
const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function ports(): Ports {
  return {
    list: vi.fn(async () => list),
    detail: vi.fn(async () => detail),
  } as Ports;
}

async function app(repository: Ports, auth: RequestContext | null = context()) {
  const instance = buildApp({ logger: false, financeFolios: { repository } });
  instance.decorateRequest("authContext", null);
  instance.addHook("onRequest", async (request) => {
    request.authContext = auth;
  });
  apps.push(instance);
  return instance;
}

describe("Financials folio read routes", () => {
  it("registers list and detail with canonical query, IDs, and response shapes", async () => {
    const repository = ports();
    const instance = await app(repository);
    const listed = await instance.inject({
      method: "GET",
      url: `${root}?from=2026-08-01&to=2026-08-31&state=ready&search=Guest&sort=amount_desc&limit=1`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual(list);
    expect(listed.headers).toMatchObject({
      "cache-control": "private, no-store",
      vary: "Authorization",
    });
    expect(repository.list).toHaveBeenCalledWith(propertyId, {
      from: "2026-08-01",
      to: "2026-08-31",
      state: "ready",
      search: "Guest",
      sort: "amount_desc",
      limit: 1,
    });

    repository.detail.mockResolvedValueOnce({
      ...detail,
      providerSecret: "must-not-leak",
      item: { ...detail.item, recipient: { ...detail.item.recipient, taxId: "must-not-leak" } },
    });
    const read = await instance.inject({ method: "GET", url: `${root}/${folioId.toUpperCase()}` });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(detail);
    expect(JSON.stringify(read.json())).not.toContain("must-not-leak");
    expect(repository.detail).toHaveBeenCalledWith(propertyId, folioId);
  });

  it("enforces the complete read denial matrix before validation or ports", async () => {
    const allowed = context();
    // prettier-ignore
    const denied: Array<[RequestContext | null, number]> = [[null, 401], [context({ permissions: [] }), 403], [context({ kind: "platform" }), 403], [context({ entitlements: [] }), 403], [context({ entitlements: [entitlement("property-management")] }), 403], [context({ entitlements: [entitlement("property-management", "suspended"), entitlement("module:financials")] }), 403], [context({ entitlements: [entitlement("property-management"), entitlement("module:financials", "suspended")] }), 403], [context({ links: [] }), 403], [context({ links: [{ ...allowed.linkedResources[0]!, relationship: "operator" }] }), 403], [context({ links: [{ ...allowed.linkedResources[0]!, resourceId: otherPropertyId }] }), 403]];
    for (const [auth, status] of denied) {
      const repository = ports();
      const instance = await app(repository, auth);
      const response = await instance.inject({
        method: "GET",
        url: `${root}?private=1`,
      });
      expect(response.statusCode).toBe(status);
      expect(repository.list).not.toHaveBeenCalled();
    }
  });

  it("validates authorized inputs and maps missing or typed repository outcomes", async () => {
    const repository = ports();
    const instance = await app(repository);
    expect(await instance.inject({ method: "GET", url: `${root}?unknown=1` })).toHaveProperty(
      "statusCode",
      400,
    );
    expect(await instance.inject({ method: "GET", url: `${root}/not-a-uuid` })).toHaveProperty(
      "statusCode",
      400,
    );
    expect(repository.list).not.toHaveBeenCalled();
    expect(repository.detail).not.toHaveBeenCalled();

    repository.detail.mockResolvedValueOnce(null);
    expect(await instance.inject({ method: "GET", url: `${root}/${folioId}` })).toHaveProperty(
      "statusCode",
      404,
    );
    repository.list.mockRejectedValueOnce(new FinanceFolioCursorError("private"));
    expect((await instance.inject({ method: "GET", url: root })).json()).toEqual({
      code: "invalid_cursor",
    });
    repository.list.mockRejectedValueOnce(new FinanceFolioEvidenceError("private"));
    expect(await instance.inject({ method: "GET", url: root })).toMatchObject({ statusCode: 422 });
    repository.list.mockRejectedValueOnce(new Error("secret"));
    expect((await instance.inject({ method: "GET", url: root })).json()).toEqual({
      code: "finance_folio_port_contract_violation",
    });
  });

  it("fails closed on a cross-property repository response", async () => {
    const repository = ports();
    repository.list.mockResolvedValueOnce({ ...list, propertyId: otherPropertyId });
    const instance = await app(repository);
    const response = await instance.inject({ method: "GET", url: root });
    expect(response).toMatchObject({ statusCode: 500 });
    expect(response.json()).toEqual({ code: "finance_folio_port_contract_violation" });
  });
});

type Overrides = {
  permissions?: PermissionKey[];
  entitlements?: ProductEntitlement[];
  links?: LinkedResource[];
  kind?: "hotel_group" | "platform";
};
// prettier-ignore
const resource = { product: "pms" as const, resourceType: "pms_property" as const, resourceId: propertyId };
// prettier-ignore
const entitlement = (key: string, status: ProductEntitlement["status"] = "active"): ProductEntitlement => ({ product: "pms", key, status, resource });
// prettier-ignore
const context = (overrides: Overrides = {}): RequestContext => ({ actor: { internalUserId: "11320000-0000-4000-8000-000000000010" }, selectedOrganization: { organizationId: "11320000-0000-4000-8000-000000000011", kind: overrides.kind ?? "hotel_group" }, membership: { permissions: overrides.permissions ?? ["pms.finance.read"] }, entitlements: overrides.entitlements ?? [entitlement("property-management"), entitlement("module:financials")], linkedResources: overrides.links ?? [{ ...resource, relationship: "owner", status: "active" }], locale: "en", currency: "EUR", audit: { requestId: "request-1", receivedAt: now, source: "api" } } as RequestContext);
