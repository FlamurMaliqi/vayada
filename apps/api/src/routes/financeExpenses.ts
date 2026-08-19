import { UnauthorizedError, type RequestContext } from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import {
  FINANCE_EXPENSE_CADENCES,
  FINANCE_EXPENSE_ORIGINS,
  FINANCE_EXPENSE_PAYMENT_STATUSES,
  PMS_FINANCIALS_CONTRACT_VERSION,
  normalizeFinanceExpenseAmount,
  parseFinanceExpenseQuery,
  parseFinanceExpenseWrite,
  type FinanceCommandAudit,
} from "@vayada/domain-finance";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type {
  ArchiveFinanceExpenseCategoryCommand,
  CreateFinanceExpenseCategoryCommand,
  CreateFinanceExpenseCategoryResult,
  MutateFinanceExpenseCategoryResult,
  UpdateFinanceExpenseCategoryCommand,
} from "../domains/financeExpenseCategoryRepository.js";
import {
  FinanceExpenseCursorError,
  FinanceExpenseEvidenceError,
  type FinanceExpenseReadModel,
} from "../domains/financeExpenseReadModel.js";
import type {
  ArchiveFinanceManualExpenseCommand,
  ArchiveFinanceManualExpenseResult,
  CreateFinanceManualExpenseCommand,
  CreateFinanceManualExpenseResult,
  FinanceExpenseReceipt,
  FinanceExpenseReceiptReadPort,
  MutateFinanceManualExpenseResult,
  UpdateFinanceManualExpenseCommand,
} from "../domains/financeManualExpenseRepository.js";
import {
  createPrivateDownloadPolicy,
  type PlatformMediaServingConfig,
} from "../platform/mediaServing.js";
import type { PlatformMediaPrivateDownloadSigner } from "../platform/platformMediaS3.js";
import type {
  CreateFinanceRecurringExpenseRuleCommand,
  DisableFinanceRecurringExpenseRuleCommand,
  FinanceRecurringExpenseRuleCommandResult,
  UpdateFinanceRecurringExpenseRuleCommand,
} from "../domains/financeRecurringExpenseRuleRepository.js";
import { enforceRoutePolicy } from "./policy.js";

type Scope = { context: RequestContext; propertyId: string; canRead: boolean };
type Params = { propertyId: string; categoryId?: string; expenseId?: string; ruleId?: string };
// prettier-ignore
type CategoryPort = {
  create(command: CreateFinanceExpenseCategoryCommand): Promise<CreateFinanceExpenseCategoryResult>;
  update(command: UpdateFinanceExpenseCategoryCommand): Promise<MutateFinanceExpenseCategoryResult>;
  archive(command: ArchiveFinanceExpenseCategoryCommand): Promise<MutateFinanceExpenseCategoryResult>;
};
type ExpensePort = {
  create(command: CreateFinanceManualExpenseCommand): Promise<CreateFinanceManualExpenseResult>;
  update(command: UpdateFinanceManualExpenseCommand): Promise<MutateFinanceManualExpenseResult>;
  archive(command: ArchiveFinanceManualExpenseCommand): Promise<ArchiveFinanceManualExpenseResult>;
};
// prettier-ignore
type RecurringPort = {
  create(command: CreateFinanceRecurringExpenseRuleCommand): Promise<FinanceRecurringExpenseRuleCommandResult>;
  update(command: UpdateFinanceRecurringExpenseRuleCommand): Promise<FinanceRecurringExpenseRuleCommandResult>;
  disable(command: DisableFinanceRecurringExpenseRuleCommand): Promise<FinanceRecurringExpenseRuleCommandResult>;
};
export type FinanceExpenseRoutesOptions = {
  read: Pick<FinanceExpenseReadModel, "categories" | "expense" | "expenses" | "recurringRule">;
  categories: CategoryPort;
  expenses: ExpensePort;
  recurring: RecurringPort;
  receiptMedia?: {
    read: FinanceExpenseReceiptReadPort;
    signer: PlatformMediaPrivateDownloadSigner;
    serving: PlatformMediaServingConfig;
    now?: () => Date;
  };
};

