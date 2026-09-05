import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0150_channex_message_webhook_retention.sql"),
  "utf8",
);

describe("Channex guest-message webhook retention", () => {
  it("bounds and purges only raw Channex message evidence", () => {
    expect(migration).toContain("provider = 'channex' AND event_type = 'message'");
    expect(migration).toContain("received_at + INTERVAL '30 days'");
    expect(migration).toContain("purge_expired_channex_message_webhook_receipts");
    expect(migration).toContain("job.payload - 'rawPayload'");
    expect(migration).toContain("event.payload - 'rawPayload'");
    expect(migration).toContain("trg_platform_domain_events_append_only");
    expect(migration).toContain("raw_headers = '{}'::jsonb");
    expect(migration).toContain("raw_payload = '{}'::jsonb");
    expect(migration).toContain("is_security_quarantine_purge");
    expect(migration).toContain("provider_thread_property_mismatch");
    expect(migration).toContain("REVOKE ALL ON FUNCTION");
  });
});
