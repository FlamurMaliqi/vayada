# Booking/PMS Media Route Retirement

VAY-826 replaces Booking and PMS image-upload ownership with platform media.
Product surfaces keep business commands, but storage, source downloads, variants,
and media lifecycle move to `apps/api` platform media routes.

The canonical Python-backed PMS frontend remains frozen on `POST /upload/images`.
That compatibility route must stay registered in `pms-api` until the canonical
frontend is migrated or retired. Target/next PMS uploads still use platform media.

| Legacy route or path                                  | Disposition                                                        | Replacement                                                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Booking API `POST /admin/upload/images`               | Retired. The Booking-to-PMS proxy route is no longer registered.   | Booking Admin calls `POST /api/media/upload-sessions` directly with `property.hero_image` or `property.gallery_image`.                   |
| Booking Admin direct PMS `POST /upload/images` helper | Retired. Browser uploads no longer target PMS API.                 | Booking Admin direct-to-platform upload session and finalize flow.                                                                       |
| PMS API `POST /upload/images`                         | Compatibility route required by the canonical legacy PMS frontend. | Target PMS Web calls `POST /api/media/upload-sessions` with `pms.room_type.media`; remove the legacy route only after canonical cutover. |
| PMS API `POST /admin/import/images`                   | Retired with the PMS listing import feature.                       | None.                                                                                                                                    |
| PMS import confirm background image download          | Retired with the PMS listing import feature.                       | None.                                                                                                                                    |

Out of scope: PMS messaging attachments stay on the existing PMS/Channex command
surface until VAY-827.