const ROOT = "/finance/properties/:propertyId/financials";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMMAND = ["commandId", "idempotencyKey"] as const;
const REVISION = [...COMMAND, "expectedRevision"] as const;
// prettier-ignore
const FAILURES = ["invalid_command", "not_found", "revision_conflict", "idempotency_conflict", "currency_mismatch", "evidence_mismatch", "write_unavailable"], CATEGORY_FAILURES = ["active_recurring_rule", "revision_conflict", "revision_exhausted", "already_archived", "idempotency_key_reused", "command_in_progress"];

// prettier-ignore
export async function registerFinanceExpenseRoutes(app: FastifyInstance, options: FinanceExpenseRoutesOptions): Promise<void> {
  const scopes = new WeakMap<FastifyRequest, Scope>();
  const read = authorize(scopes, "pms.finance.read");
  const write = authorize(scopes, "pms.finance.manage");
  const scope = (request: FastifyRequest) => scopes.get(request)!;

  app.get(`${ROOT}/expense-categories`, { onRequest: read }, async (request, reply) => safe(reply, async () => {
    if (!empty(request.query)) return bad(reply);
    return sendRead(reply, await options.read.categories(scope(request).propertyId), scope(request), "categories");
  }));
  app.post(`${ROOT}/expense-categories`, { onRequest: write }, async (request, reply) => safe(reply, async () => {
    const value = categoryBody(request, false); if (!empty(request.query) || !value) return bad(reply);
    const current = scope(request), result = categoryResult(await options.categories.create({ ...value as Omit<CreateFinanceExpenseCategoryCommand, "propertyId" | "audit">, propertyId: current.propertyId, audit: audit(current, "finance.expense_category.create") }));
    return result.ok ? sendCategoryWrite(reply, current, options, result) : failure(reply, result.code);
  }));
  app.patch(`${ROOT}/expense-categories/:categoryId`, { onRequest: write }, async (request, reply) => safe(reply, async () => {
    const value = categoryBody(request, true), current = scope(request), categoryId = pathId(request, "categoryId");
    if (!empty(request.query) || !value || !categoryId) return bad(reply);
    const result = categoryResult(await options.categories.update({ ...value as Omit<UpdateFinanceExpenseCategoryCommand, "propertyId" | "categoryId" | "audit">, propertyId: current.propertyId, categoryId, audit: audit(current, "finance.expense_category.update") }), categoryId);
    return result.ok ? sendCategoryWrite(reply, current, options, result) : failure(reply, result.code);
  }));
  app.delete(`${ROOT}/expense-categories/:categoryId`, { onRequest: write }, async (request, reply) => safe(reply, async () => {
    const value = commandBody(request, REVISION, REVISION), current = scope(request), categoryId = pathId(request, "categoryId");
    if (!empty(request.query) || !value || !categoryId) return bad(reply);
    const result = categoryResult(await options.categories.archive({ ...value as Omit<ArchiveFinanceExpenseCategoryCommand, "propertyId" | "categoryId" | "audit">, propertyId: current.propertyId, categoryId, audit: audit(current, "finance.expense_category.archive") }), categoryId);
    return result.ok ? sendCategoryWrite(reply, current, options, result) : failure(reply, result.code);
  }));

  app.get(`${ROOT}/expenses`, { onRequest: read }, async (request, reply) => safe(reply, async () => {
    const query = parseFinanceExpenseQuery(request.query); if (!query) return bad(reply);
    return sendRead(reply, await options.read.expenses(scope(request).propertyId, query), scope(request), "expenses");
  }));
  app.post(`${ROOT}/expenses`, { onRequest: write }, async (request, reply) => safe(reply, async () => {
    const parsed = parseFinanceExpenseWrite(request.body);
    if (!empty(request.query) || !parsed || parsed.expectedRevision !== undefined || !headerMatches(request, parsed.idempotencyKey)) return bad(reply);
    parsed.commandId = parsed.commandId.toLowerCase(); parsed.categoryId = parsed.categoryId.toLowerCase();
    if (parsed.supplierInvoiceNumber) return failure(reply, "write_unavailable");
    const current = scope(request);
    if (parsed.recurrence) {
      const { recurrence, incurredOn: _incurredOn, paidOn: _paidOn, ...template } = parsed;
      const result = recurringResult(await options.recurring.create({ ...template, ...recurrence, propertyId: current.propertyId, audit: audit(current, "finance.recurring_expense_rule.create") }), parsed.commandId);
      return result.ok ? sendRecurringWrite(reply, current, options, result) : failure(reply, result.code);
    }
    const result = expenseResult(await options.expenses.create({ ...parsed, propertyId: current.propertyId, audit: audit(current, "finance.manual_expense.create") }), [parsed.commandId]);
    return result.ok ? sendExpenseWrite(reply, current, options, result) : failure(reply, result.code);
  }));
  app.get(`${ROOT}/expenses/:expenseId`, { onRequest: read }, async (request, reply) => safe(reply, async () => {
    const expenseId = pathId(request, "expenseId"); if (!expenseId || !empty(request.query)) return bad(reply);
    return sendRead(reply, await options.read.expense(scope(request).propertyId, expenseId), scope(request), "expense", expenseId);
  }));
  app.get(`${ROOT}/expenses/:expenseId/receipt`, { onRequest: read }, async (request, reply) => safe(reply, async () => {
    const expenseId = pathId(request, "expenseId"), current = scope(request);
    if (!expenseId || !empty(request.query)) return bad(reply);
    if (!options.receiptMedia) return missing(reply);
    const media = await options.receiptMedia.read.receipt(current.propertyId, expenseId);
    if (!media) return missing(reply);
    if (!validReceipt(media, current.propertyId, expenseId)) return violation(reply);
    const policy = createPrivateDownloadPolicy(options.receiptMedia.serving, {
      bucketName: media.bucketName, storageKey: media.storageKey, visibility: media.visibility,
      status: media.lifecycleStatus, originalFilename: media.originalFilename, contentType: media.contentType,
    });
    const url = await options.receiptMedia.signer.signPrivateDownload(policy);
    if (!secureUrl(url)) return violation(reply);
    const expiresAt = new Date((options.receiptMedia.now?.() ?? new Date()).getTime() + policy.expiresInSeconds * 1000).toISOString();
    return reply.send({ contractVersion: "pms-financials-receipt.v1", propertyId: current.propertyId,
      expenseId, receipt: { mediaId: media.mediaId, disposition: { method: "GET", url, expiresAt } } });
  }));
  app.patch(`${ROOT}/expenses/:expenseId`, { onRequest: write }, async (request, reply) => safe(reply, async () => {
    const value = expensePatch(request), current = scope(request), expenseId = pathId(request, "expenseId");
    if (!empty(request.query) || !value || !expenseId) return bad(reply);
    if (Object.hasOwn(value, "supplierInvoiceNumber")) return failure(reply, "write_unavailable");
    const result = expenseResult(await options.expenses.update({ ...value as Omit<UpdateFinanceManualExpenseCommand, "propertyId" | "expenseId" | "audit">, propertyId: current.propertyId, expenseId, audit: audit(current, "finance.manual_expense.update") }), [expenseId, String(value.commandId).toLowerCase()]);
    return result.ok ? sendExpenseWrite(reply, current, options, result) : failure(reply, result.code);
  }));
  app.delete(`${ROOT}/expenses/:expenseId`, { onRequest: write }, async (request, reply) => safe(reply, async () => {
    const value = commandBody(request, REVISION, REVISION), current = scope(request), expenseId = pathId(request, "expenseId");
    if (!empty(request.query) || !value || !expenseId) return bad(reply);
    const result = expenseResult(await options.expenses.archive({ ...value as Omit<ArchiveFinanceManualExpenseCommand, "propertyId" | "expenseId" | "audit">, propertyId: current.propertyId, expenseId, audit: audit(current, "finance.manual_expense.archive") }), [String(value.commandId).toLowerCase()]);
    return result.ok ? sendExpenseWrite(reply, current, options, result) : failure(reply, result.code);
  }));

  app.get(`${ROOT}/recurring-expenses/:ruleId`, { onRequest: read }, async (request, reply) => safe(reply, async () => {
    const ruleId = pathId(request, "ruleId"); if (!ruleId || !empty(request.query)) return bad(reply);
    return sendRead(reply, await options.read.recurringRule(scope(request).propertyId, ruleId), scope(request), "recurring", ruleId);
  }));
  app.patch(`${ROOT}/recurring-expenses/:ruleId`, { onRequest: write }, async (request, reply) => safe(reply, async () => {
    const value = recurrencePatch(request), current = scope(request), ruleId = pathId(request, "ruleId");
    if (!empty(request.query) || !value || !ruleId) return bad(reply);
    const result = recurringResult(await options.recurring.update({ ...value as Omit<UpdateFinanceRecurringExpenseRuleCommand, "propertyId" | "ruleId" | "audit">, propertyId: current.propertyId, ruleId, audit: audit(current, "finance.recurring_expense_rule.update") }), ruleId);
    return result.ok ? sendRecurringWrite(reply, current, options, result) : failure(reply, result.code);
  }));
  app.delete(`${ROOT}/recurring-expenses/:ruleId`, { onRequest: write }, async (request, reply) => safe(reply, async () => {
    const value = commandBody(request, REVISION, REVISION), current = scope(request), ruleId = pathId(request, "ruleId");
    if (!empty(request.query) || !value || !ruleId) return bad(reply);
    const result = recurringResult(await options.recurring.disable({ ...value as Omit<DisableFinanceRecurringExpenseRuleCommand, "propertyId" | "ruleId" | "audit">, propertyId: current.propertyId, ruleId, audit: audit(current, "finance.recurring_expense_rule.disable") }), ruleId);
    return result.ok ? sendRecurringWrite(reply, current, options, result) : failure(reply, result.code);
  }));
}

