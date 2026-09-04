CREATE TABLE pms.inbox_email_routes (
  property_id UUID PRIMARY KEY REFERENCES hotel_catalog.properties(id),
  from_address TEXT NOT NULL CHECK (
    BTRIM(from_address) <> '' AND length(from_address) <= 320
    AND from_address !~ E'[\\r\\n]'
  ),
  sender_status TEXT NOT NULL CHECK (sender_status IN ('approved', 'disabled')),
  policy_status TEXT NOT NULL CHECK (policy_status IN ('allowed', 'disallowed')),
  approved_at TIMESTAMPTZ,
  approved_by_membership_id UUID REFERENCES identity.organization_memberships(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_pms_inbox_email_route_approval CHECK (
    sender_status <> 'approved' OR approved_at IS NOT NULL
  )
);

COMMENT ON TABLE pms.inbox_email_routes IS
  'Property-scoped approved sender and policy gate for direct guest Inbox email.';
