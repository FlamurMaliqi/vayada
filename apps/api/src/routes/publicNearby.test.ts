import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { registerPublicNearbyRoute } from "./publicNearby.js";
import type { PublicHotelProfileRepository } from "./aiHotels.js";
import type { PublicNearbySnapshot } from "../domains/publicNearbyRepository.js";
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function setup() {
  const app = Fastify();
  apps.push(app);
  const publicView = {
    schemaVersion: 1 as const,
    status: "unavailable" as const,
    location: { mode: "approximate" as const, latitude: 1.01, longitude: 2.02 },
    places: [],
  };
  const snapshot: PublicNearbySnapshot = {
    scope: { propertyId: "property", organizationId: "private-org" },
    revision: 1,
    needsRefresh: true,
    public: publicView,
  };
  const read = vi.fn().mockResolvedValue(snapshot);
  const profile = vi.fn().mockResolvedValue({ hotel: { propertyId: "property" } });
  const discover = vi.fn().mockResolvedValue({ status: "provider_unavailable", places: [] });
  const claim = vi
    .fn()
    .mockResolvedValue({
      status: "claimed",
      token: "private-token",
      profileRevision: 1,
      origin: { latitude: 1.01, longitude: 2.02 },
    });
  const complete = vi.fn();
  await registerPublicNearbyRoute(
    app,
    { findProfileBySlug: profile } as PublicHotelProfileRepository,
    {
      repository: { read, close: vi.fn() },
      discovery: { read: vi.fn(), claim, complete, close: vi.fn() },
      apiKey: "server-secret",
      discover,
    },
  );
  return { app, read, profile, discover, claim, complete, snapshot, publicView };
}
it("refreshes once with public origin and returns only the public envelope even on provider failure", async () => {
  const s = await setup();
  const response = await s.app.inject("/hotels/example/nearby");
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(s.publicView);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(s.discover).toHaveBeenCalledWith({
    apiKey: "server-secret",
    origin: { latitude: 1.01, longitude: 2.02 },
  });
  expect(s.complete).toHaveBeenCalledOnce();
  expect(s.read).toHaveBeenCalledTimes(2);
  expect(response.body).not.toMatch(/server-secret|private-org|private-token|revision/i);
});
it("returns 404 before paid requests for unpublished or denied properties", async () => {
  const s = await setup();
  s.profile.mockResolvedValueOnce(null);
  expect((await s.app.inject("/hotels/missing/nearby")).statusCode).toBe(404);
  s.read.mockResolvedValueOnce(null);
  expect((await s.app.inject("/hotels/denied/nearby")).statusCode).toBe(404);
  expect(s.claim).not.toHaveBeenCalled();
});
it("rechecks revocation and hidden-location changes after I/O", async () => {
  const s = await setup();
  s.read.mockResolvedValueOnce(s.snapshot).mockResolvedValueOnce(null);
  expect((await s.app.inject("/hotels/revoked/nearby")).statusCode).toBe(404);
  s.read
    .mockResolvedValueOnce(s.snapshot)
    .mockResolvedValueOnce({
      ...s.snapshot,
      public: { schemaVersion: 1, status: "hidden", location: null, places: [] },
    });
  expect((await s.app.inject("/hotels/hidden/nearby")).json()).toEqual({
    schemaVersion: 1,
    status: "hidden",
    location: null,
    places: [],
  });
});
it("does not search during cooldown, a shared lease or a current snapshot", async () => {
  const s = await setup();
  s.claim.mockResolvedValue({ status: "cooldown", retryAfter: "private-time" });
  expect((await s.app.inject("/hotels/example/nearby")).statusCode).toBe(200);
  s.read.mockResolvedValue({ ...s.snapshot, needsRefresh: false });
  expect((await s.app.inject("/hotels/example/nearby")).statusCode).toBe(200);
  expect(s.discover).not.toHaveBeenCalled();
  expect(s.claim).toHaveBeenCalledOnce();
});