// prettier-ignore
function authorize(scopes: WeakMap<FastifyRequest, Scope>, permission: "pms.finance.read" | "pms.finance.manage") {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      let context = enforceRoutePolicy(request, { permission });
      if (context.selectedOrganization.kind !== "hotel_group") return void reply.status(403).send({ code: "forbidden" });
      const propertyId = canonicalUuid((request.params as Partial<Params>).propertyId); if (!propertyId) return void bad(reply);
      const resource = { product: "pms" as const, resourceType: "pms_property" as const, resourceId: propertyId };
      for (const key of ["property-management", "module:financials"]) context = enforceRoutePolicy(request, { permission, entitlement: { product: "pms", key, resource }, resource: { ...resource, allowedRelationships: ["owner", "finance_manager"] } });
      reply.header("Cache-Control", "private, no-store").header("Vary", "Authorization");
      scopes.set(request, { context, propertyId, canRead: context.membership.permissions.includes("pms.finance.read") });
    } catch (cause) {
      if (cause instanceof UnauthorizedError) return void reply.status(401).send({ code: "unauthenticated" });
      if (cause instanceof AuthorizationError) return void reply.status(403).send({ code: "forbidden" });
      throw cause;
    }
  };
}

// prettier-ignore
const audit = (scope: Scope, reason: string): FinanceCommandAudit => ({ actor: { kind: "user", userId: scope.context.actor.internalUserId, organizationId: scope.context.selectedOrganization.organizationId }, requestId: scope.context.audit.requestId, correlationId: scope.context.audit.correlationId, reason, requestedAt: scope.context.audit.receivedAt });
// prettier-ignore
type Success = { ok: true; outcome: "created" | "updated" | "replayed"; item: Record<string, unknown> };
type Failed = { ok: false; code: string };

