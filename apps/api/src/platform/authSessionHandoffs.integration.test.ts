import { createHash } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgAuthSessionHandoffRepository } from "./authSessionHandoffs.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const codes = ["handoff-concurrency", "handoff-lease", "handoff-retention"];
const digests = codes.map((code) => createHash("sha256").update(code).digest("hex"));

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL auth session handoffs", () => {
  const pool = new pg.Pool({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    max: 4,
  });
  const repository = createPgAuthSessionHandoffRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    pool,
  });

  beforeAll(async () => {
    const url = new URL(TEST_DATABASE_URL!);
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
      throw new Error("Auth handoff integration tests require a local PostgreSQL database");
    }
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("allows only one concurrent claim and permits an explicit release", async () => {
    await createHandoff(digests[0]!, new Date(Date.now() + 60_000));
    const now = new Date();

    const [first, second] = await Promise.all([
      claim(digests[0]!, "11111111-1111-4111-8111-111111111111", now),
      claim(digests[0]!, "22222222-2222-4222-8222-222222222222", now),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);

    const winningRedemptionId = first
      ? "11111111-1111-4111-8111-111111111111"
      : "22222222-2222-4222-8222-222222222222";
    await repository.release({ redemptionId: winningRedemptionId });
    await expect(
      claim(digests[0]!, "33333333-3333-4333-8333-333333333333", now),
    ).resolves.toMatchObject({ sealedSession: "sealed-session" });
  });

  it("recovers an abandoned claim after the bounded lease", async () => {
    await createHandoff(digests[1]!, new Date(Date.now() + 60_000));
    const now = new Date();
    await expect(
      claim(digests[1]!, "44444444-4444-4444-8444-444444444444", now),
    ).resolves.not.toBeNull();

    await expect(
      claim(digests[1]!, "55555555-5555-4555-8555-555555555555", new Date(now.getTime() + 31_000)),
    ).resolves.not.toBeNull();
  });

  it("scrubs expired sealed-session material independently of handoff traffic", async () => {
    const now = new Date();
    await createHandoff(digests[2]!, new Date(now.getTime() + 60_000));
    await repository.scrubExpired({
      now: new Date(now.getTime() + 61_000),
      deleteBefore: new Date(0),
    });

    await expect(
      pool.query<{ consumed: boolean; sealedSession: string | null }>(
        `SELECT consumed_at IS NOT NULL AS consumed,
                sealed_session AS "sealedSession"
         FROM identity.auth_session_handoffs
         WHERE code_digest = $1`,
        [digests[2]],
      ),
    ).resolves.toMatchObject({ rows: [{ consumed: true, sealedSession: null }] });
  });

  it("does not scrub a redemption that was claimed before expiry and is still in flight", async () => {
    const codeDigest = createHash("sha256").update("handoff-active-expiry-race").digest("hex");
    digests.push(codeDigest);
    await createHandoff(codeDigest, new Date(Date.now() + 1_000));
    const now = new Date();
    const redemptionId = "66666666-6666-4666-8666-666666666666";
    await expect(claim(codeDigest, redemptionId, now)).resolves.not.toBeNull();

    await repository.scrubExpired({
      now: new Date(now.getTime() + 2_000),
      deleteBefore: new Date(0),
    });

    await expect(
      repository.complete({ now: new Date(now.getTime() + 2_100), redemptionId }),
    ).resolves.toBe(true);
  });

  function createHandoff(codeDigest: string, expiresAt: Date) {
    return repository.create({
      codeDigest,
      expiresAt,
      routingHints: { organizationId: "org_hotel_group" },
      sealedSession: "sealed-session",
      sourcePublicOrigin: "https://marketplace.localhost",
      sourceSurface: "marketplace-web",
      targetPath: "/dashboard",
      targetPublicOrigin: "https://admin.booking.localhost",
      targetSurface: "booking-admin",
    });
  }

  function claim(codeDigest: string, redemptionId: string, now: Date) {
    return repository.claim({
      codeDigest,
      now,
      redemptionId,
      targetPublicOrigin: "https://admin.booking.localhost",
      targetSurface: "booking-admin",
    });
  }

  async function cleanup() {
    await pool.query(
      `DELETE FROM identity.auth_session_handoffs
       WHERE code_digest = ANY($1::text[])`,
      [digests],
    );
  }
});
