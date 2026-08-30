import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import type {
  MarketplaceBuildContext,
  MarketplaceResourceLink,
  ProductionMarketplaceTargetState,
} from "./productionMarketplaceTypes.js";
import { requiredText, uuid } from "./productionBookingValues.js";

export function createProductionMarketplaceContext(input: {
  sourceRunId: string;
  completedAt: string;
  rows: IdentitySourceRow[];
  target: ProductionMarketplaceTargetState;
}): MarketplaceBuildContext {
  const context: MarketplaceBuildContext = {
    ...input,
    blockers: [...(input.target.blockers ?? [])],
    rowsByTable: groupBy(input.rows, (row) => row.sourceTable),
    creatorById: new Map(),
    hotelById: new Map(),
    offerById: new Map(),
    collaborationById: new Map(),
    tripById: new Map(),
    creatorOrganizationById: new Map(),
    hotelOrganizationById: new Map(),
    propertyByHotelId: new Map(),
    users: new Set(input.target.userIds.map((id) => id.toLowerCase())),
    userNameById: new Map(input.target.userNames.map((user) => [user.id.toLowerCase(), user.name])),
    publicPropertyById: new Map(
      input.target.publicProperties.map((property) => [property.propertyId, property]),
    ),
    mediaBySourceUrl: groupBy(input.target.media, (media) => media.sourceUrl),
  };

  context.creatorById = indexSource(context, "creators");
  context.hotelById = indexSource(context, "hotel_profiles");
  context.offerById = indexSource(context, "hotel_listings");
  context.collaborationById = indexSource(context, "collaborations");
  context.tripById = indexSource(context, "trips");
  context.creatorOrganizationById = indexResourceLinks(context, "creator_profile");
  context.hotelOrganizationById = indexResourceLinks(context, "hotel_profile");

  for (const link of input.target.propertyLinks) {
    const sourceId = link.sourceId.toLowerCase();
    if (
      link.migrationRunId !== input.sourceRunId ||
      link.relationship !== "profile_input" ||
      link.status !== "active"
    ) {
      block(
        context,
        "MARKETPLACE_PROPERTY_LINK_INVALID",
        "marketplace.hotel_profiles",
        sourceId,
        "Canonical property link is not an active link from this extraction run",
      );
      continue;
    }
    const prior = context.propertyByHotelId.get(sourceId);
    if (prior && prior !== link.propertyId) {
      block(
        context,
        "AMBIGUOUS_MARKETPLACE_PROPERTY",
        "marketplace.hotel_profiles",
        sourceId,
        "Legacy hotel profile resolves to multiple canonical properties",
      );
      context.propertyByHotelId.delete(sourceId);
      continue;
    }
    context.propertyByHotelId.set(sourceId, link.propertyId.toLowerCase());
  }
  return context;
}

function indexSource(
  context: MarketplaceBuildContext,
  table: string,
): Map<string, IdentitySourceRow> {
  const indexed = new Map<string, IdentitySourceRow>();
  const duplicates = new Set<string>();
  for (const row of context.rowsByTable.get(table) ?? []) {
    try {
      const id = uuid(row.data["id"], "id");
      if (indexed.has(id)) duplicates.add(id);
      else indexed.set(id, row);
    } catch (error) {
      block(
        context,
        "INVALID_SOURCE_ROW",
        `marketplace.${table}`,
        String(row.rowOrdinal),
        error instanceof Error ? error.message : "Source identity is invalid",
      );
    }
  }
  for (const id of duplicates) {
    indexed.delete(id);
    block(
      context,
      "DUPLICATE_SOURCE_ID",
      `marketplace.${table}`,
      id,
      "More than one source row has this identity",
    );
  }
  return indexed;
}

function indexResourceLinks(
  context: MarketplaceBuildContext,
  resourceType: string,
): Map<string, string> {
  const result = new Map<string, string>();
  const duplicates = new Set<string>();
  for (const link of context.target.resourceLinks.filter(
    (entry) => entry.resourceType === resourceType && entry.relationship === "owner",
  )) {
    const id = link.resourceId.toLowerCase();
    if (!["active", "suspended", "archived"].includes(link.status)) {
      block(
        context,
        "MARKETPLACE_OWNER_LINK_INVALID",
        `identity.organization_resource_links.${resourceType}`,
        id,
        "Marketplace resource owner link is invalid",
      );
      continue;
    }
    const prior = result.get(id);
    if (prior && prior !== link.organizationId) duplicates.add(id);
    else result.set(id, link.organizationId.toLowerCase());
  }
  for (const id of duplicates) {
    result.delete(id);
    block(
      context,
      "AMBIGUOUS_MARKETPLACE_OWNER",
      `identity.organization_resource_links.${resourceType}`,
      id,
      "Marketplace resource has multiple owner organizations",
    );
  }
  return result;
}