// prettier-ignore
async function sendCategoryWrite(reply: FastifyReply, scope: Scope, options: FinanceExpenseRoutesOptions, result: Success) {
  if (!scope.canRead) return receipt(reply, scope, result);
  const read = await options.read.categories(scope.propertyId); if (!validEnvelope(read, scope.propertyId, "categories")) return violation(reply);
  const item = read.item.find((candidate: Record<string, unknown>) => candidate.id === result.item.id); if (!item) return violation(reply);
  return response(reply, read, item, result.outcome);
}
// prettier-ignore
async function sendExpenseWrite(reply: FastifyReply, scope: Scope, options: FinanceExpenseRoutesOptions, result: Success) {
  if (!scope.canRead) return receipt(reply, scope, result);
  const read = await options.read.expense(scope.propertyId, String(result.item.id)); if (!validEnvelope(read, scope.propertyId, "expense", String(result.item.id))) return violation(reply);
  return response(reply, read, read.item, result.outcome);
}
// prettier-ignore
async function sendRecurringWrite(reply: FastifyReply, scope: Scope, options: FinanceExpenseRoutesOptions, result: Success) {
  if (!scope.canRead) return receipt(reply, scope, result);
  const read = await options.read.recurringRule(scope.propertyId, String(result.item.id)); if (!validEnvelope(read, scope.propertyId, "recurring", String(result.item.id))) return violation(reply);
  return response(reply, read, read.item, result.outcome);
}
// prettier-ignore
function sendRead(reply: FastifyReply, value: unknown, scope: Scope, kind: ReadKind, id?: string) {
  if (value === null) return missing(reply);
  return validEnvelope(value, scope.propertyId, kind, id) ? reply.send(value) : violation(reply);
}
// prettier-ignore
function response(reply: FastifyReply, read: Record<string, unknown>, item: unknown, outcome: Success["outcome"]) {
  const { item: _item, ...envelope } = read;
  return reply.status(outcome === "created" ? 201 : 200).send({ ...envelope, item, outcome });
}
// prettier-ignore
function receipt(reply: FastifyReply, scope: Scope, result: Success) { return reply.status(result.outcome === "created" ? 201 : 200).send({ contractVersion: PMS_FINANCIALS_CONTRACT_VERSION, propertyId: scope.propertyId, resourceId: result.item.id, outcome: result.outcome }); }

