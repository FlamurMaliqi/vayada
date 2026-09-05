"""Synthetic, dedicated local PostgreSQL only. No AWS, Docker or provider calls."""

import os
import subprocess
import unittest
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
APPROVAL = "SET vayada.inbox_cleanup_approved='VAY-1381:preserve-history:2026-09-05';"


class CleanupTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dsn = os.environ["INBOX_CLEANUP_TEST_DATABASE_URL"]
        url = urlsplit(cls.dsn)
        if (
            url.hostname != "127.0.0.1"
            or url.port != 55434
            or url.path != "/vayada_inbox_cleanup_test_20260905"
            or url.query
        ):
            raise ValueError("Dedicated local test database required")
        identity = cls.sql("SELECT current_database(), inet_server_addr();").stdout.strip()
        if identity != "vayada_inbox_cleanup_test_20260905|127.0.0.1":
            raise ValueError("Actual test database identity mismatch")
        cls.cleanup = (ROOT / "scripts/ops/retire-inbox-prototype.sql").read_text()
        cls.migration = subprocess.run(
            [
                "git",
                "show",
                "668b55d5c:apps/pms-api/migrations/090_inbox_templates_automations.sql",
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=True,
        ).stdout

    @classmethod
    def sql(cls, source, check=True):
        return subprocess.run(
            ["psql", cls.dsn, "-X", "-qAt", "-v", "ON_ERROR_STOP=1"],
            input=source,
            text=True,
            capture_output=True,
            check=check,
            timeout=25,
        )

    def setUp(self):
        self.sql(
            """
            DROP SCHEMA IF EXISTS inbox_prototype_archive_20260905 CASCADE;
            DROP SCHEMA public CASCADE;
            CREATE SCHEMA public;
            ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES FROM pg_monitor;
            CREATE TYPE message_source AS ENUM ('booking.com', 'airbnb');
            CREATE TABLE hotels (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
            CREATE TABLE bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
            CREATE TABLE message_threads (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
            CREATE TABLE messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), body text);
            INSERT INTO hotels SELECT gen_random_uuid() FROM generate_series(1,257);
        """
            + self.migration
            + """
            INSERT INTO bookings DEFAULT VALUES;
            INSERT INTO message_threads DEFAULT VALUES;
            INSERT INTO messages SELECT gen_random_uuid(), 'retained guest message', true
                FROM generate_series(1,14);
            INSERT INTO automation_sends (automation_id, booking_id, message_thread_id, message_id, status)
                SELECT a.id, b.id, t.id, m.id, CASE WHEN a.n <= 7 THEN 'sent' ELSE 'failed' END
                FROM (SELECT id, row_number() OVER (ORDER BY id) n FROM guest_automations LIMIT 9) a
                CROSS JOIN bookings b CROSS JOIN message_threads t
                CROSS JOIN (SELECT id FROM messages LIMIT 1) m;
            UPDATE message_templates SET created_at='2026-06-24', updated_at='2026-06-24';
            UPDATE guest_automations SET created_at='2026-06-24', updated_at='2026-06-24';
            UPDATE automation_sends SET created_at='2026-06-24', updated_at='2026-06-24';
        """
        )
        self.before = self.rows()

    def rows(self):
        return self.sql("""
            SELECT 'templates', jsonb_agg(to_jsonb(t) ORDER BY id) FROM message_templates t;
            SELECT 'rules', jsonb_agg(to_jsonb(t) ORDER BY id) FROM guest_automations t;
            SELECT 'sends', jsonb_agg(to_jsonb(t) ORDER BY id) FROM automation_sends t;
            SELECT 'messages', jsonb_agg(to_jsonb(t) ORDER BY id) FROM messages t;
        """).stdout

    def assert_blocked(self, expected, approval=APPROVAL, source=None):
        result = self.sql(approval + (source or self.cleanup), check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(expected, result.stderr)
        self.assertEqual(self.rows(), self.before)
        self.assertEqual(
            self.sql("SELECT to_regnamespace('inbox_prototype_archive_20260905');").stdout.strip(),
            "",
        )

    def test_cleanup_preserves_archive_and_history(self):
        self.sql(APPROVAL + self.cleanup)
        archived = self.sql("""
            SELECT 'templates', jsonb_agg(to_jsonb(t) ORDER BY id) FROM inbox_prototype_archive_20260905.message_templates t;
            SELECT 'rules', jsonb_agg(to_jsonb(t) ORDER BY id) FROM inbox_prototype_archive_20260905.guest_automations t;
            SELECT 'sends', jsonb_agg(to_jsonb(t) ORDER BY id) FROM automation_sends t;
            SELECT 'messages', jsonb_agg(to_jsonb(t) ORDER BY id) FROM messages t;
        """).stdout
        self.assertEqual(archived, self.before)
        self.assertEqual(
            self.sql(
                "SELECT (SELECT count(*) FROM message_templates), (SELECT count(*) FROM guest_automations);"
            ).stdout.strip(),
            "0|0",
        )
        self.assertEqual(
            self.sql(
                "SELECT count(*) FROM inbox_prototype_archive_20260905.automation_sends;"
            ).stdout.strip(),
            "9",
        )
        self.assertNotEqual(self.sql(APPROVAL + self.cleanup, check=False).returncode, 0)
        # A booking deletion cannot cascade into the detached archival send snapshot.
        self.sql("DELETE FROM bookings;")
        self.assertEqual(
            self.sql(
                "SELECT count(*) FROM inbox_prototype_archive_20260905.automation_sends;"
            ).stdout.strip(),
            "9",
        )

    def test_missing_approval(self):
        self.assert_blocked("INBOX_CLEANUP_APPROVAL_REQUIRED", approval="")

    def test_changed_count(self):
        self.sql(
            "INSERT INTO message_templates(hotel_id,name) SELECT id,'new' FROM hotels LIMIT 1;"
        )
        self.before = self.rows()
        self.assert_blocked("INBOX_CLEANUP_AUDITED_COUNTS_CHANGED")

    def test_recent_edit(self):
        self.sql("UPDATE guest_automations SET updated_at='2026-09-05 09:00+00';")
        self.before = self.rows()
        self.assert_blocked("INBOX_CLEANUP_POST_AUDIT_ACTIVITY")

    def test_unknown_dependency(self):
        self.sql(
            "CREATE TABLE unexpected (id uuid REFERENCES guest_automations(id) ON DELETE CASCADE);"
        )
        self.assert_blocked("INBOX_CLEANUP_DEPENDENCIES_CHANGED")

    def test_trigger(self):
        self.sql("""CREATE FUNCTION unexpected() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN OLD; END$$;
            CREATE TRIGGER unexpected BEFORE DELETE ON guest_automations FOR EACH ROW EXECUTE FUNCTION unexpected();""")
        self.assert_blocked("INBOX_CLEANUP_UNREVIEWED_BEHAVIOR")

    def test_inherited_archive_grant_rolls_back(self):
        self.sql("ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO pg_monitor;")
        self.assert_blocked("INBOX_CLEANUP_ARCHIVE_ACCESS_UNREVIEWED")

    def test_failure_after_deletes_rolls_back_everything(self):
        source = self.cleanup.replace(
            "COMMIT;", "DO $$BEGIN RAISE EXCEPTION 'injected'; END$$; COMMIT;"
        )
        self.assert_blocked("injected", source=source)


if __name__ == "__main__":
    unittest.main()
