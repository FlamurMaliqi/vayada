# Property email sender operation — VAY-1381

Implements the scoped setup gate in `engineering/native-guest-inbox-contract.md`.
This is a privileged operator tool, not a self-service API or provider verifier.
Use a reviewed release, explicit property approval and a verified, monitored From
mailbox. Obtain the active property owner's membership ID through authorized
identity reads. Do not invent an approver or treat application credentials as
proof of domain ownership. No message, job, webhook or global flag is changed.

Inject the exact target DSN privately as `TARGET_DATABASE_URL`; never pass a DSN
as a command argument. Prepare a private JSON manifest with these fields:

```json
{
  "database": "exact_target_database_name",
  "propertyId": "approved-property-uuid",
  "membershipId": "active-owner-membership-uuid",
  "operationId": "new-operation-uuid",
  "fromAddress": "bookings@verified-domain.example",
  "verifiedDomain": "verified-domain.example",
  "approvalRef": "VAY-1381:owner-approval-and-provider-evidence-reference",
  "state": "approved"
}
```

Run `node scripts/ops/inbox-email-sender.mjs preview /private/manifest.json`.
Review the returned database, configured endpoint, cluster ID, property/owner, before-state and pending
count against the approved environment. Preserve this restricted evidence.
Apply with the **same manifest** and returned hash:
`node scripts/ops/inbox-email-sender.mjs apply /private/manifest.json PREVIEW_HASH`.
The hash binds the request, endpoint/cluster and current state; changes abort.
The operator must already have read access to `pg_control_system()`; missing
access fails closed. Do not grant privileges merely to bypass this check.
The route and private before/after audit commit atomically. A repeated operation
returns `already_applied` without re-enabling a subsequently disabled sender.

Rollback: use a **new operation ID**, the same From identity, and `state: disabled`;
preview and apply again. This preserves the route/history and closes its sender
and policy gates. It does not recall accepted email or stop a provider call
already in flight. Reconcile pending/running/ambiguous work separately; enabling
refuses queued/retrying messages. Do not auto-replay any held message.

Tests require a dedicated local PostgreSQL at 127.0.0.1:55438, database
`vayada_inbox_sender_test`, with target migrations applied. Run:
`INBOX_SENDER_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55438/vayada_inbox_sender_test node --test scripts/ops/inbox-email-sender.test.mjs`.
Tests create only synthetic rows; they perform no provider calls or cleanup of
other databases. Stop the task-owned database after testing.