// prettier-ignore
function categoryResult(value: unknown, expectedId?: string): Success | Failed {
  if (!record(value) || typeof value.status !== "string") return portFailure();
  if (["not_found", "blocked", "conflict"].includes(value.status)) return exact(value, value.status === "not_found" ? ["status"] : ["status", "reason"]) && (value.status === "not_found" || CATEGORY_FAILURES.includes(value.reason)) ? { ok: false, code: value.status === "not_found" ? "not_found" : String(value.reason) } : portFailure();
  if (!exact(value, ["status", "category"]) || !["created", "updated", "replayed"].includes(value.status) || !category(value.category) || (expectedId && value.category.id !== expectedId)) return portFailure();
  return { ok: true, outcome: value.status as Success["outcome"], item: value.category };
}
// prettier-ignore
function expenseResult(value: unknown, expectedIds: string[]): Success | Failed { return commandResult(value, expectedIds, expense, ["created", "updated", "corrected", "archived", "replayed"]); }
// prettier-ignore
function recurringResult(value: unknown, expectedId: string): Success | Failed { return commandResult(value, [expectedId], recurring, ["created", "updated", "replayed"]); }
// prettier-ignore
function commandResult(value: unknown, expectedIds: string[], item: (value: unknown) => value is Record<string, unknown>, outcomes: string[]): Success | Failed {
  if (!record(value) || typeof value.ok !== "boolean") return portFailure();
  if (!value.ok) return exact(value, ["ok", "code"]) && FAILURES.includes(value.code) ? { ok: false, code: String(value.code) } : portFailure();
  if (!exact(value, ["ok", "outcome", "item"]) || typeof value.outcome !== "string" || !outcomes.includes(value.outcome) || !item(value.item) || !expectedIds.includes(String(value.item.id))) return portFailure();
  return { ok: true, outcome: value.outcome === "created" || value.outcome === "replayed" ? value.outcome : "updated", item: value.item };
}
// prettier-ignore
function portFailure(): never { throw new Error("finance_expense_port_contract_violation"); }

