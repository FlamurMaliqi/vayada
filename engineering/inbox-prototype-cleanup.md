# Retire the rolled-back Inbox prototype

VAY-1381 operator change; not a target migration, startup migration, or Inbox
launch. User approved removal of obsolete templates/rules on 2026-09-05 while
preserving guest messages and sending history. Design input:
[live audit and disposition](https://linear.app/vayadacom/document/rolled-back-inbox-schema-and-data-audit-ba2a8e07ae32).

## Exact scope

`scripts/ops/retire-inbox-prototype.sql` copies all three prototype tables into
`inbox_prototype_archive_20260905`, with no outbound foreign keys or executable
defaults/triggers. It redirects the live send ledger's automation reference to
the archived rule, then deletes only the live template and automation rows.
The archive preserves original active flags as historical evidence, not jobs.

No guest messages, thread state, attachments, booking data, send records, hotel
fields, `messages.automated`, enum values, migration ledger, or target data are
deleted or rewritten. Empty legacy template/rule tables remain; dropping schema
objects is not necessary to remove executable definitions and is a later task.
Do not restore the old engine, cancel incident tickets, or replay historical sends.

## Execution gates — NOT yet satisfied

1. Review/merge this operator change. No automatic workflow runs this script.
2. Recheck exact production database, deployed digests, callable/scheduled
   executors, database triggers, dependencies, role ownership and recent activity.
   Do not stop the whole PMS scheduler: it also owns unrelated booking/payments.
3. Create a restricted, encrypted, independently recoverable backup of the three
   prototype tables (schema and rows), their dependencies and automated-message
   provenance. Record object/version/checksum, owner, retention and restore proof.
   Do not put bodies, contacts or raw errors in logs/Linear. An archive in the same
   database or a healthy RDS backup setting alone is not this restore proof.
4. Reconcile the nine send records with the fourteen automated messages using
   IDs and provider evidence without sending anything. Preserve unmatched history;
   do not infer one-to-one mapping or treat `sent` as provider confirmation.
5. Rehearse this exact SQL on a resource-isolated copy; compare every archived row
   and the full retained guest history. Exercise recovery with executors absent.
   Synthetic local fixtures are not a production-data rehearsal.
6. Pin account `269416271598`, region `eu-west-1`, service definition
   `vayada-pms-backend:210`, SSM `/vayada/prod/db-pms-url`, database `vayada_pms_db`
   and the reviewed backup/rehearsal evidence in a bounded one-shot runner.
   Require verified TLS, no API startup, provider secrets, or automatic retry.
   SQL database-name/approval checks do not authenticate the AWS destination.

After those gates pass, the runner may set the session GUC
`vayada.inbox_cleanup_approved` to `VAY-1381:preserve-history:2026-09-05` and execute
the exact script, stopping on any error. Without that setting the SQL refuses.
Short lock/statement limits abort on contention; never increase them on shared
production without review. Counts/activity/schema drift require a fresh audit.
After an uncertain commit, inspect the archive, live counts and send ledger;
never blindly retry or drop an existing archive to make a rerun pass.

The archive has no non-owner grants. Its owner, role members with owner authority
and database administrators still have access; do not claim isolation from an
application using that same privileged owner. Confirm the operator/retention owner
and approved storage access before apply. No automatic archive expiration.

## Recovery

Before commit, every failure rolls back the complete transaction. After commit,
keep executors absent, restore into an isolated database first, compare archive
checksums, and verify referenced properties/bookings/messages still exist.
An approved recovery copies archived templates and rules back with explicit column
lists, forcing restored rules `is_active=false`; redirect the live send ledger FK
only after every referenced rule is restored. Preserve the archive and live ledger.
Do not restore active flags or overwrite messages. Post-commit recovery needs its
own reviewed operation; this script deliberately has no automatic undo or replay.

## Read-only execution evidence (2026-09-05)

Production task definition :210 and running task use image index
`sha256:c5532595d322405d3d093b07db4fca67f8e9d66bb2f21b314f9c27a07e262e8c`.
Its amd64 manifest is `sha256:6e37cfe1b473c70df5ab41495a196dacfdf171f24259d7596170c37608c209ad`.
The three application/migration/script layers were downloaded without starting
Docker, digest-verified and inspected in memory: all 223 files exactly match
commit `1ca4cc6998543f2e21c93622c295d05c1d140911`. No `inbox_automation`,
`guest_automations`, `automation_sends` or `message_templates` references remain.
The service has no mounted code overrides. This verifies the deployed PMS engine
is absent, not that every possible database client or custom DB job is absent.

No EventBridge Scheduler schedules or scheduled default-bus rules were found in
eu-west-1. The running cluster inventory contains service tasks, no standalone
automation job. RDS is encrypted with seven-day backups and reported a latest
restorable time of 2026-09-05 09:14:15 UTC; no backup restore was run here.
Staging has no audited prototype tables, so this script must not run there.

## Local validation

Ten synthetic PostgreSQL 17 checks cover exact archival/history preservation,
refused rerun, approval, activity/count/dependency/trigger/ACL guards, dependent
views/materialized views and late rollback.
With the dedicated local database already created and historical git object
`668b55d5c` available, run `python3 -m unittest discover -s scripts/ops -p
test_retire_inbox_prototype.py -v` with `INBOX_CLEANUP_TEST_DATABASE_URL` pointing
to `postgresql://flamurmaliqi@127.0.0.1:55434/vayada_inbox_cleanup_test_20260905`.
The tests reset only that task-owned database's synthetic schemas. No Docker,
production data or provider calls are used. Local success is not approval to apply.
