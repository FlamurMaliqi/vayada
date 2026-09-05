import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createBankTransferRepository,
  type BankTransferDestinationCommand,
} from "./financeBankTransferRepository.js";

const url = process.env.TEST_DATABASE_URL;
if (url && !new URL(url).pathname.endsWith("_test")) throw new Error("Unsafe test database");
const propertyId = randomUUID(),
  other = randomUUID(),
  actorId = randomUUID();
const details = {
  accountHolder: "Sensitive Holder",
  accountType: "iban" as const,
  accountNumber: "DE89370400440532013000",
  bankName: "Sensitive Bank",
  bicSwift: "COBADEFFXXX",
  instructions: "Sensitive Instructions",
};
const admin = new pg.Client({ connectionString: url });
const repository = createBankTransferRepository(url ?? "postgresql://disabled", {
  async encrypt() {
    return { ciphertext: Buffer.alloc(40, 1), keyArn: "key", accountLast4: "3000" };
  },
  async decrypt() {
    throw new Error("Settings must never decrypt");
  },
});
beforeAll(async () => {
  if (!url) return;
  await admin.connect();
  await admin.query(
    "INSERT INTO identity.users(id,email,name,status) VALUES ($1,$2,'Test','active')",
    [actorId, `${actorId}@example.test`],
  );
  for (const id of [propertyId, other])
    await admin.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES ($1::uuid,$1::text,'Test')",
      [id],
    );
});
afterAll(async () => {
  await repository.close();
  if (!url) return;
  await admin.query("BEGIN; SET LOCAL session_replication_role=replica");
  for (const table of [
    "platform.product_audit_events",
    "platform.idempotency_keys",
    "finance.bank_transfer_destinations",
  ])
    await admin.query(`DELETE FROM ${table} WHERE property_id=ANY($1::uuid[])`, [
      [propertyId, other],
    ]);
  await admin.query("DELETE FROM hotel_catalog.properties WHERE id=ANY($1::uuid[])", [
    [propertyId, other],
  ]);
  await admin.query("DELETE FROM identity.users WHERE id=$1", [actorId]);
  await admin.query("COMMIT");
  await admin.end();
});

it.skipIf(!url)(
  "persists only encrypted details; serializes replacement, retries and lifecycle audits",
  async () => {
    const command: BankTransferDestinationCommand = {
      propertyId,
      actorId,
      details,
      commandId: randomUUID(),
      expectedVersion: 0,
      action: "replace",
    };
    const created = await repository.execute(command);
    expect(created).toMatchObject({
      status: "applied",
      summary: { revision: 1, enabled: true, accountLast4: "3000" },
    });
    expect(await repository.read(other)).toBeNull();
    expect(await repository.execute(command)).toMatchObject({ status: "replayed" });
    expect(
      await repository.execute({ ...command, details: { ...details, bankName: "different" } }),
    ).toEqual({ status: "conflict" });
    const replacements = await Promise.all(
      [1, 2].map(() =>
        repository.execute({ ...command, commandId: randomUUID(), expectedVersion: 1 }),
      ),
    );
    expect(replacements.map((r) => r.status).sort()).toEqual(["applied", "conflict"]);
    expect(
      await repository.execute({
        ...command,
        commandId: randomUUID(),
        expectedVersion: 2,
        action: "disable",
        details: undefined,
      }),
    ).toMatchObject({ summary: { enabled: false } });
    expect(
      await repository.execute({
        ...command,
        commandId: randomUUID(),
        expectedVersion: 3,
        action: "delete",
        details: undefined,
      }),
    ).toMatchObject({ summary: { deleted: true, enabled: false } });
    expect(
      await repository.execute({ ...command, commandId: randomUUID(), expectedVersion: 2 }),
    ).toEqual({ status: "conflict" });
    expect(
      (
        await admin.query(
          "SELECT ciphertext FROM finance.bank_transfer_destinations WHERE property_id=$1",
          [propertyId],
        )
      ).rows,
    ).toEqual([{ ciphertext: null }, { ciphertext: null }]);
    const audits = (
      await admin.query(
        "SELECT * FROM platform.product_audit_events WHERE property_id=$1 ORDER BY occurred_at",
        [propertyId],
      )
    ).rows;
    expect(audits.map((r) => r.action)).toEqual(
      ["created", "replaced", "disabled", "deleted"].map(
        (v) => `finance.bank_transfer_destination.${v}`,
      ),
    );
    const retries = (
      await admin.query("SELECT * FROM platform.idempotency_keys WHERE property_id=$1", [
        propertyId,
      ])
    ).rows;
    for (const secret of Object.values(details).filter((v) => v !== "iban"))
      expect(JSON.stringify([audits, retries, created])).not.toContain(secret);
    await expect(
      repository.execute({
        ...command,
        commandId: randomUUID(),
        propertyId: other,
        actorId: randomUUID(),
      }),
    ).rejects.toThrow(/^Bank transfer destination unavailable\.$/);
    expect(await repository.read(other)).toBeNull();
  },
);