type ReadKind = "categories" | "expense" | "expenses" | "recurring";
// prettier-ignore
const BASE = ["contractVersion", "propertyId", "currency", "timeZone", "generatedAt", "sourceFreshness", "incompleteEvidence"];
// prettier-ignore
function validEnvelope(value: unknown, propertyId: string, kind: ReadKind, id?: string): value is Record<string, any> {
  if (!record(value) || value.contractVersion !== PMS_FINANCIALS_CONTRACT_VERSION || value.propertyId !== propertyId || !currency(value.currency) || !zone(value.timeZone) || !utc(value.generatedAt) || !stringRecord(value.sourceFreshness) || !Array.isArray(value.incompleteEvidence) || !value.incompleteEvidence.every(incomplete)) return false;
  if (kind === "categories") return exact(value, [...BASE, "item"]) && Array.isArray(value.item) && value.item.every(category);
  if (kind === "expense") return exact(value, [...BASE, "item"]) && expense(value.item) && value.item.id === id;
  if (kind === "recurring") return exact(value, [...BASE, "item"]) && recurring(value.item) && value.item.id === id;
  return exact(value, [...BASE, "summary", "categories", "page"]) && summary(value.summary, value.currency) && Array.isArray(value.categories) && value.categories.every((entry: unknown) => record(entry) && exact(entry, ["category", "amount"]) && category(entry.category) && money(entry.amount, value.currency)) && record(value.page) && exact(value.page, ["items", "nextCursor", "limit"]) && Array.isArray(value.page.items) && value.page.items.every(expense) && (value.page.nextCursor === null || text(value.page.nextCursor, 2, 4096)) && integer(value.page.limit, 1, 200);
}
// prettier-ignore
function category(value: unknown): value is Record<string, any> { return record(value) && exact(value, ["id", "systemKey", "name", "color", "sortOrder", "archived", "revision"]) && uuid(value.id) && (value.systemKey === null || text(value.systemKey, 1, 100)) && text(value.name, 1, 120) && typeof value.color === "string" && /^#[0-9A-Fa-f]{6}$/.test(value.color) && integer(value.sortOrder, 0) && typeof value.archived === "boolean" && integer(value.revision, 1); }
// prettier-ignore
function expense(value: unknown): value is Record<string, any> { return record(value) && exact(value, ["id", "categoryId", "origin", "incurredOn", "paidOn", "vendor", "amount", "paymentStatus", "recurringRuleId", "sourceKey", "reversesExpenseId", "revision"]) && uuid(value.id) && uuid(value.categoryId) && FINANCE_EXPENSE_ORIGINS.includes(value.origin as never) && date(value.incurredOn) && text(value.vendor, 1, 200) && money(value.amount) && ((value.paymentStatus === "paid" && date(value.paidOn)) || (value.paymentStatus === "unpaid" && value.paidOn === null)) && [value.recurringRuleId, value.reversesExpenseId].every((part) => part === null || uuid(part)) && (value.sourceKey === null || text(value.sourceKey, 1, 250)) && integer(value.revision, 1); }
// prettier-ignore
function recurring(value: unknown): value is Record<string, any> { return record(value) && exact(value, ["id", "categoryId", "vendor", "amount", "notes", "paymentStatus", "cadence", "startsOn", "nextDueOn", "endsOn", "active", "revision"], true) && uuid(value.id) && uuid(value.categoryId) && text(value.vendor, 1, 200) && money(value.amount) && (value.notes === undefined || text(value.notes, 1, 2000)) && FINANCE_EXPENSE_PAYMENT_STATUSES.includes(value.paymentStatus as never) && FINANCE_EXPENSE_CADENCES.includes(value.cadence as never) && date(value.startsOn) && date(value.nextDueOn) && value.nextDueOn >= value.startsOn && (value.endsOn === null || (date(value.endsOn) && value.endsOn >= value.nextDueOn)) && typeof value.active === "boolean" && integer(value.revision, 1); }
// prettier-ignore
function summary(value: unknown, currencyCode: string): boolean { return record(value) && exact(value, ["totalMtd", "perOccupiedNight", "unpaidAmount", "unpaidCount"]) && [value.totalMtd, value.perOccupiedNight, value.unpaidAmount].every((metric) => moneyMetric(metric, currencyCode)) && countMetric(value.unpaidCount); }
// prettier-ignore
function moneyMetric(value: unknown, currencyCode: string): boolean { return record(value) && exact(value, ["value", "absoluteChange", "percentChange"]) && money(value.value, currencyCode) && money(value.absoluteChange, currencyCode) && (value.percentChange === null || decimal(value.percentChange)); }
// prettier-ignore
function countMetric(value: unknown): boolean { return record(value) && exact(value, ["value", "absoluteChange", "percentChange"]) && integer(value.value, 0) && Number.isSafeInteger(value.absoluteChange) && (value.percentChange === null || decimal(value.percentChange)); }
// prettier-ignore
function incomplete(value: unknown): boolean { return record(value) && exact(value, ["code", "count", "amount"], true) && text(value.code, 1, 100) && integer(value.count, 0) && (value.amount === undefined || money(value.amount)); }

// prettier-ignore
function categoryBody(request: FastifyRequest, patch: boolean) { const fields = ["name", "color", "sortOrder"] as const, value = commandBody(request, patch ? [...REVISION, ...fields] : [...COMMAND, ...fields], patch ? REVISION : [...COMMAND, ...fields]); if (!value || (patch && !fields.some((key) => Object.hasOwn(value, key)))) return null; return (value.name === undefined || text(value.name, 1, 120)) && (value.color === undefined || (typeof value.color === "string" && /^#[0-9A-Fa-f]{6}$/.test(value.color))) && (value.sortOrder === undefined || integer(value.sortOrder, 0)) ? value : null; }
// prettier-ignore
function expensePatch(request: FastifyRequest) { const fields = ["incurredOn", "vendor", "categoryId", "amount", "paymentStatus", "paidOn", "notes", "supplierInvoiceNumber"] as const, value = commandBody(request, [...REVISION, ...fields], REVISION); if (!value || !fields.some((key) => Object.hasOwn(value, key))) return null; const status = Object.hasOwn(value, "paymentStatus"), paidOn = Object.hasOwn(value, "paidOn"); if ((!status && paidOn) || (value.paymentStatus === "paid" && (!paidOn || !date(value.paidOn))) || (value.paymentStatus === "unpaid" && paidOn && value.paidOn !== null)) return null; const valid = (key: typeof fields[number], part: unknown) => key === "incurredOn" ? date(part) : key === "paidOn" ? part === null || date(part) : key === "vendor" ? text(part, 1, 200) : key === "categoryId" ? uuid(part) : key === "amount" ? requestMoney(part) : key === "paymentStatus" ? FINANCE_EXPENSE_PAYMENT_STATUSES.includes(part as never) : key === "notes" ? text(part, 1, 2000) : text(part, 1, 200); if (!fields.every((key) => !Object.hasOwn(value, key) || valid(key, value[key]))) return null; if (value.paymentStatus === "unpaid" && value.paidOn === null) delete value.paidOn; return value; }
// prettier-ignore
function recurrencePatch(request: FastifyRequest) { const fields = ["categoryId", "vendor", "amount", "notes", "paymentStatus", "cadence", "nextDueOn", "endsOn"] as const, value = commandBody(request, [...REVISION, ...fields], REVISION); if (!value || !fields.some((key) => Object.hasOwn(value, key))) return null; const valid = (key: typeof fields[number], part: unknown) => key === "categoryId" ? uuid(part) : key === "vendor" ? text(part, 1, 200) : key === "amount" ? requestMoney(part) : key === "notes" ? part === null || text(part, 1, 2000) : key === "paymentStatus" ? FINANCE_EXPENSE_PAYMENT_STATUSES.includes(part as never) : key === "cadence" ? FINANCE_EXPENSE_CADENCES.includes(part as never) : key === "endsOn" ? part === null || date(part) : date(part); return fields.every((key) => !Object.hasOwn(value, key) || valid(key, value[key])) ? value : null; }
// prettier-ignore
function commandBody(request: FastifyRequest, allowed: readonly string[], required: readonly string[]) { const value = request.body; if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) return null; const commandId = canonicalUuid(value.commandId); if (!commandId || !text(value.idempotencyKey, 1, 200) || !headerMatches(request, value.idempotencyKey)) return null; value.commandId = commandId; return value.expectedRevision === undefined || integer(value.expectedRevision, 1) ? value : null; }
// prettier-ignore
function headerMatches(request: FastifyRequest, key: string) { const header = request.headers["idempotency-key"]; if (header === undefined) return true; const count = request.raw.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === "idempotency-key").length; return count === 1 && typeof header === "string" && header === key; }

// prettier-ignore
function pathId(request: FastifyRequest, key: keyof Params) { return canonicalUuid((request.params as Params)[key]); }
// prettier-ignore
function canonicalUuid(value: unknown) { return typeof value === "string" && UUID.test(value.toLowerCase()) ? value.toLowerCase() : null; }
// prettier-ignore
function uuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
// prettier-ignore
function record(value: unknown): value is Record<string, any> { return value !== null && typeof value === "object" && !Array.isArray(value); }
// prettier-ignore
function exact(value: Record<string, any>, keys: string[], optional = false) { const actual = Object.keys(value); return actual.every((key) => keys.includes(key)) && (optional ? keys.filter((key) => key !== "notes" && key !== "amount").every((key) => Object.hasOwn(value, key)) : actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))); }
// prettier-ignore
function empty(value: unknown) { return record(value) && Object.keys(value).length === 0; }
// prettier-ignore
function text(value: unknown, min: number, max: number): value is string { return typeof value === "string" && value === value.trim() && value.length >= min && value.length <= max; }
// prettier-ignore
function integer(value: unknown, min: number, max = 2_147_483_647) { return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max; }
// prettier-ignore
function date(value: unknown): value is string { if (typeof value !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false; const parsed = new Date(`${value}T00:00:00Z`); return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value; }
// prettier-ignore
function utc(value: unknown): value is string { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false; const parsed = new Date(value); return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19); }
// prettier-ignore
function decimal(value: unknown) { return typeof value === "string" && /^-?\d+(?:\.\d{1,4})?$/.test(value); }
// prettier-ignore
function currency(value: unknown): value is string { return typeof value === "string" && /^[A-Z]{3}$/.test(value); }
// prettier-ignore
function requestMoney(value: unknown) { if (!record(value) || !exact(value, ["amount", "currency"]) || typeof value.amount !== "string" || !currency(value.currency)) return false; const amount = normalizeFinanceExpenseAmount(value.amount); if (!amount) return false; value.amount = amount; return true; }
// prettier-ignore
function zone(value: unknown): value is string { try { return typeof value === "string" && new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone === value; } catch { return false; } }
// prettier-ignore
function money(value: unknown, expectedCurrency?: string) { return record(value) && exact(value, ["amount", "currency"]) && typeof value.amount === "string" && /^-?(?:0|[1-9]\d{0,14})\.\d{4}$/.test(value.amount) && currency(value.currency) && (!expectedCurrency || value.currency === expectedCurrency); }
// prettier-ignore
function stringRecord(value: unknown) { return record(value) && Object.entries(value).every(([key, part]) => text(key, 1, 100) && text(part, 1, 200)); }

