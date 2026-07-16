import { describe, expect, it, vi } from "vitest";

import type {
  PlatformMediaObjectRecord,
  PlatformMediaSessionRecord,
} from "../routes/platformMedia.js";
import { createPgPlatformMediaRepository } from "./platformMediaRepository.js";

const sessionId = "00000000-0000-4000-8000-000000000010";
const mediaId = "00000000-0000-4000-8000-000000000011";

describe("PostgreSQL platform media repository regressions", () => {
  it("leaves caller-owned pools open", async () => {
    const pool = fakePool();
    const repository = repositoryFor(pool);

    await repository.close?.();

    expect(pool.end).not.toHaveBeenCalled();
  });

  it("ignores malformed completed-media snapshot IDs", async () => {
    const completedSession = {
      status: "completed",
      completedMediaObjects: [{ mediaId: "https://legacy.example/photo.jpg" }],
    } as PlatformMediaSessionRecord;
    const mediaObject = { mediaId } as PlatformMediaObjectRecord;
    const pool = fakePool(async (text) => {
      if (text.includes("completion_metadata -> 'session'")) {
        return {
          rows: [
            {
              session: completedSession,
              completedMediaObjectId: mediaId,
              mediaObjectIds: ["https://legacy.example/photo.jpg"],
            },
          ],
        };
      }
      if (text.includes("FROM platform.media_objects media")) {
        return { rows: [{ record: mediaObject }] };
      }
      return { rows: [] };
    });

    await expect(repositoryFor(pool).findUploadSession(sessionId)).resolves.toMatchObject({
      completedMediaObject: mediaObject,
      completedMediaObjects: [mediaObject],
    });
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[1]?.[1]).toEqual([mediaId]);
  });
});

function repositoryFor(pool: ReturnType<typeof fakePool>) {
  return createPgPlatformMediaRepository({
    connectionString: "postgresql://target.test/vayada",
    publicCdnBaseUrl: "https://cdn.example.com",
    pool: pool as never,
  });
}

function fakePool(
  queryImplementation: (
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: unknown[] }> = async () => ({ rows: [] }),
) {
  return {
    query: vi.fn(queryImplementation),
    connect: vi.fn(),
    end: vi.fn(async () => undefined),
  };
}
