import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0146_pms_inbox_assistance_results.sql"),
  "utf8",
);

describe("native guest Inbox assistance result schema", () => {
  it("keeps replayable assisted text private, scoped, and purgeable", () => {
    expect(migration).toContain("CREATE TABLE pms.message_assistance_results");
    expect(migration).toContain("FOREIGN KEY (thread_id, property_id)");
    expect(migration).toContain(
      "REFERENCES pms.message_threads(id, property_id) ON DELETE CASCADE",
    );
    expect(migration).toContain("FOREIGN KEY (idempotency_key_id, scope_key)");
    expect(migration).toContain("REFERENCES platform.idempotency_keys(id, scope_key)");
    expect(migration).toContain("pii_retention_until TIMESTAMPTZ NOT NULL");
    expect(migration).toContain("purged_at TIMESTAMPTZ");
    expect(migration).toContain("purged_at IS NOT NULL AND purged_at >= pii_retention_until");
    expect(migration).toContain("assisted_text IS NULL");
    expect(migration).toContain("This is not a guest message");
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION pms.purge_expired_message_assistance_results",
    );
    expect(migration).toContain("pii_retention_until <= LEAST(cutoff, CURRENT_TIMESTAMP)");
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION pms.purge_expired_message_assistance_results(TIMESTAMPTZ)",
    );
    expect(migration).toContain(
      "Historical message boundary identifier retained even when the source message is deleted",
    );
    expect(migration).not.toContain("fk_pms_message_assistance_result_boundary_property");
  });

  it("reuses canonical idempotency and audit infrastructure", () => {
    expect(migration).not.toMatch(/CREATE TABLE pms\.[a-z_]*idempotency/i);
    expect(migration).not.toMatch(/CREATE TABLE pms\.[a-z_]*audit/i);
  });
});
