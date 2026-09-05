-- VAY-1381: operator-only cleanup, NEVER an application startup migration.
-- Read engineering/inbox-prototype-cleanup.md before setting the approval GUC.
BEGIN;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '500ms';
SET LOCAL idle_in_transaction_session_timeout = '15s';
SET LOCAL row_security = off;
SET LOCAL search_path = pg_catalog;

DO $cleanup$
DECLARE
    relation_name text;
    has_recent_activity boolean;
BEGIN
    IF current_setting('vayada.inbox_cleanup_approved', true) IS DISTINCT FROM
       'VAY-1381:preserve-history:2026-09-05' THEN
        RAISE EXCEPTION 'INBOX_CLEANUP_APPROVAL_REQUIRED';
    END IF;
    IF current_database() NOT IN ('vayada_pms_db', 'vayada_inbox_cleanup_test_20260905') THEN
        RAISE EXCEPTION 'INBOX_CLEANUP_DATABASE_MISMATCH';
    END IF;
    LOCK TABLE public.message_templates, public.guest_automations,
        public.automation_sends IN ACCESS EXCLUSIVE MODE;
    IF EXISTS (
        SELECT 1 FROM pg_class WHERE oid IN ('public.message_templates'::regclass,
            'public.guest_automations'::regclass, 'public.automation_sends'::regclass)
        AND (relkind <> 'r' OR relpersistence <> 'p' OR relispartition OR relhasrules)
    ) OR EXISTS (
        SELECT 1 FROM pg_inherits WHERE inhparent IN ('public.message_templates'::regclass,
            'public.guest_automations'::regclass, 'public.automation_sends'::regclass)
    ) OR EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgrelid IN ('public.message_templates'::regclass,
            'public.guest_automations'::regclass, 'public.automation_sends'::regclass)
        AND NOT tgisinternal
    ) OR EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtenabled <> 'D') THEN
        RAISE EXCEPTION 'INBOX_CLEANUP_UNREVIEWED_BEHAVIOR';
    END IF;
    IF (SELECT count(*) FROM public.message_templates) <> 1542
       OR (SELECT count(*) FROM public.guest_automations) <> 1028
       OR (SELECT count(*) FROM public.guest_automations WHERE is_active) <> 771
       OR (SELECT count(*) FROM public.automation_sends) <> 9
       OR (SELECT count(*) FROM public.messages WHERE automated) <> 14 THEN
        RAISE EXCEPTION 'INBOX_CLEANUP_AUDITED_COUNTS_CHANGED';
    END IF;
    FOREACH relation_name IN ARRAY ARRAY['message_templates', 'guest_automations', 'automation_sends'] LOOP
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE updated_at > $1)', relation_name)
            INTO STRICT has_recent_activity USING '2026-09-05 08:52:16+00'::timestamptz;
        IF has_recent_activity THEN
            RAISE EXCEPTION 'INBOX_CLEANUP_POST_AUDIT_ACTIVITY';
        END IF;
    END LOOP;
    IF (SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND confrelid IN
        ('public.message_templates'::regclass, 'public.guest_automations'::regclass,
         'public.automation_sends'::regclass)) <> 2
       OR NOT EXISTS (SELECT 1 FROM pg_constraint
           WHERE conrelid = 'public.guest_automations'::regclass AND convalidated
           AND pg_get_constraintdef(oid) = 'FOREIGN KEY (template_id) REFERENCES public.message_templates(id) ON DELETE SET NULL')
       OR NOT EXISTS (SELECT 1 FROM pg_constraint
           WHERE conrelid = 'public.automation_sends'::regclass AND convalidated
           AND conname = 'automation_sends_automation_id_fkey'
           AND pg_get_constraintdef(oid) = 'FOREIGN KEY (automation_id) REFERENCES public.guest_automations(id) ON DELETE CASCADE') THEN
        RAISE EXCEPTION 'INBOX_CLEANUP_DEPENDENCIES_CHANGED';
    END IF;

    -- An existing archive is an intentional hard stop, including ambiguous retries.
    CREATE SCHEMA inbox_prototype_archive_20260905;
    REVOKE ALL ON SCHEMA inbox_prototype_archive_20260905 FROM PUBLIC;
    FOREACH relation_name IN ARRAY ARRAY['message_templates', 'guest_automations', 'automation_sends'] LOOP
        EXECUTE format('CREATE TABLE inbox_prototype_archive_20260905.%I AS TABLE public.%I', relation_name, relation_name);
        EXECUTE format('ALTER TABLE inbox_prototype_archive_20260905.%I ADD PRIMARY KEY (id)', relation_name);
        EXECUTE format('REVOKE ALL ON inbox_prototype_archive_20260905.%I FROM PUBLIC', relation_name);
    END LOOP;
    -- Fail if default ACLs unexpectedly grant the new archive to another role.
    IF EXISTS (SELECT 1 FROM pg_namespace n,
        LATERAL aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
        WHERE n.nspname = 'inbox_prototype_archive_20260905' AND a.grantee <> n.nspowner)
       OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
        LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
        WHERE n.nspname = 'inbox_prototype_archive_20260905' AND c.relkind = 'r'
        AND a.grantee <> c.relowner) THEN
        RAISE EXCEPTION 'INBOX_CLEANUP_ARCHIVE_ACCESS_UNREVIEWED';
    END IF;

    -- Preserve the live send ledger and its IDs; redirect only the obsolete rule FK.
    ALTER TABLE public.automation_sends DROP CONSTRAINT automation_sends_automation_id_fkey;
    ALTER TABLE public.automation_sends ADD CONSTRAINT automation_sends_automation_id_fkey
        FOREIGN KEY (automation_id) REFERENCES inbox_prototype_archive_20260905.guest_automations(id)
        ON DELETE RESTRICT;
    DELETE FROM public.guest_automations;
    DELETE FROM public.message_templates;
    IF EXISTS ((TABLE public.automation_sends EXCEPT ALL TABLE inbox_prototype_archive_20260905.automation_sends)
        UNION ALL (TABLE inbox_prototype_archive_20260905.automation_sends EXCEPT ALL TABLE public.automation_sends))
       OR EXISTS (SELECT 1 FROM public.guest_automations)
       OR EXISTS (SELECT 1 FROM public.message_templates) THEN
        RAISE EXCEPTION 'INBOX_CLEANUP_POSTCHECK_FAILED';
    END IF;
END
$cleanup$;
COMMIT;
