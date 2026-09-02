-- Migration: 0134_native_guest_inbox
-- Owner: domain-pms
-- See: engineering/native-guest-inbox-contract.md, VAY-1373
-- Production row counts and the resulting lock profile must be audited by VAY-1370
-- before this migration is scheduled against a live database.

ALTER TABLE pms.message_threads
  DROP CONSTRAINT IF EXISTS message_threads_status_check;

ALTER TABLE pms.message_threads
  ALTER COLUMN status DROP DEFAULT,
  ADD COLUMN version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  ADD COLUMN follow_up_at TIMESTAMPTZ,
  ADD COLUMN follow_up_by_membership_id UUID,
  ADD COLUMN follow_up_job_id UUID,
  ADD COLUMN done_at TIMESTAMPTZ,
  ADD COLUMN done_by_membership_id UUID,
  ADD COLUMN done_reason TEXT,
  ADD COLUMN assigned_to_membership_id UUID REFERENCES identity.organization_memberships(id)
    ON DELETE SET NULL,
  ADD COLUMN last_internal_note_at TIMESTAMPTZ,
  ADD COLUMN conversation_context_state TEXT NOT NULL DEFAULT 'unlinked',
  ADD COLUMN inquiry_arrival_date DATE,
  ADD COLUMN inquiry_departure_date DATE,
  ADD COLUMN inquiry_adults INTEGER CHECK (inquiry_adults IS NULL OR inquiry_adults >= 0),
  ADD COLUMN inquiry_children INTEGER CHECK (inquiry_children IS NULL OR inquiry_children >= 0),
  ADD COLUMN delivery_channel TEXT,
  ADD COLUMN scope_key TEXT GENERATED ALWAYS AS (
    platform.tenant_scope_key('property', NULL::UUID, property_id)
  ) STORED;

UPDATE pms.message_threads
SET done_at = CASE WHEN status IN ('closed', 'no_reply_needed') THEN updated_at END,
    done_reason = CASE status
      WHEN 'no_reply_needed' THEN 'legacy_no_reply_needed'
      WHEN 'closed' THEN 'legacy_closed'
    END,
    status = CASE WHEN status = 'open' THEN 'needs_attention' ELSE 'done' END,
    conversation_context_state = CASE
      WHEN guest_booking_id IS NOT NULL THEN 'linked'
      ELSE 'unlinked'
    END,
    delivery_channel = CASE
      WHEN source = 'manual' THEN 'email'
      WHEN source = 'channex' THEN 'ota'
      WHEN source = 'migration'
        AND lower(btrim(channel)) IN ('booking.com', 'booking_com', 'bookingcom', 'airbnb')
        THEN 'ota'
    END;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pms.message_threads WHERE delivery_channel IS NULL) THEN
    RAISE EXCEPTION 'migrated PMS message threads require an explicit delivery channel';
  END IF;
END;
$$;

ALTER TABLE pms.message_threads
  RENAME COLUMN status TO attention_state;
ALTER TABLE pms.message_threads
  RENAME COLUMN channel TO provider_channel;
ALTER TABLE pms.message_threads
  ALTER COLUMN attention_state SET DEFAULT 'needs_attention',
  ALTER COLUMN delivery_channel SET NOT NULL,
  ADD CONSTRAINT chk_pms_message_threads_attention_state
    CHECK (attention_state IN ('needs_attention', 'follow_up', 'done')),
  ADD CONSTRAINT chk_pms_message_threads_delivery_channel
    CHECK (delivery_channel IN ('ota', 'email')),
  ADD CONSTRAINT chk_pms_message_threads_context_state
    CHECK (conversation_context_state IN ('linked', 'inquiry', 'unlinked')),
  ADD CONSTRAINT chk_pms_message_threads_context_shape CHECK (
    (conversation_context_state = 'linked' AND guest_booking_id IS NOT NULL)
    OR (conversation_context_state <> 'linked' AND guest_booking_id IS NULL)
  ),
  ADD CONSTRAINT chk_pms_message_threads_attention_metadata CHECK (
    (attention_state = 'needs_attention' AND follow_up_at IS NULL
      AND follow_up_by_membership_id IS NULL AND follow_up_job_id IS NULL
      AND done_at IS NULL AND done_reason IS NULL)
    OR (attention_state = 'follow_up' AND follow_up_at IS NOT NULL
      AND follow_up_by_membership_id IS NOT NULL AND follow_up_job_id IS NOT NULL
      AND done_at IS NULL AND done_reason IS NULL)
    OR (attention_state = 'done' AND follow_up_at IS NULL
      AND follow_up_by_membership_id IS NULL AND follow_up_job_id IS NULL
      AND done_at IS NOT NULL)
  ),
  ADD CONSTRAINT fk_pms_message_threads_follow_up_job_scope
    FOREIGN KEY (follow_up_job_id, scope_key) REFERENCES platform.jobs(id, scope_key);

