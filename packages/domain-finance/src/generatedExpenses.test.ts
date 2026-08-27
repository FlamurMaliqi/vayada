import { describe, expect, it } from "vitest";

import {
  FINANCE_GENERATED_EXPENSE_MISSING_EVIDENCE,
  FINANCE_GENERATED_EXPENSE_ORIGINS,
  FINANCE_GENERATED_EXPENSE_OUTCOMES,
  financeGeneratedExpenseFingerprint,
  financeGeneratedExpenseJobKey,
  financeGeneratedExpenseRedactedAuditEvidence,
  financeGeneratedExpenseSourceKey,
  parseFinanceGeneratedExpenseCommand,
  type FinanceGeneratedExpenseSource,
} from "./generatedExpenses.js";

// prettier-ignore
const ID = { command: "10000000-0000-4000-8000-000000000001", property: "20000000-0000-4000-8000-000000000001", category: "30000000-0000-4000-8000-000000000001", rule: "40000000-0000-4000-8000-000000000001", evidence: "50000000-0000-4000-8000-000000000001", resource: "60000000-0000-4000-8000-000000000001", reversed: "70000000-0000-4000-8000-000000000001", job: "80000000-0000-4000-8000-000000000001", attempt: "90000000-0000-4000-8000-000000000001", causation: "a0000000-0000-4000-8000-000000000001" } as const;
// prettier-ignore
const audit = { actor: { kind: "system", service: "finance-expense-automation" }, requestId: "request-1", correlationId: "finance-generation-1", causationId: ID.causation, jobId: ID.job, jobAttemptId: ID.attempt, reasonCode: "scheduled_generation", requestedAt: "2026-08-11T12:00:00.000Z" } as const;
// prettier-ignore
const sources = [
  { kind: "recurring", recurringRuleId: ID.rule, ruleRevision: 2, occurrenceOn: "2026-08-11" },
  { kind: "ota_commission", commissionEvidenceId: ID.evidence, guestBookingId: ID.resource, serviceNight: "2026-08-11" },
  { kind: "platform_fee", providerFeeEvidenceId: ID.evidence, paymentId: ID.resource, evidenceOn: "2026-08-11" },
] as const satisfies readonly FinanceGeneratedExpenseSource[];

function command(
  source: FinanceGeneratedExpenseSource,
  action: "create" | "correct" | "reverse" = "create",
) {
  // prettier-ignore
  const sourceDate = source.kind === "recurring" ? source.occurrenceOn : source.kind === "ota_commission" ? source.serviceNight : source.evidenceOn;
  // prettier-ignore
  return { commandId: ID.command, propertyId: ID.property, categoryId: ID.category,
    origin: source.kind, action, incurredOn: action === "create" ? sourceDate : "2026-08-12",
    vendor: "Automated vendor", description: "private ledger note", amount: { amount: "12.5", currency: "EUR" },
    paymentStatus: "unpaid", paidOn: null, reversesExpenseId: action === "create" ? null : ID.reversed, source,
    audit: { ...audit, reasonCode: action === "create" ? "scheduled_generation" : action === "correct" ? "source_correction" : "source_reversal" } };
}

