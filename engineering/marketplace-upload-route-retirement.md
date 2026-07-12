# Marketplace Upload Route Retirement

VAY-824 records the marketplace upload route disposition from
`engineering/platform-media-decision.md` for the application cutover.

The marketplace frontend no longer calls these legacy product-owned upload
helpers for profile or offer media:

| Legacy route                                  | Disposition                               | Replacement                                                                                                             |
| --------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `POST /upload/image`                          | Retired generic product upload helper.    | `POST /api/media/upload-sessions` with explicit purpose and resource scope, followed by finalize.                       |
| `POST /upload/images`                         | Retired generic product upload helper.    | Batch `POST /api/media/upload-sessions` with explicit purpose and resource scope, followed by finalize.                 |
| `POST /upload/image/hotel-profile`            | Retired from marketplace-web upload flow. | Platform media `property.hero_image`; the target catalog/profile command attaches the platform media object ID.         |
| `POST /upload/image/listing`                  | Retired from marketplace-web upload flow. | Platform media `marketplace.offer.media`; offer commands attach returned platform media object IDs.                     |
| `POST /upload/images/listing`                 | Retired from marketplace-web upload flow. | Batch platform media `marketplace.offer.media`; offer commands attach returned platform media object IDs.               |
| `POST /upload/image/creator-profile`          | Retired from marketplace-web upload flow. | Platform media `marketplace.creator.profile_image`; creator profile commands attach returned platform media object IDs. |
| `POST /hotels/me/upload-picture`              | Retired deprecated helper.                | Same platform media/profile command flow as `property.hero_image`.                                                      |
| `POST /hotels/me/listings/{id}/upload-images` | Retired deprecated helper.                | Same platform media/offer command flow as `marketplace.offer.media`.                                                    |

`POST /upload/image/chat` is intentionally not retired by VAY-824. Chat
attachments move in VAY-825 through a collaboration message attachment command.

Residual dependency: the VAY-823 base exposes marketplace self-service command
contracts, but the TypeScript profile/offer write adapters are not present in
this branch. Until those adapters are merged and the frontend consumes them,
marketplace-web includes platform media object IDs in compatibility payloads
while preserving legacy URL fields for the existing Python endpoints.
