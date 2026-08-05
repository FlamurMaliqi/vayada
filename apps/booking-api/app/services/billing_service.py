"""Projected Fixed-plan fee and PMS room-count helpers."""

import logging

from app.config import settings as app_settings
from app.database import PmsDatabase

logger = logging.getLogger(__name__)


async def count_active_rooms(hotel_id: str) -> int:
    """Physical-inventory room count from pms_db, filtered to active room
    types. Returns 0 if PMS is unconfigured or the query fails (logged)."""
    if not app_settings.PMS_DATABASE_URL:
        return 0
    try:
        count = await PmsDatabase.fetchval(
            """
            SELECT COUNT(*)
              FROM rooms r
              JOIN room_types rt ON rt.id = r.room_type_id
             WHERE r.hotel_id = $1
               AND rt.is_active = TRUE
            """,
            hotel_id,
        )
        return int(count or 0)
    except Exception as exc:
        logger.warning("Failed to count active rooms: %s", exc)
        return 0


def compute_fixed_plan_projected_fee(
    base: float, rooms_included: int, per_extra: float, room_count: int
) -> float:
    """Fixed-plan monthly fee given ``room_count`` total active rooms:
    base fee plus ``per_extra`` per room beyond ``rooms_included``."""
    extras = max(0, room_count - rooms_included)
    return round(base + extras * per_extra, 2)