describe("generated Financials expense contract", () => {
  it("publishes the complete origin, outcome, and missing-evidence catalogs", () => {
    expect(FINANCE_GENERATED_EXPENSE_ORIGINS).toEqual([
      "recurring",
      "ota_commission",
      "platform_fee",
    ]);
    // prettier-ignore
    expect(FINANCE_GENERATED_EXPENSE_OUTCOMES).toEqual(["created", "replayed", "corrected", "reversed", "ineligible", "missing_evidence", "rejected"]);
    // prettier-ignore
    expect(FINANCE_GENERATED_EXPENSE_MISSING_EVIDENCE).toEqual(["ota_commission_missing_gross", "ota_commission_missing_rule", "ota_commission_missing_rule_and_gross", "ota_commission_ambiguous_rule", "ota_commission_ambiguous_rule_and_gross", "provider_fee_missing"]);
  });

  it.each(sources)("parses and canonicalizes $kind commands", (source) => {
    // prettier-ignore
    const equivalent = source.kind === "recurring" ? { occurrenceOn: source.occurrenceOn, ruleRevision: source.ruleRevision, recurringRuleId: source.recurringRuleId.toUpperCase(), kind: source.kind } : source.kind === "ota_commission" ? { serviceNight: source.serviceNight, guestBookingId: source.guestBookingId, commissionEvidenceId: source.commissionEvidenceId.toUpperCase(), kind: source.kind } : { evidenceOn: source.evidenceOn, paymentId: source.paymentId, providerFeeEvidenceId: source.providerFeeEvidenceId.toUpperCase(), kind: source.kind };
    const input = command(equivalent);
    // prettier-ignore
    const parsed = parseFinanceGeneratedExpenseCommand({ ...input, commandId: input.commandId.toUpperCase(), amount: { currency: "EUR", amount: "12.5000" } })!;
    const canonical = parseFinanceGeneratedExpenseCommand(command(source))!;
    expect(parsed.origin).toBe(source.kind);
    expect(parsed.commandId).toBe(ID.command);
    expect(parsed.amount).toEqual({ amount: "12.5000", currency: "EUR" });
    expect(financeGeneratedExpenseSourceKey(parsed)).toBe(
      financeGeneratedExpenseSourceKey(canonical),
    );
    expect(financeGeneratedExpenseJobKey(parsed)).toBe(financeGeneratedExpenseJobKey(canonical));
    expect(financeGeneratedExpenseFingerprint(parsed)).toBe(
      financeGeneratedExpenseFingerprint(canonical),
    );
    expect(financeGeneratedExpenseSourceKey(parsed).length).toBeLessThanOrEqual(200);
    expect(financeGeneratedExpenseJobKey(parsed).length).toBeLessThanOrEqual(200);
    // prettier-ignore
    const malformed = source.kind === "recurring" ? { ...source, recurringRuleId: "invalid" } : source.kind === "ota_commission" ? { ...source, commissionEvidenceId: "invalid" } : { ...source, providerFeeEvidenceId: "invalid" };
    expect(
      parseFinanceGeneratedExpenseCommand(command(malformed as FinanceGeneratedExpenseSource)),
    ).toBeNull();
  });

  it("builds canonical jobs/events identities", () => {
    const commands = sources.map((source) => parseFinanceGeneratedExpenseCommand(command(source))!);
    expect(financeGeneratedExpenseSourceKey(commands[0]!)).toBe(
      `recurring_rule:${ID.rule}:occurrence:2026-08-11`,
    );
    expect(financeGeneratedExpenseJobKey(commands[1]!)).toBe(
      `finance.generate-expense:ota_commission_evidence:${ID.evidence}:project:v1`,
    );
    expect(financeGeneratedExpenseSourceKey(commands[2]!)).toBe(
      `provider_fee_evidence:${ID.evidence}`,
    );
  });

  it("fingerprints business evidence while linking distinct retry attempts", () => {
    const first = command(sources[1]);
    // prettier-ignore
    const retry = { ...first, audit: { ...first.audit, requestId: "request-2", jobAttemptId: "90000000-0000-4000-8000-000000000002" } };
    expect(financeGeneratedExpenseFingerprint(retry)).toBe(
      financeGeneratedExpenseFingerprint(first),
    );
    expect(financeGeneratedExpenseFingerprint({ ...retry, vendor: "Changed" })).not.toBe(
      financeGeneratedExpenseFingerprint(first),
    );
    // prettier-ignore
    expect(parseFinanceGeneratedExpenseCommand(retry)?.audit).toMatchObject({ causationId: ID.causation, jobId: ID.job, jobAttemptId: "90000000-0000-4000-8000-000000000002" });
  });

  it("exposes only bounded, non-free-form redacted audit evidence", () => {
    const evidence = financeGeneratedExpenseRedactedAuditEvidence(command(sources[1]))!;
    // prettier-ignore
    expect(evidence).toMatchObject({ actorService: "finance-expense-automation", reasonCode: "scheduled_generation", jobId: ID.job, jobAttemptId: ID.attempt });
    expect(JSON.stringify(evidence)).not.toContain("Automated vendor");
    expect(JSON.stringify(evidence)).not.toContain("private ledger note");
  });

  it.each(["correct", "reverse"] as const)("requires an append-only %s reference", (action) => {
    const parsed = parseFinanceGeneratedExpenseCommand(command(sources[1], action))!;
    expect(financeGeneratedExpenseSourceKey(parsed)).toContain(`:${action}:${ID.reversed}`);
    expect(financeGeneratedExpenseJobKey(parsed)).toContain(`:${action}-${ID.reversed}:v1`);
    expect(
      parseFinanceGeneratedExpenseCommand({
        ...command(sources[1], action),
        reversesExpenseId: null,
      }),
    ).toBeNull();
  });

  it.each([
    { amount: { amount: "0", currency: "EUR" } },
    { amount: { amount: "1", currency: "eur" } },
    { incurredOn: "2026-02-30" },
    { incurredOn: "2026-08-12" },
    { origin: "platform_fee" },
    { paymentStatus: "paid" },
    { audit: { ...audit, reasonCode: "source_reversal" } },
    { audit: { ...audit, jobAttemptId: ID.job } },
    { audit: { ...audit, reason: "guest@example.com" } },
    { audit: { ...audit, causationId: "guest@example.com" } },
    { audit: { ...audit, causationId: "x".repeat(201) } },
    { source: { ...sources[0], ruleRevision: 0 } },
    { surprise: true },
  ])("rejects malformed, mismatched, unbounded, or privacy-unsafe input %#", (change) => {
    expect(parseFinanceGeneratedExpenseCommand({ ...command(sources[0]), ...change })).toBeNull();
  });
});