CREATE FUNCTION pms.enforce_message_thread_assignee_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.assigned_to_membership_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM identity.organization_memberships membership
    JOIN identity.organizations organization ON organization.id = membership.organization_id
    JOIN identity.organization_resource_links link
      ON link.organization_id = membership.organization_id
     AND link.product = 'pms'
     AND link.resource_type = 'pms_property'
     AND link.resource_id = NEW.property_id::text
     AND link.relationship IN ('owner', 'operator', 'front_desk')
     AND link.status = 'active'
    WHERE membership.id = NEW.assigned_to_membership_id
      AND membership.status = 'active'
      AND organization.status = 'active'
      AND (
        membership.property_access_mode = 'all'
        OR EXISTS (
          SELECT 1 FROM identity.membership_property_assignments assignment
          WHERE assignment.membership_id = membership.id
            AND assignment.property_id = NEW.property_id
        )
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      CONSTRAINT = 'fk_pms_message_thread_assignee_property_scope',
      MESSAGE = 'message thread assignee requires active access to the same property';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER fk_pms_message_thread_assignee_property_scope
AFTER INSERT OR UPDATE OF property_id, assigned_to_membership_id ON pms.message_threads
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION pms.enforce_message_thread_assignee_scope();

CREATE TABLE pms.message_internal_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
  thread_id UUID NOT NULL,
  author_membership_id UUID NOT NULL,
  author_display_name TEXT NOT NULL,
  body TEXT NOT NULL CHECK (btrim(body) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_pms_message_internal_notes_thread_property
    FOREIGN KEY (thread_id, property_id)
    REFERENCES pms.message_threads(id, property_id) ON DELETE CASCADE
);

CREATE TABLE pms.message_quick_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
  name TEXT NOT NULL CHECK (btrim(name) <> ''),
  body_template TEXT NOT NULL CHECK (btrim(body_template) <> ''),
  approved_variables TEXT[] NOT NULL DEFAULT '{}',
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_membership_id UUID NOT NULL,
  updated_by_membership_id UUID NOT NULL,
  archived_at TIMESTAMPTZ,
  archived_by_membership_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_pms_message_quick_replies_active_name
  ON pms.message_quick_replies (property_id, lower(name)) WHERE archived_at IS NULL;

ALTER TABLE pms.messages
  ADD COLUMN delivery_state TEXT CHECK (
    delivery_state IS NULL OR delivery_state IN ('queued', 'retrying', 'sent', 'held', 'failed')
  ),
  ADD COLUMN delivery_channel TEXT CHECK (
    delivery_channel IS NULL OR delivery_channel IN ('ota', 'email')
  ),
  ADD COLUMN delivery_reason_code TEXT,
  ADD COLUMN accepted_idempotency_key_id UUID,
  ADD COLUMN current_delivery_attempt_id UUID,
  ADD COLUMN latest_provider_receipt_at TIMESTAMPTZ,
  ADD COLUMN scope_key TEXT GENERATED ALWAYS AS (
    platform.tenant_scope_key('property', NULL::UUID, property_id)
  ) STORED,
  ADD CONSTRAINT chk_pms_messages_delivery_direction CHECK (
    direction = 'outbound' OR (
      delivery_state IS NULL AND delivery_channel IS NULL
      AND delivery_reason_code IS NULL AND accepted_idempotency_key_id IS NULL
      AND current_delivery_attempt_id IS NULL AND latest_provider_receipt_at IS NULL
    )
  ),
  ADD CONSTRAINT fk_pms_messages_accepted_idempotency_scope
    FOREIGN KEY (accepted_idempotency_key_id, scope_key)
    REFERENCES platform.idempotency_keys(id, scope_key);

CREATE UNIQUE INDEX uq_pms_messages_accepted_idempotency
  ON pms.messages (property_id, accepted_idempotency_key_id)
  WHERE accepted_idempotency_key_id IS NOT NULL;

CREATE TABLE pms.message_delivery_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
  message_id UUID NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  resolved_channel TEXT NOT NULL CHECK (resolved_channel IN ('ota', 'email')),
  adapter TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (
    outcome IN ('running', 'accepted', 'transient_failure', 'terminal_failure')
  ),
  scheduled_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  provider_reference TEXT,
  failure_code TEXT,
  failure_metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_pms_message_delivery_attempt_scope UNIQUE (id, message_id, property_id),
  CONSTRAINT uq_pms_message_delivery_attempt_number UNIQUE (message_id, attempt_number),
  CONSTRAINT fk_pms_message_delivery_attempt_message_property
    FOREIGN KEY (message_id, property_id) REFERENCES pms.messages(id, property_id) ON DELETE RESTRICT,
  CONSTRAINT chk_pms_message_delivery_attempt_completion CHECK (
    (outcome = 'running' AND completed_at IS NULL)
    OR (outcome <> 'running' AND completed_at IS NOT NULL)
  )
);

