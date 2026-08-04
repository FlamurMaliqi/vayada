import { describe, expect, it } from "vitest";

import {
  createPgPmsMandatoryChargeConfirmationReadModel,
  type PmsMandatoryChargeConfirmationReadPool,
} from "./domains/pmsMandatoryChargeConfirmationReadModel.js";

const organizationId = "123e4567-e89b-42d3-a456-426614174000";
const propertyId = "223e4567-e89b-42d3-a456-426614174000";
const confirmedAt = "2026-08-04T10:00:00.000Z";
const fingerprint = "a".repeat(64);

function row(overrides: Record<string, unknown> = {}) {
  return {
    organizationId,
    propertyId,
    pricingSourceFingerprint: fingerprint,
    confirmationRevision: "3",
    confirmedAt: new Date(confirmedAt),
    ...overrides,
  };
}

function dependencies(input: { rows?: unknown[]; error?: Error } = {}) {
  const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
  let ended = 0;
  const pool = {
    async query(text: string, values?: readonly unknown[]) {
      queries.push({ text, values });
      if (input.error) throw input.error;
      const rows = input.rows ?? [row()];
      return { rows, rowCount: rows.length } as never;
    },
    async end() {
      ended += 1;
    },
  } satisfies PmsMandatoryChargeConfirmationReadPool;
  return { pool, queries, ended: () => ended };
}

function model(input: { rows?: unknown[]; error?: Error } = {}) {
  const deps = dependencies(input);
  return {
    deps,
    readModel: createPgPmsMandatoryChargeConfirmationReadModel({
      connectionString: "postgresql://unused",
      pool: deps.pool,
    }),
  };
}

describe("PMS mandatory-charge confirmation read model", () => {
  it("returns the latest exact organization/property evidence", async () => {
    const { readModel, deps } = model();
    await expect(
      readModel.getMandatoryChargeConfirmation({
        organizationId: organizationId.toUpperCase(),
        propertyId: propertyId.toUpperCase(),
      }),
    ).resolves.toEqual({
      organizationId,
      propertyId,
      outcome: "available",
      evidence: {
        organizationId,
        propertyId,
        pricingSourceFingerprint: fingerprint,
        confirmationRevision: 3,
        confirmedAt,
      },
    });
    expect(deps.queries[0]?.values).toEqual([organizationId, propertyId]);
    expect(deps.queries[0]?.text).toContain("ORDER BY confirmation.confirmation_revision DESC");
    expect(deps.queries[0]?.text).toContain("LIMIT 1");
  });

  it("returns missing when no scoped evidence is available", async () => {
    const { readModel } = model({ rows: [] });
    await expect(
      readModel.getMandatoryChargeConfirmation({ organizationId, propertyId }),
    ).resolves.toEqual({ organizationId, propertyId, outcome: "missing" });
  });

  it.each([
    ["organization", { organizationId: "323e4567-e89b-42d3-a456-426614174000" }],
    ["property", { propertyId: "323e4567-e89b-42d3-a456-426614174000" }],
    ["fingerprint", { pricingSourceFingerprint: "A".repeat(64) }],
    ["revision", { confirmationRevision: "0" }],
    ["timestamp", { confirmedAt: "provider-secret" }],
  ])("returns malformed for invalid stored %s evidence", async (_name, overrides) => {
    const { readModel } = model({ rows: [row(overrides)] });
    await expect(
      readModel.getMandatoryChargeConfirmation({ organizationId, propertyId }),
    ).resolves.toEqual({ organizationId, propertyId, outcome: "malformed" });
  });

  it("returns system unavailable without leaking database error details", async () => {
    const { readModel } = model({ error: new Error("password=must-not-leak") });
    const result = await readModel.getMandatoryChargeConfirmation({ organizationId, propertyId });
    expect(result).toEqual({
      organizationId,
      propertyId,
      outcome: "unavailable",
      errorSource: "system",
    });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(JSON.stringify(result)).not.toContain("password");
  });

  it("keeps exact PMS authorization scope in the query", async () => {
    const { readModel, deps } = model({ rows: [] });
    await readModel.getMandatoryChargeConfirmation({ organizationId, propertyId });
    const sql = deps.queries[0]!.text;
    expect(sql).toContain("confirmation.organization_id = $1::uuid");
    expect(sql).toContain("confirmation.property_id = $2::uuid");
    expect(sql).toContain("organization.kind = 'hotel_group'");
    expect(sql).toContain("resource.relationship IN ('owner', 'operator')");
    expect(sql).toContain("entitlement.status = 'active'");
    expect(sql).toContain("entitlement.status = 'suspended'");
    expect(sql).not.toMatch(/\b(?:booking|finance)\./i);
    expect(sql).not.toMatch(/payload|request|secret/i);
  });

  it("rejects malformed requests before querying and leaves injected pools open", async () => {
    const { readModel, deps } = model();
    await expect(
      readModel.getMandatoryChargeConfirmation({ organizationId, propertyId: "not-a-uuid" }),
    ).rejects.toThrow("PMS mandatory-charge confirmation read scope is malformed");
    expect(deps.queries).toEqual([]);
    await readModel.close();
    expect(deps.ended()).toBe(0);
  });
});
