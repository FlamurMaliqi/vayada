import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0144_native_guest_inbox.sql"),
  "utf8",
);

describe("native guest Inbox target schema", () => {
  it("maps legacy workflow and channel values before tightening the contract", () => {
    const dataMigration = migration.indexOf("UPDATE pms.message_threads");
    const attentionConstraint = migration.indexOf("chk_pms_message_threads_attention_state");
    const channelNotNull = migration.indexOf("ALTER COLUMN delivery_channel SET NOT NULL");

    expect(dataMigration).toBeGreaterThan(-1);
    expect(dataMigration).toBeLessThan(attentionConstraint);
    expect(dataMigration).toBeLessThan(channelNotNull);
    expect(migration).toContain("'legacy_no_reply_needed'");
    expect(migration).toContain("WHEN source = 'channex' THEN 'ota'");
    expect(migration).toContain("WHEN source = 'manual' THEN 'email'");
    expect(migration).toContain(
      "lower(btrim(channel)) IN ('booking.com', 'booking_com', 'bookingcom', 'airbnb')",
    );
    expect(migration).toContain(
      "migrated PMS message threads require an explicit delivery channel",
    );
  });

  it("keeps thread state versioned, property-scoped, and assignment-safe", () => {
    expect(migration).toContain("ADD COLUMN version BIGINT NOT NULL DEFAULT 1");
    expect(migration).toContain("chk_pms_message_threads_attention_metadata");
    expect(migration).toContain("fk_pms_message_threads_follow_up_job_scope");
    expect(migration).toContain(
      "follow_up_by_membership_id IS NOT NULL AND follow_up_job_id IS NOT NULL",
    );
    expect(migration).toContain("fk_pms_message_thread_assignee_property_scope");
    expect(migration).toContain("identity.membership_property_assignments");
    expect(migration).toContain("REFERENCES pms.message_threads(id, property_id)");
  });

  it("adds private notes, quick replies, and canonical delivery evidence", () => {
    for (const table of [
      "pms.message_internal_notes",
      "pms.message_quick_replies",
      "pms.message_delivery_attempts",
      "pms.message_delivery_receipts",
    ]) {
      expect(migration).toContain(`CREATE TABLE ${table}`);
    }
    expect(migration).toContain("fk_pms_messages_accepted_idempotency_scope");
    expect(migration).toContain(
      "outcome IN ('running', 'accepted', 'transient_failure', 'terminal_failure')",
    );
    expect(migration).toContain("chk_pms_message_delivery_attempt_outbound");
    expect(migration).toContain("OLD.resolved_channel IS DISTINCT FROM NEW.resolved_channel");
    expect(migration).toContain("receipt_type IN ('delivered', 'read')");
    expect(migration).toContain("chk_pms_message_delivery_receipt_accepted_attempt");
    expect(migration).toContain("protect_pms_message_delivery_attempt_evidence");
    expect(migration).toContain("protect_pms_message_delivery_receipt_evidence");
    expect(migration).toContain("protect_pms_message_delivery_attempt_truncate");
    expect(migration).toContain("protect_pms_message_delivery_receipt_truncate");
    expect(migration).toContain(
      "FOREIGN KEY (message_id, property_id) REFERENCES pms.messages(id, property_id) ON DELETE RESTRICT",
    );
    expect(migration).toContain(
      "REFERENCES pms.message_delivery_attempts(id, message_id, property_id) ON DELETE RESTRICT",
    );
    expect(migration).not.toMatch(/CREATE TABLE pms\.[a-z_]*idempotency/i);
    expect(migration).not.toMatch(/CREATE TABLE pms\.[a-z_]*audit/i);
  });
});
