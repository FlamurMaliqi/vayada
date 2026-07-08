# Booking/PMS Media Route Retirement

VAY-826 replaces Booking and PMS image-upload ownership with platform media.
Product surfaces keep business commands, but storage, source downloads, variants,
and media lifecycle move to `apps/api` platform media routes.

| Legacy route or path                                  | Disposition                                                            | Replacement                                                                                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Booking API `POST /admin/upload/images`               | Retired. The Booking-to-PMS proxy route is no longer registered.       | Booking Admin calls `POST /api/media/upload-sessions` directly with `property.hero_image` or `property.gallery_image`.                  |
| Booking Admin direct PMS `POST /upload/images` helper | Retired. Browser uploads no longer target PMS API.                     | Booking Admin direct-to-platform upload session and finalize flow.                                                                      |
| PMS API `POST /upload/images`                         | Retired. The generic room image upload router is no longer registered. | PMS Web calls `POST /api/media/upload-sessions` with `pms.room_type.media` and persists platform media references in room image arrays. |
| PMS API `POST /admin/import/images`                   | Retired with the PMS listing import feature.                           | None.                                                                                                                                   |
| PMS import confirm background image download          | Retired with the PMS listing import feature.                           | None.                                                                                                                                   |

Out of scope: PMS messaging attachments stay on the existing PMS/Channex command
surface until VAY-827.
