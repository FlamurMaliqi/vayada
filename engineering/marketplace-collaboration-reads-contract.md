# Marketplace collaboration reads

Contract version: `marketplace-collaboration-reads.v1`.

## Endpoints

| Surface           | Route                                                                       |
| ----------------- | --------------------------------------------------------------------------- |
| My collaborations | `GET /api/marketplace/collaborations/me?side=creator\|hotel`                |
| Detail            | `GET /api/marketplace/collaborations/{collaborationId}?side=creator\|hotel` |
| Conversations     | `GET /api/marketplace/collaborations/conversations`                         |
| Messages          | `GET /api/marketplace/collaborations/{collaborationId}/messages`            |

Creator reads require `marketplace.collaboration.read` plus an active owner link
to the creator profile. Hotel reads require the same permission plus an active
owner/operator link to the collaboration's `marketplace_offer`. A hotel-profile
link by itself does not authorize a specific offer collaboration.

## Response

```ts
type MarketplaceCollaborationRead = {
  collaborationId: string;
  offerId: string;
  creatorId: string;
  hotelProfileId: string;
  side: "creator" | "hotel";
  initiatorSide: "creator" | "hotel";
  status: CollaborationStatus;
  compensationType: "free_stay" | "paid" | "discount" | "custom" | null;
  offerTitle: string;
  hotelLocation: string | null;
  creator: MarketplaceCollaborationParticipant;
  hotel: MarketplaceCollaborationParticipant;
  terms: {
    freeStayMinNights: number | null;
    freeStayMaxNights: number | null;
    paidAmount: string | null;
    currency: string | null;
    discountPercentage: number | null;
    affiliateEnabled: boolean;
    affiliateCommissionPercentage: string | null;
    travelDateFrom: string | null;
    travelDateTo: string | null;
    preferredDateFrom: string | null;
    preferredDateTo: string | null;
    preferredMonths: string[];
  };
  deliverables: MarketplaceCollaborationDeliverable[];
};
```

`offerId` is `marketplace.marketplace_offers.id`. `offerTitle` comes from the
offer; `hotelLocation` and hotel display data come from the canonical hotel
catalog. Affiliate participation is independent from primary compensation.

Conversation summaries expose `offerTitle`. Private identity data, precise geo,
source migration IDs, negotiated metadata, and affiliate links are excluded.

Fixture coverage lives in
`engineering/fixtures/marketplace-collaboration-reads/cases.json`.
