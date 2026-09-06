import type { FastifyInstance } from "fastify";
import type { PublicHotelProfileRepository } from "./aiHotels.js";
import type { PublicNearbyRepository } from "../domains/publicNearbyRepository.js";
import type { PropertyNearbyDiscoveryRepository } from "../domains/propertyNearbyDiscoveryRepository.js";
import { discoverGoogleNearby } from "../integrations/googleNearbyPlaces.js";

export type PublicNearbyOptions = {
  repository: PublicNearbyRepository;
  discovery: PropertyNearbyDiscoveryRepository;
  apiKey?: string;
  discover?: typeof discoverGoogleNearby;
};
export async function registerPublicNearbyRoute(
  app: FastifyInstance,
  profiles: PublicHotelProfileRepository,
  options: PublicNearbyOptions,
) {
  app.addHook("onClose", async () => {
    await options.repository.close();
    await options.discovery.close();
  });
  // Explicitly public: the profile resolver and catalog projection enforce live publication gates.
  app.get<{ Params: { slug: string } }>("/hotels/:slug/nearby", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Robots-Tag", "noindex");
    const profile = await profiles.findProfileBySlug(request.params.slug);
    if (!profile) return reply.code(404).send({ code: "not_found" });
    const propertyId = profile.hotel.propertyId;
    let snapshot = await options.repository.read(propertyId);
    if (!snapshot) return reply.code(404).send({ code: "not_found" });
    if (snapshot.needsRefresh && options.apiKey?.trim()) {
      const claim = await options.discovery.claim(snapshot.scope, snapshot.revision);
      if (claim.status === "claimed") {
        const result = await (options.discover ?? discoverGoogleNearby)({
          apiKey: options.apiKey,
          origin: claim.origin,
        });
        await options.discovery.complete(
          snapshot.scope,
          claim.token,
          claim.profileRevision,
          result,
        );
      }
      // Re-read after paid I/O: revocation, source changes and curation edits take effect immediately.
      const current = await profiles.findProfileBySlug(request.params.slug);
      if (current?.hotel.propertyId !== propertyId)
        return reply.code(404).send({ code: "not_found" });
      snapshot = await options.repository.read(propertyId);
      if (!snapshot) return reply.code(404).send({ code: "not_found" });
    }
    return snapshot.public;
  });
}
