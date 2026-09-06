# VAY-1473 — old Booking map removal

This is the removal step of Location & Maps Rebuild. VAY-1472 records the
accepted replacement: automatic nearby places with optional hotel favorites,
hidden results and custom additions; distinguish Nearby from Recommended by us.
VAY-1475–VAY-1480 track the new contracts, discovery, persistence, host editor,
guest surface and data reconciliation.

## Removed graph

| Removed code | Consumers removed with it |
| --- | --- |
| Booking Web RoomMapPanel | Booking landing page split layout, map/list toggle, selection/hover state and scroll refs; RoomCard's map-selection props/outer button role; unused map thumbnail size. |
| Booking Web LocationMap | RoomDetailModal map block and map-only props; landing-page prop wiring. |
| Booking Admin LocationMapPreview | No remaining imports after VAY-1429; delete the orphan component. |
| Frontend POI types/map flags | Unused Booking Admin settings fields; Booking Web Hotel flags/POI shape; constant disabled public-adapter values; obsolete test fixture flag. |

Current target Booking Web always set both map flags false and POIs empty.
The normal room list and detail booking controls remain. RoomCard loses only
the outer map-selection interaction; image, detail, rate and booking controls
retain their existing behavior. The removal includes no replacement renderer.

## Retained boundaries

- Canonical hotel-catalog location, public precision rules and stored coordinates.
- Working shared product-onboarding Google address search/map and PMS location
  fields/read/write contracts. These support setup independently of old Booking maps.
- Backend compatibility response fields (currently false/empty). Removing these
  is a separate API contract change, not necessary to delete the frontend graph.
- Existing location/POI records and source migration evidence. No data mutation.
- Python services and shared provider infrastructure. No legacy implementation edits.

The deletion exceeds the usual PR size target because three old renderers are
removed wholesale. Keeping their connected callers in this PR avoids intermediate
broken imports. VAY-1473 explicitly records this removal-only exception.

Base: origin/main cc26628fb. Room detail changes already on this base, including
VAY-1032 amenities and VAY-1424 promotions, are retained.
