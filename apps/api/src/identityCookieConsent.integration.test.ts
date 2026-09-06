import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPgIdentityPrivacyRepository,
  type IdentityPrivacyPool,
} from "./routes/identityPrivacy.js";

const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("identity cookie consent transactions", () => {
  const pool = new pg.Pool({ connectionString: url });
  const repository = createPgIdentityPrivacyRepository({
    connectionString: url ?? "disabled",
    pool,
  });
  const visitors: string[] = [];
  const choice = (analytics = false) => {
    const visitorId = `vay1496_${randomUUID()}`;
    visitors.push(visitorId);
    return { visitorId, functional: false, analytics, marketing: false };
  };
  beforeAll(() => {
    if (!/(test|verify)/i.test(new URL(url!).pathname))
      throw new Error("Refusing non-test database");
  });
  afterAll(async () => {
    await pool.query("DELETE FROM identity.consent_history WHERE visitor_id = ANY($1)", [visitors]);
    await pool.query("DELETE FROM identity.cookie_consents WHERE visitor_id = ANY($1)", [visitors]);
    await pool.end();
  });
  const history = async (visitor: string) =>
    (
      await pool.query(
        "SELECT * FROM identity.consent_history WHERE visitor_id = $1 ORDER BY created_at, id",
        [visitor],
      )
    ).rows;

  it("commits one anonymous state/history pair for concurrent repeated choices", async () => {
    const input = choice(true);
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => repository.upsertCookieConsent(input)),
    );
    expect(new Set(responses.map((row) => row.id)).size).toBe(1);
    expect(new Set(responses.map((row) => row.updated_at)).size).toBe(1);
    expect(responses.every((row) => row.user_id === null)).toBe(true);
    expect(await history(input.visitorId)).toMatchObject([
      {
        user_id: null,
        consent_given: true,
        version: "1",
        metadata: { analytics: true, functional: false, marketing: false },
      },
    ]);
    const retried = await repository.upsertCookieConsent(input);
    expect(retried.updated_at).toBe(responses[0]!.updated_at);
    expect(await history(input.visitorId)).toHaveLength(1);
  });

  it("serializes different concurrent choices with matching final history", async () => {
    const input = choice();
    await repository.upsertCookieConsent(input);
    await Promise.all([
      repository.upsertCookieConsent({ ...input, analytics: true }),
      repository.upsertCookieConsent({ ...input, marketing: true }),
    ]);
    const current = await repository.findCookieConsent(input.visitorId);
    const events = await history(input.visitorId);
    expect(events).toHaveLength(3);
    // Each competing transaction has a distinct choice and its own committed history.
    expect(events.map((row) => row.metadata)).toEqual(
      expect.arrayContaining([
        { functional: false, analytics: false, marketing: false },
        { functional: false, analytics: true, marketing: false },
        { functional: false, analytics: false, marketing: true },
      ]),
    );
    expect(current).toMatchObject(events.at(-1)!.metadata);
    expect(current?.functional).toBe(false);
    expect(current?.analytics !== current?.marketing).toBe(true);
    const withdrawn = await repository.upsertCookieConsent(input);
    expect(withdrawn).toMatchObject({ analytics: false, marketing: false });
    expect((await history(input.visitorId)).filter((row) => !row.consent_given)).toHaveLength(2);
  });

  it("hides historical account linkage and keeps new visitor history anonymous", async () => {
    const input = choice();
    const userId = randomUUID();
    await pool.query("INSERT INTO identity.users (id, email) VALUES ($1, $2)", [
      userId,
      `${userId}@example.test`,
    ]);
    try {
      await repository.upsertCookieConsent(input);
      await pool.query("UPDATE identity.cookie_consents SET user_id = $1 WHERE visitor_id = $2", [
        userId,
        input.visitorId,
      ]);
      expect(await repository.findCookieConsent(input.visitorId)).toMatchObject({ user_id: null });
      expect(await repository.upsertCookieConsent(input)).toMatchObject({ user_id: null });
      expect(await repository.upsertCookieConsent({ ...input, analytics: true })).toMatchObject({
        user_id: null,
      });
      expect((await history(input.visitorId)).every((row) => row.user_id === null)).toBe(true);
      expect(await repository.listConsentHistory({ userId, limit: 10, offset: 0 })).toEqual({
        history: [],
        total: 0,
      });
    } finally {
      await pool.query("DELETE FROM identity.users WHERE id = $1", [userId]);
    }
  });

  it.each([false, true])("rolls back %s existing state when history fails", async (existing) => {
    const input = choice();
    const before = existing ? await repository.upsertCookieConsent(input) : null;
    const failingPool: IdentityPrivacyPool = {
      query: pool.query.bind(pool),
      end: async () => {},
      async connect() {
        const client = await pool.connect();
        return {
          async query<T extends pg.QueryResultRow>(text: string, values?: readonly unknown[]) {
            if (text.includes("INSERT INTO identity.consent_history"))
              throw new Error("injected history failure");
            return client.query<T>(text, values ? [...values] : undefined);
          },
          release: () => client.release(),
        };
      },
    };
    const failing = createPgIdentityPrivacyRepository({
      connectionString: url!,
      pool: failingPool,
    });
    await expect(failing.upsertCookieConsent({ ...input, analytics: true })).rejects.toThrow(
      "injected history failure",
    );
    expect(await repository.findCookieConsent(input.visitorId)).toEqual(before);
    expect(await history(input.visitorId)).toHaveLength(existing ? 1 : 0);
    // A retry succeeds on a fresh transaction; no lock or partial state remains.
    await expect(
      repository.upsertCookieConsent({ ...input, analytics: true }),
    ).resolves.toMatchObject({ analytics: true });
  });
});