export function creatorOrganization(context: MarketplaceBuildContext, creatorId: unknown): string {
  const id = uuid(creatorId, "creator_id");
  const organizationId = context.creatorOrganizationById.get(id);
  if (!context.creatorById.has(id)) throw new Error(`creator ${id} is missing`);
  if (!organizationId) throw new Error(`creator ${id} has no accepted owner organization`);
  return organizationId;
}

export function hotelScope(
  context: MarketplaceBuildContext,
  hotelId: unknown,
): { propertyId: string; organizationId: string } {
  const id = uuid(hotelId, "hotel_profile_id");
  if (!context.hotelById.has(id)) throw new Error(`hotel profile ${id} is missing`);
  const propertyId = context.propertyByHotelId.get(id);
  const organizationId = context.hotelOrganizationById.get(id);
  if (!propertyId) throw new Error(`hotel profile ${id} has no canonical property`);
  if (!organizationId) throw new Error(`hotel profile ${id} has no accepted owner organization`);
  return { propertyId, organizationId };
}

export function offerScope(
  context: MarketplaceBuildContext,
  offerId: unknown,
): { offer: IdentitySourceRow; propertyId: string; organizationId: string } {
  const id = uuid(offerId, "listing_id");
  const offer = context.offerById.get(id);
  if (!offer) throw new Error(`hotel listing ${id} is missing`);
  return { offer, ...hotelScope(context, offer.data["hotel_profile_id"]) };
}

export function collaborationScope(
  context: MarketplaceBuildContext,
  collaborationId: unknown,
): {
  collaboration: IdentitySourceRow;
  creatorId: string;
  creatorOrganizationId: string;
  offerId: string;
  propertyId: string;
  hotelOrganizationId: string;
} {
  const id = uuid(collaborationId, "collaboration_id");
  const collaboration = context.collaborationById.get(id);
  if (!collaboration) throw new Error(`collaboration ${id} is missing`);
  const creatorId = uuid(collaboration.data["creator_id"], "creator_id");
  const creatorOrganizationId = creatorOrganization(context, creatorId);
  const offerId = uuid(collaboration.data["listing_id"], "listing_id");
  const offer = offerScope(context, offerId);
  const hotelId = uuid(collaboration.data["hotel_id"], "hotel_id");
  const hotel = hotelScope(context, hotelId);
  if (offer.propertyId !== hotel.propertyId || offer.organizationId !== hotel.organizationId)
    throw new Error("collaboration hotel and listing ownership disagree");
  return {
    collaboration,
    creatorId,
    creatorOrganizationId,
    offerId,
    propertyId: offer.propertyId,
    hotelOrganizationId: offer.organizationId,
  };
}

export function requireUser(
  context: MarketplaceBuildContext,
  value: unknown,
  field: string,
): string {
  const id = uuid(value, field);
  if (!context.users.has(id)) throw new Error(`${field} references a missing target user`);
  return id;
}

export function optionalUser(
  context: MarketplaceBuildContext,
  value: unknown,
  field: string,
): string | null {
  if (value === null || value === undefined || value === "") return null;
  return requireUser(context, value, field);
}

export function sourceIdentity(row: IdentitySourceRow): string {
  return requiredText(row.data["id"], "id").toLowerCase();
}

export function block(
  context: MarketplaceBuildContext,
  code: string,
  source: string,
  sourceId: string,
  message: string,
): void {
  context.blockers.push({ code, source, sourceId, message });
}

function groupBy<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const value of values) {
    const label = key(value);
    const group = result.get(label);
    if (group) group.push(value);
    else result.set(label, [value]);
  }
  return result;
}

export function resourceLinkFor(
  links: MarketplaceResourceLink[],
  resourceType: string,
  resourceId: string,
): MarketplaceResourceLink | undefined {
  return links.find(
    (link) =>
      link.resourceType === resourceType &&
      link.resourceId.toLowerCase() === resourceId &&
      link.relationship === "owner",
  );
}