CREATE FUNCTION pms.enforce_message_delivery_attempt_outbound()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pms.messages message
    WHERE message.id = NEW.message_id
      AND message.property_id = NEW.property_id
      AND message.direction = 'outbound'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_pms_message_delivery_attempt_outbound',
      MESSAGE = 'message delivery attempts require an outbound message';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER chk_pms_message_delivery_attempt_outbound
AFTER INSERT OR UPDATE OF message_id, property_id ON pms.message_delivery_attempts
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION pms.enforce_message_delivery_attempt_outbound();

ALTER TABLE pms.messages
  ADD CONSTRAINT fk_pms_messages_current_delivery_attempt
  FOREIGN KEY (current_delivery_attempt_id, id, property_id)
  REFERENCES pms.message_delivery_attempts(id, message_id, property_id);

CREATE TABLE pms.message_delivery_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
  message_id UUID NOT NULL,
  attempt_id UUID NOT NULL,
  receipt_type TEXT NOT NULL CHECK (receipt_type IN ('delivered', 'read')),
  provider_receipt_id TEXT,
  acknowledged_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  receipt_metadata JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT fk_pms_message_delivery_receipt_attempt
    FOREIGN KEY (attempt_id, message_id, property_id)
    REFERENCES pms.message_delivery_attempts(id, message_id, property_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX uq_pms_message_delivery_receipt_provider
  ON pms.message_delivery_receipts (property_id, provider_receipt_id)
  WHERE provider_receipt_id IS NOT NULL;

CREATE FUNCTION pms.enforce_message_delivery_receipt_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pms.message_delivery_attempts attempt
    WHERE attempt.id = NEW.attempt_id
      AND attempt.message_id = NEW.message_id
      AND attempt.property_id = NEW.property_id
      AND attempt.outcome = 'accepted'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_pms_message_delivery_receipt_accepted_attempt',
      MESSAGE = 'message delivery receipts require an accepted attempt';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER chk_pms_message_delivery_receipt_accepted_attempt
AFTER INSERT ON pms.message_delivery_receipts
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION pms.enforce_message_delivery_receipt_attempt();

CREATE FUNCTION pms.protect_completed_message_delivery_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR OLD.outcome <> 'running'
    OR OLD.id IS DISTINCT FROM NEW.id
    OR OLD.property_id IS DISTINCT FROM NEW.property_id
    OR OLD.message_id IS DISTINCT FROM NEW.message_id
    OR OLD.attempt_number IS DISTINCT FROM NEW.attempt_number
    OR OLD.resolved_channel IS DISTINCT FROM NEW.resolved_channel
    OR OLD.adapter IS DISTINCT FROM NEW.adapter
    OR OLD.started_at IS DISTINCT FROM NEW.started_at
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'completed message delivery evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER protect_pms_message_delivery_attempt_evidence
BEFORE UPDATE OR DELETE ON pms.message_delivery_attempts
FOR EACH ROW EXECUTE FUNCTION pms.protect_completed_message_delivery_attempt();
CREATE TRIGGER protect_pms_message_delivery_attempt_truncate
BEFORE TRUNCATE ON pms.message_delivery_attempts
FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();

CREATE FUNCTION pms.protect_message_direction_with_delivery_attempts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.direction <> 'outbound' AND EXISTS (
    SELECT 1 FROM pms.message_delivery_attempts attempt
    WHERE attempt.message_id = NEW.id AND attempt.property_id = NEW.property_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_pms_message_with_delivery_attempts_outbound',
      MESSAGE = 'messages with delivery attempts must remain outbound';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER chk_pms_message_with_delivery_attempts_outbound
BEFORE UPDATE OF direction ON pms.messages
FOR EACH ROW EXECUTE FUNCTION pms.protect_message_direction_with_delivery_attempts();

CREATE TRIGGER protect_pms_message_delivery_receipt_evidence
BEFORE UPDATE OR DELETE ON pms.message_delivery_receipts
FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER protect_pms_message_delivery_receipt_truncate
BEFORE TRUNCATE ON pms.message_delivery_receipts
FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();

CREATE INDEX idx_pms_message_threads_inbox_order
  ON pms.message_threads (
    property_id, attention_state,
    (GREATEST(COALESCE(last_message_at, created_at), COALESCE(last_internal_note_at, created_at))) DESC,
    id DESC
  );
CREATE INDEX idx_pms_message_internal_notes_timeline
  ON pms.message_internal_notes (thread_id, created_at DESC, id DESC);
CREATE INDEX idx_pms_message_delivery_attempts_message
  ON pms.message_delivery_attempts (message_id, attempt_number DESC);
