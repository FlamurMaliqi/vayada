-- VAY-637: preserve note creation evidence while recording only the latest edit in v1.

ALTER TABLE pms.booking_notes_private
  ADD COLUMN edited_by_user_id UUID REFERENCES identity.users(id) ON DELETE SET NULL,
  ADD COLUMN edited_by_display_name TEXT,
  ADD COLUMN edited_at TIMESTAMPTZ,
  ADD CONSTRAINT chk_pms_private_note_edit_metadata
    CHECK (
      (
        edited_at IS NULL
        AND edited_by_user_id IS NULL
        AND edited_by_display_name IS NULL
      )
      OR (
        edited_at IS NOT NULL
        AND NULLIF(BTRIM(edited_by_display_name), '') IS NOT NULL
      )
    );
