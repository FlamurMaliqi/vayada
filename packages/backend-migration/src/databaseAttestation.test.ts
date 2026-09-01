import { describe, expect, it } from "vitest";

import {
  DATABASE_ATTESTATION_OWNER,
  DATABASE_ATTESTATION_TABLE_STATE_SQL,
  DATABASE_ATTESTATION_VALUES_SQL,
  DatabaseAttestationError,
  readDatabaseAttestationTable,
  resolveDatabaseAttestation,
} from "./databaseAttestation.js";

function result(rows: unknown[]) {
  return { command: "", fields: [], oid: 0, rowCount: rows.length, rows };
}

describe("database attestation evidence", () => {
  it("accepts an absent table and reads a trusted administrator-owned table", async () => {
    const absent = {
      query: async (sql: string) => {
        expect(sql).toBe(DATABASE_ATTESTATION_TABLE_STATE_SQL);
        return result([{ present: false, trusted: false }]);
      },
    };
    await expect(readDatabaseAttestationTable(absent as never)).resolves.toBeNull();

    const trusted = {
      query: async (sql: string) =>
        sql === DATABASE_ATTESTATION_TABLE_STATE_SQL
          ? result([{ present: true, trusted: true }])
          : result([
              { attestation_key: "vayada.target_environment", attestation_value: "preprod" },
            ]),
    };
    await expect(readDatabaseAttestationTable(trusted as never)).resolves.toEqual(
      new Map([["vayada.target_environment", "preprod"]]),
    );
    expect(DATABASE_ATTESTATION_TABLE_STATE_SQL).toContain("session_user = current_user");
    expect(DATABASE_ATTESTATION_TABLE_STATE_SQL).toContain("has_table_privilege");
    expect(DATABASE_ATTESTATION_TABLE_STATE_SQL).toContain(DATABASE_ATTESTATION_OWNER);
    expect(DATABASE_ATTESTATION_TABLE_STATE_SQL).toContain("membership.inherit_option");
    expect(DATABASE_ATTESTATION_TABLE_STATE_SQL).toContain("relrowsecurity");
    expect(DATABASE_ATTESTATION_TABLE_STATE_SQL).toContain("pg_catalog.pg_inherits");
    expect(DATABASE_ATTESTATION_TABLE_STATE_SQL).toContain("pg_catalog.pg_constraint");
    expect(DATABASE_ATTESTATION_TABLE_STATE_SQL).toContain("pg_catalog.pg_proc");
    expect(DATABASE_ATTESTATION_VALUES_SQL).toContain(
      "vayada_migration_evidence.database_attestations",
    );
  });

  it("fails closed for an untrusted table or duplicate key", async () => {
    const untrusted = {
      query: async () => result([{ present: true, trusted: false }]),
    };
    await expect(readDatabaseAttestationTable(untrusted as never)).rejects.toEqual(
      new DatabaseAttestationError("UNTRUSTED_TABLE"),
    );

    let queryCount = 0;
    const duplicate = {
      query: async () => {
        queryCount += 1;
        return queryCount === 1
          ? result([{ present: true, trusted: true }])
          : result([
              { attestation_key: "key", attestation_value: "one" },
              { attestation_key: "key", attestation_value: "two" },
            ]);
      },
    };
    await expect(readDatabaseAttestationTable(duplicate as never)).rejects.toEqual(
      new DatabaseAttestationError("DUPLICATE_KEY"),
    );
  });

  it("uses either durable trust path but rejects disagreement", () => {
    expect(resolveDatabaseAttestation({ key: "setting" }, new Map(), ["key"])).toEqual({
      key: "setting",
    });
    expect(resolveDatabaseAttestation({ key: null }, new Map([["key", "table"]]), ["key"])).toEqual(
      { key: "table" },
    );
    expect(() =>
      resolveDatabaseAttestation({ key: "setting" }, new Map([["key", "table"]]), ["key"]),
    ).toThrowError(expect.objectContaining({ code: "DISAGREEMENT" }));
  });
});
