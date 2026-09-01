import type pg from "pg";

export const DATABASE_ATTESTATION_SCHEMA = "vayada_migration_evidence";
export const DATABASE_ATTESTATION_TABLE = "database_attestations";
export const DATABASE_ATTESTATION_OWNER = "vayada_migration_attestor";

export const DATABASE_ATTESTATION_TABLE_STATE_SQL = `
WITH evidence_relation AS (
  SELECT relation.oid, relation.relkind, relation.relpersistence,
         relation.relowner, relation.relrowsecurity, relation.relforcerowsecurity,
         relation.relispartition, relation.relacl, namespace.oid AS namespace_oid,
         namespace.nspowner
  FROM pg_catalog.pg_class relation
  JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = '${DATABASE_ATTESTATION_SCHEMA}'
    AND relation.relname = '${DATABASE_ATTESTATION_TABLE}'
), trusted_owner AS (
  SELECT role.*
  FROM pg_catalog.pg_roles role
  WHERE role.rolname = '${DATABASE_ATTESTATION_OWNER}'
)
SELECT EXISTS (SELECT 1 FROM evidence_relation) AS present,
       COALESCE(bool_and(
         relkind = 'r'
         AND relpersistence = 'p'
         AND NOT relrowsecurity
         AND NOT relforcerowsecurity
         AND NOT relispartition
         AND NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_inherits inheritance
           WHERE inheritance.inhrelid = evidence_relation.oid
              OR inheritance.inhparent = evidence_relation.oid
         )
         AND (SELECT count(*) FROM pg_catalog.pg_attribute attribute
              WHERE attribute.attrelid = evidence_relation.oid
                AND attribute.attnum > 0 AND NOT attribute.attisdropped) = 3
         AND EXISTS (
           SELECT 1 FROM pg_catalog.pg_attribute attribute
           WHERE attribute.attrelid = evidence_relation.oid
             AND attribute.attname = 'attestation_key'
             AND attribute.atttypid = 'text'::pg_catalog.regtype
             AND attribute.attnotnull AND NOT attribute.atthasdef
             AND attribute.attidentity = ''
             AND attribute.attgenerated = ''
         )
         AND EXISTS (
           SELECT 1 FROM pg_catalog.pg_attribute attribute
           WHERE attribute.attrelid = evidence_relation.oid
             AND attribute.attname = 'attestation_value'
             AND attribute.atttypid = 'text'::pg_catalog.regtype
             AND attribute.attnotnull AND NOT attribute.atthasdef
             AND attribute.attidentity = ''
             AND attribute.attgenerated = ''
         )
         AND EXISTS (
           SELECT 1 FROM pg_catalog.pg_attribute attribute
           WHERE attribute.attrelid = evidence_relation.oid
             AND attribute.attname = 'attested_at'
             AND attribute.atttypid = 'timestamp with time zone'::pg_catalog.regtype
             AND attribute.attnotnull AND attribute.atthasdef
             AND attribute.attidentity = '' AND attribute.attgenerated = ''
             AND (
               SELECT pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid)
               FROM pg_catalog.pg_attrdef default_value
               WHERE default_value.adrelid = attribute.attrelid
                 AND default_value.adnum = attribute.attnum
             ) = 'now()'
         )
         AND (
           SELECT count(*)
           FROM pg_catalog.pg_constraint constraint_row
           JOIN pg_catalog.pg_attribute attribute
             ON attribute.attrelid = constraint_row.conrelid
            AND constraint_row.conkey = ARRAY[attribute.attnum]::smallint[]
           WHERE constraint_row.conrelid = evidence_relation.oid
             AND constraint_row.contype = 'p'
             AND attribute.attname = 'attestation_key'
         ) = 1
         AND (
           SELECT count(*) FROM pg_catalog.pg_constraint constraint_row
           WHERE constraint_row.conrelid = evidence_relation.oid
         ) = 1
         AND session_user = current_user
         AND relowner = (SELECT oid FROM trusted_owner)
         AND nspowner = (SELECT oid FROM trusted_owner)
         AND (SELECT NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
                     AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
              FROM trusted_owner)
         AND NOT EXISTS (
           SELECT 1
           FROM pg_catalog.pg_auth_members membership
           JOIN trusted_owner owner ON owner.oid = membership.member
         )
         AND NOT EXISTS (
           SELECT 1
           FROM pg_catalog.pg_auth_members membership
           JOIN trusted_owner owner ON owner.oid = membership.roleid
           WHERE membership.inherit_option
         )
         AND NOT EXISTS (
           SELECT 1
           FROM pg_catalog.pg_proc routine
           JOIN trusted_owner owner ON owner.oid = routine.proowner
         )
         AND NOT EXISTS (
           SELECT 1
           FROM pg_catalog.aclexplode(
             COALESCE(
               evidence_relation.relacl,
               pg_catalog.acldefault('r', evidence_relation.relowner)
             )
           ) privilege
           WHERE privilege.grantee <> evidence_relation.relowner
             AND privilege.privilege_type IN (
               'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES'
             )
         )
         AND NOT EXISTS (
           SELECT 1
           FROM pg_catalog.pg_attribute attribute
           CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) privilege
           WHERE attribute.attrelid = evidence_relation.oid
             AND attribute.attnum > 0 AND NOT attribute.attisdropped
             AND attribute.attacl IS NOT NULL
             AND privilege.grantee <> evidence_relation.relowner
             AND privilege.privilege_type IN ('INSERT', 'UPDATE', 'REFERENCES')
         )
         AND NOT EXISTS (
           SELECT 1
           FROM pg_catalog.pg_proc routine
           JOIN pg_catalog.pg_namespace routine_namespace
             ON routine_namespace.oid = routine.pronamespace
           JOIN pg_catalog.pg_roles routine_owner ON routine_owner.oid = routine.proowner
           WHERE routine.prosecdef
             AND routine_namespace.nspname NOT IN ('information_schema', 'pg_catalog')
             AND routine_namespace.nspname !~ '^pg_toast'
             AND EXISTS (
               SELECT 1 FROM pg_catalog.pg_roles assumable_role
               WHERE pg_catalog.pg_has_role(current_user, assumable_role.oid, 'MEMBER')
                 AND pg_catalog.has_function_privilege(
                   assumable_role.oid, routine.oid, 'EXECUTE'
                 )
             )
             AND (
               routine_owner.rolsuper
               OR pg_catalog.has_table_privilege(
                 routine_owner.oid, evidence_relation.oid, 'INSERT'
               )
               OR pg_catalog.has_table_privilege(
                 routine_owner.oid, evidence_relation.oid, 'UPDATE'
               )
               OR pg_catalog.has_table_privilege(
                 routine_owner.oid, evidence_relation.oid, 'DELETE'
               )
               OR pg_catalog.has_table_privilege(
                 routine_owner.oid, evidence_relation.oid, 'TRUNCATE'
               )
               OR pg_catalog.has_any_column_privilege(
                 routine_owner.oid, evidence_relation.oid, 'INSERT'
               )
               OR pg_catalog.has_any_column_privilege(
                 routine_owner.oid, evidence_relation.oid, 'UPDATE'
               )
             )
         )
         AND NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_trigger trigger_row
           WHERE trigger_row.tgrelid = evidence_relation.oid
         )
         AND NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_rewrite rewrite_rule
           WHERE rewrite_rule.ev_class = evidence_relation.oid
         )
         AND NOT EXISTS (
           SELECT 1
           FROM pg_catalog.pg_roles assumable_role
           WHERE pg_catalog.pg_has_role(current_user, assumable_role.oid, 'MEMBER')
             AND (
               assumable_role.rolsuper
               OR assumable_role.rolcreaterole
               OR pg_catalog.pg_has_role(
                 assumable_role.oid, evidence_relation.relowner, 'MEMBER'
               )
               OR pg_catalog.has_schema_privilege(
                 assumable_role.oid, evidence_relation.namespace_oid, 'CREATE'
               )
               OR pg_catalog.has_table_privilege(
                 assumable_role.oid, evidence_relation.oid, 'INSERT'
               )
               OR pg_catalog.has_table_privilege(
                 assumable_role.oid, evidence_relation.oid, 'UPDATE'
               )
               OR pg_catalog.has_table_privilege(
                 assumable_role.oid, evidence_relation.oid, 'DELETE'
               )
               OR pg_catalog.has_table_privilege(
                 assumable_role.oid, evidence_relation.oid, 'TRUNCATE'
               )
               OR pg_catalog.has_table_privilege(
                 assumable_role.oid, evidence_relation.oid, 'TRIGGER'
               )
               OR pg_catalog.has_any_column_privilege(
                 assumable_role.oid, evidence_relation.oid, 'INSERT'
               )
               OR pg_catalog.has_any_column_privilege(
                 assumable_role.oid, evidence_relation.oid, 'UPDATE'
               )
             )
         )
       ), false) AS trusted
FROM evidence_relation`;

