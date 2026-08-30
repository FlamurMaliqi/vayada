import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/0121_production_migration_provenance.sql", import.meta.url),
  "utf8",
);

describe("production migration provenance schema", () => {
  it("keeps immutable source identity after target deletion", () => {
    expect(migration).toContain("platform.production_migration_source_links");
    expect(migration).toContain("source_checksum ~ '^[0-9a-f]{64}$'");
    expect(migration).toContain("first_run_id ~ '^vay1351-[0-9a-f]{24}$'");
    expect(migration).toContain("PRIMARY KEY (");
    expect(migration).not.toMatch(/ON DELETE CASCADE/i);
  });

  it("does not store source payloads or guest PII", () => {
    expect(migration).not.toMatch(/payload|email|phone|passport|birth/i);
  });
});