// prettier-ignore
function validReceipt(value: FinanceExpenseReceipt, propertyId: string, expenseId: string) { const keys = ["mediaId", "propertyId", "resourceId", "purpose", "resourceProduct", "resourceType", "visibility", "lifecycleStatus", "bucketName", "storageKey", "originalFilename", "contentType"]; return record(value) && Object.keys(value).every((key) => keys.includes(key)) && keys.slice(0, 10).every((key) => Object.hasOwn(value, key)) && uuid(value.mediaId) && value.propertyId === propertyId && value.resourceId === expenseId && value.purpose === "finance.expense.receipt" && value.resourceProduct === "finance" && value.resourceType === "expense" && value.visibility === "private" && value.lifecycleStatus === "active" && text(value.bucketName, 1, 200) && text(value.storageKey, 1, 1024) && (value.originalFilename === undefined || text(value.originalFilename, 1, 500)) && (value.contentType === undefined || text(value.contentType, 1, 200)); }
function secureUrl(value: unknown) {
  try {
    return typeof value === "string" && new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

// prettier-ignore
async function safe(reply: FastifyReply, work: () => Promise<unknown>) { try { return await work(); } catch (cause) { if (cause instanceof FinanceExpenseCursorError) return bad(reply, cause.code); if (cause instanceof FinanceExpenseEvidenceError) return reply.status(422).send({ code: cause.code }); return violation(reply); } }
const bad = (reply: FastifyReply, code = "invalid_request") => reply.status(400).send({ code });
const missing = (reply: FastifyReply) => reply.status(404).send({ code: "not_found" });
// prettier-ignore
function failure(reply: FastifyReply, code: string) { if (code === "invalid_command") return bad(reply, code); if (code === "not_found") return missing(reply); if (["currency_mismatch", "evidence_mismatch", "write_unavailable"].includes(code)) return reply.status(422).send({ code }); return reply.status(409).send({ code }); }
// prettier-ignore
const violation = (reply: FastifyReply) => reply.status(500).send({ code: "finance_expense_port_contract_violation" });