export const DATABASE_ATTESTATION_VALUES_SQL = `
SELECT attestation_key, attestation_value
FROM ${DATABASE_ATTESTATION_SCHEMA}.${DATABASE_ATTESTATION_TABLE}
ORDER BY attestation_key`;

type QueryClient = Pick<pg.ClientBase, "query">;

export class DatabaseAttestationError extends Error {
  constructor(readonly code: "UNTRUSTED_TABLE" | "DUPLICATE_KEY" | "DISAGREEMENT") {
    super(code);
    this.name = "DatabaseAttestationError";
  }
}

export async function readDatabaseAttestationTable(
  client: QueryClient,
): Promise<ReadonlyMap<string, string> | null> {
  const state = await client.query<{ present: boolean; trusted: boolean }>(
    DATABASE_ATTESTATION_TABLE_STATE_SQL,
  );
  if (!state.rows[0]?.present) return null;
  if (state.rows[0].trusted !== true) throw new DatabaseAttestationError("UNTRUSTED_TABLE");

  const result = await client.query<{ attestation_key: string; attestation_value: string }>(
    DATABASE_ATTESTATION_VALUES_SQL,
  );
  const values = new Map<string, string>();
  for (const row of result.rows) {
    if (values.has(row.attestation_key)) throw new DatabaseAttestationError("DUPLICATE_KEY");
    values.set(row.attestation_key, row.attestation_value);
  }
  return values;
}

export function resolveDatabaseAttestation(
  settings: Readonly<Record<string, string | null>>,
  table: ReadonlyMap<string, string> | null,
  keys: readonly string[],
): Record<string, string | null> {
  return Object.fromEntries(
    keys.map((key) => {
      const settingValue = settings[key] ?? null;
      const tableValue = table?.get(key) ?? null;
      if (settingValue !== null && tableValue !== null && settingValue !== tableValue) {
        throw new DatabaseAttestationError("DISAGREEMENT");
      }
      return [key, tableValue ?? settingValue];
    }),
  );
}
