import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/0047_booking_publication_attempts.sql", import.meta.url),
  "utf8",
);

describe("Booking publication attempt target schema", () => {
  it("ties an accepted attempt to idempotency, event, and outbox records", () => {
    expect(migration).toContain("REFERENCES platform.idempotency_keys(id)");
    expect(migration).toContain("REFERENCES platform.domain_events(id, property_id)");
    expect(migration).toContain("REFERENCES platform.outbox_events(id, domain_event_id)");
    expect(migration).toContain("request_fingerprint_hash");
    expect(migration).toContain("expected_active_content_revision_id");
  });

  it("keeps uncertain work open and success evidence constrained", () => {
    expect(migration).toContain("'pending', 'succeeded', 'failed', 'unknown'");
    expect(migration).toContain("status = 'succeeded' AND result_content_revision_id IS NOT NULL");
    expect(migration).toContain("chk_booking_publication_attempts_success_is_active");
    expect(migration).toContain("trg_booking_publication_attempts_validate_success");
    expect(migration).toContain("active.content_revision_id = NEW.result_content_revision_id");
    expect(migration).toContain("WHERE status IN ('pending', 'unknown')");
    expect(migration).toContain("'external_result_unconfirmed'");
    expect(migration).not.toContain("provider_error");
  });
});
