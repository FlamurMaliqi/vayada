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
const correctCommandId = "11320000-0000-4000-8000-000000000007";
const readyCommandId = "11320000-0000-4000-8000-000000000008";
const archiveCommandId = "11320000-0000-4000-8000-000000000009";
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
  page: { items: [summary], nextCursor: null, limit: 1 },
};
// prettier-ignore
const detail: FinanceFolioDetailResponse = { ...base, item: { ...summary, propertyId, recipient: { name: "Ada Lovelace", email: "ada@example.com" }, currency: "EUR", lines: [{ lineId, position: 1, kind: "room", description: "Stay", quantity: "1.0000", unitAmount: money, total: money, serviceOn: "2026-08-20", source: { type: "booking_night", id: bookingId, revision: 3 } }], paymentRefs: [{ paymentId, amount: money }], sourceDigest: "a".repeat(64), sourceFreshness: { booking: now } } };

type Ports = FinanceFolioRoutesOptions["repository"] & {
  list: ReturnType<typeof vi.fn>;
  detail: ReturnType<typeof vi.fn>;
};
type Commands = NonNullable<FinanceFolioRoutesOptions["commands"]> & {
  create: ReturnType<typeof vi.fn>;
  correct: ReturnType<typeof vi.fn>;
  ready: ReturnType<typeof vi.fn>;
  archive: ReturnType<typeof vi.fn>;
};
const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function ports(): Ports {
  return {
    list: vi.fn(async () => list),
    detail: vi.fn(async () => detail),
  } as Ports;
}

function commands(): Commands {
  return {
    create: vi.fn(async () => ({ status: "created", folioId, revision: 1 })),
    correct: vi.fn(async () => ({ status: "updated", folioId, revision: 2 })),
    ready: vi.fn(async () => ({ status: "updated", folioId, revision: 3 })),
    archive: vi.fn(async () => ({ status: "replayed", folioId, revision: 4 })),
  } as Commands;
}

async function app(repository: Ports, auth: RequestContext | null = context(), write?: Commands) {
  const instance = buildApp({
    logger: false,
    browserAllowedOrigins: ["https://pms.example"],
    financeFolios: { repository, ...(write ? { commands: write } : {}) },
  });
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
      headers: { origin: "https://pms.example" },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual(list);
    expect(listed.headers).toMatchObject({
      "cache-control": "private, no-store",
      vary: "Origin, Authorization",
      "access-control-allow-origin": "https://pms.example",
    });
    expect(repository.list).toHaveBeenCalledWith(propertyId, {
      from: "2026-08-01",
      to: "2026-08-31",
      state: "ready",
      search: "Guest",
      sort: "amount_desc",
      limit: 1,
    });

    const read = await instance.inject({ method: "GET", url: `${root}/${folioId.toUpperCase()}` });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(detail);
    expect(repository.detail).toHaveBeenCalledWith(propertyId, folioId);

    repository.detail.mockResolvedValueOnce({
      ...detail,
      providerSecret: "must-not-leak",
      item: { ...detail.item, recipient: { ...detail.item.recipient, taxId: "must-not-leak" } },
    });
    const invalid = await instance.inject({ method: "GET", url: `${root}/${folioId}` });
    expect(invalid.statusCode).toBe(500);
    expect(JSON.stringify(invalid.json())).not.toContain("must-not-leak");

    // prettier-ignore
    for (const page of [{ ...list.page, items: [{ ...summary, total: { ...money, amount: "12" } }] }, { ...list.page, items: [{ ...summary, total: { ...money, currency: "USD" } }] }, { ...list.page, items: [{ ...summary, createdAt: "2026-02-31T00:00:00.000Z" }] }, { ...list.page, nextCursor: "not valid" }, { ...list.page, nextCursor: Buffer.from(JSON.stringify({ v: 1, q: [otherPropertyId, "EUR", null, null, null, null, "createdAt_desc"], p: [now, folioId] })).toString("base64url") }]) { repository.list.mockResolvedValueOnce({ ...list, page } as never); expect(await instance.inject({ method: "GET", url: root })).toHaveProperty("statusCode", 500); }
    repository.list.mockResolvedValueOnce({ ...list, timeZone: "Etc/UTC" });
    expect(await instance.inject({ method: "GET", url: root })).toHaveProperty("statusCode", 200);
  });

  it("enforces the complete read denial matrix before validation or ports", async () => {
    const allowed = context();
    // prettier-ignore
    const denied: Array<[RequestContext | null, number]> = [[null, 401], [context({ permissions: [] }), 403], [context({ kind: "platform" }), 403], [context({ entitlements: [] }), 403], [context({ entitlements: [entitlement("property-management")] }), 403], [context({ entitlements: [entitlement("property-management", "suspended"), entitlement("module:financials")] }), 403], [context({ entitlements: [entitlement("property-management"), entitlement("module:financials", "suspended")] }), 403], [context({ links: [] }), 403], [context({ links: [{ ...allowed.linkedResources[0]!, status: "suspended" }] }), 403], [context({ links: [{ ...allowed.linkedResources[0]!, relationship: "operator" }] }), 403], [context({ links: [{ ...allowed.linkedResources[0]!, resourceId: otherPropertyId }] }), 403]];
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

    const financeManager = ports();
    const instance = await app(
      financeManager,
      context({ links: [{ ...allowed.linkedResources[0]!, relationship: "finance_manager" }] }),
    );
    expect(await instance.inject({ method: "GET", url: root })).toHaveProperty("statusCode", 200);
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

describe("Financials folio write routes", () => {
  it("creates, corrects, readies, and archives with manage-only receipts and audit", async () => {
    const write = commands();
    const instance = await app(ports(), context({ permissions: ["pms.finance.manage"] }), write);
    const created = await instance.inject({
      method: "POST",
      url: root,
      headers: { "idempotency-key": "folio-create" },
      payload: writeBody(),
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({
      contractVersion: "pms-financials.v1",
      propertyId,
      resourceId: folioId,
      revision: 1,
      outcome: "created",
    });
    expect(write.create).toHaveBeenCalledWith({
      ...writeBody(),
      propertyId,
      audit: commandAudit("finance.folio.create"),
    });

    const corrected = await instance.inject({
      method: "PATCH",
      url: `${root}/${folioId}`,
      payload: { ...writeBody(), commandId: correctCommandId, expectedRevision: 1 },
    });
    expect(corrected).toMatchObject({ statusCode: 200 });
    expect(write.correct).toHaveBeenCalledWith({
      ...writeBody(),
      commandId: correctCommandId,
      expectedRevision: 1,
      folioId,
      propertyId,
      audit: commandAudit("finance.folio.correct"),
    });

    const ready = await instance.inject({
      method: "POST",
      url: `${root}/${folioId}/ready`,
      payload: revisionBody(readyCommandId, "folio-ready", 2),
    });
    expect(ready.json()).toMatchObject({ revision: 3, outcome: "updated" });
    expect(write.ready).toHaveBeenCalledWith({
      ...revisionBody(readyCommandId, "folio-ready", 2),
      folioId,
      propertyId,
      audit: commandAudit("finance.folio.ready"),
    });

    const archived = await instance.inject({
      method: "DELETE",
      url: `${root}/${folioId}`,
      payload: revisionBody(archiveCommandId, "folio-archive", 3),
    });
    expect(archived.json()).toMatchObject({ revision: 4, outcome: "replayed" });
    expect(write.archive).toHaveBeenCalledWith({
      ...revisionBody(archiveCommandId, "folio-archive", 3),
      folioId,
      propertyId,
      audit: commandAudit("finance.folio.archive"),
    });
  });

  it("authorizes manage before parsing and does not treat read as manage", async () => {
    const write = commands();
    const readOnly = await app(ports(), context(), write);
    const denied = await readOnly.inject({ method: "POST", url: root, payload: { private: true } });
    expect(denied.statusCode).toBe(403);
    expect(write.create).not.toHaveBeenCalled();

    const noEntitlement = await app(
      ports(),
      context({ permissions: ["pms.finance.manage"], entitlements: [] }),
      write,
    );
    expect(
      await noEntitlement.inject({ method: "DELETE", url: `${root}/private`, payload: {} }),
    ).toMatchObject({ statusCode: 403 });
    expect(write.archive).not.toHaveBeenCalled();
  });

  it("rejects malformed idempotency and maps only typed command outcomes", async () => {
    const write = commands();
    const instance = await app(ports(), context({ permissions: ["pms.finance.manage"] }), write);
    expect(
      await instance.inject({
        method: "POST",
        url: root,
        headers: { "idempotency-key": "different" },
        payload: writeBody(),
      }),
    ).toMatchObject({ statusCode: 400 });
    expect(write.create).not.toHaveBeenCalled();

    write.create.mockResolvedValueOnce({ status: "invalid_evidence" });
    expect(
      await instance.inject({ method: "POST", url: root, payload: writeBody() }),
    ).toMatchObject({ statusCode: 422 });
    write.correct.mockResolvedValueOnce({ status: "not_found" });
    expect(
      await instance.inject({
        method: "PATCH",
        url: `${root}/${folioId}`,
        payload: { ...writeBody(), commandId: correctCommandId, expectedRevision: 1 },
      }),
    ).toMatchObject({ statusCode: 404 });
    write.ready.mockResolvedValueOnce({ status: "conflict", reason: "revision_conflict" });
    expect(
      await instance.inject({
        method: "POST",
        url: `${root}/${folioId}/ready`,
        payload: revisionBody(readyCommandId, "folio-ready", 2),
      }),
    ).toMatchObject({ statusCode: 409 });
    write.archive.mockResolvedValueOnce({ status: "conflict", reason: "private" } as never);
    const invalid = await instance.inject({
      method: "DELETE",
      url: `${root}/${folioId}`,
      payload: revisionBody(archiveCommandId, "folio-archive", 3),
    });
    expect(invalid).toMatchObject({ statusCode: 500 });
    expect(JSON.stringify(invalid.json())).not.toContain("private");

    write.archive.mockResolvedValueOnce({
      status: "conflict",
      reason: { private: true, toString: () => "revision_conflict" },
    } as never);
    const nonStringReason = await instance.inject({
      method: "DELETE",
      url: `${root}/${folioId}`,
      payload: revisionBody(archiveCommandId, "folio-archive", 3),
    });
    expect(nonStringReason).toMatchObject({ statusCode: 500 });
    expect(JSON.stringify(nonStringReason.json())).not.toContain("private");

    write.archive.mockResolvedValueOnce({
      status: "updated",
      folioId,
      revision: 2_147_483_648,
    });
    const oversizedRevision = await instance.inject({
      method: "DELETE",
      url: `${root}/${folioId}`,
      payload: revisionBody(archiveCommandId, "folio-archive", 3),
    });
    expect(oversizedRevision).toMatchObject({ statusCode: 500 });
    expect(JSON.stringify(oversizedRevision.json())).not.toContain("2147483648");
  });
});

function writeBody() {
  return {
    commandId: folioId,
    idempotencyKey: "folio-create",
    bookingId,
    recipient: { name: "Ada Lovelace", email: "ada@example.com" },
    serviceFrom: "2026-08-20",
    serviceTo: "2026-08-21",
    lines: [
      {
        position: 1,
        kind: "room",
        description: "Stay",
        quantity: "1.0000",
        unitAmount: money,
        serviceOn: "2026-08-20",
        source: { type: "booking.nightly_revenue", id: lineId, revision: 1 },
      },
    ],
    paymentRefs: [{ paymentId, amount: money }],
  };
}

function revisionBody(commandId: string, idempotencyKey: string, expectedRevision: number) {
  return { commandId, idempotencyKey, expectedRevision };
}

function commandAudit(reason: string) {
  return {
    actor: {
      kind: "user",
      userId: "11320000-0000-4000-8000-000000000010",
      organizationId: "11320000-0000-4000-8000-000000000011",
    },
    requestId: "request-1",
    correlationId: undefined,
    reason,
    requestedAt: now,
  };
}

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
