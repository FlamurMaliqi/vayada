"""Channex sync orchestration — full-hotel and per-booking ARI dispatch."""

import logging
from datetime import UTC, date, datetime
from decimal import Decimal

from app.repositories.booking_repo import BookingRepository
from app.repositories.channex_mapping_repo import (
    ChannexChannelMarkupRepository,
    ChannexConnectionRepository,
    ChannexRatePlanMappingRepository,
    ChannexRoomTypeMappingRepository,
)
from app.services.channex.ari_push import (
    push_availability_for_room_type,
    push_restrictions_for_rate_plan,
)

logger = logging.getLogger(__name__)


async def _push_ari_for_room_type_payload(
    hotel_id: str,
    room_type_id: str,
    markup_map: dict,
    start_date: date | None = None,
    end_date: date | None = None,
) -> None:
    availability_ok = await push_availability_for_room_type(
        hotel_id,
        room_type_id,
        start_date=start_date,
        end_date=end_date,
    )
    if not availability_ok:
        raise RuntimeError(
            getattr(
                availability_ok,
                "error",
                f"availability push failed for room type {room_type_id}",
            )
        )

    rate_plans = await ChannexRatePlanMappingRepository.list_by_room_type_id(room_type_id)
    for rp in rate_plans:
        channel = rp.get("channel", "direct")
        restrictions_ok = await push_restrictions_for_rate_plan(
            hotel_id,
            room_type_id,
            str(rp["channex_rate_plan_id"]),
            plan_name=rp.get("plan_name", "standard"),
            channel=channel,
            markup_pct=markup_map.get(channel, Decimal(0)),
            start_date=start_date,
            end_date=end_date,
            meal_plan_code=int(rp.get("meal_plan_code") or 0),
        )
        if not restrictions_ok:
            raise RuntimeError(
                getattr(
                    restrictions_ok,
                    "error",
                    "restrictions push failed for room type "
                    f"{room_type_id} rate plan {rp['channex_rate_plan_id']}",
                )
            )


async def push_ari_for_room_type(
    hotel_id: str,
    room_type_id: str,
    start_date: date | None = None,
    end_date: date | None = None,
) -> bool:
    """Targeted availability + restrictions sync for one mapped room type."""
    markup_map = await ChannexChannelMarkupRepository.get_markup_map(hotel_id)

    try:
        await _push_ari_for_room_type_payload(
            hotel_id,
            room_type_id,
            markup_map,
            start_date=start_date,
            end_date=end_date,
        )
    except Exception as e:
        await ChannexConnectionRepository.record_ari_sync_error(
            hotel_id,
            str(e),
            datetime.now(UTC),
        )
        logger.error("Targeted Channex ARI sync failed for hotel %s: %s", hotel_id, e)
        return False

    await ChannexConnectionRepository.update_last_ari_sync(hotel_id, datetime.now(UTC))
    logger.info(
        "Targeted ARI sync completed for hotel %s room type %s",
        hotel_id,
        room_type_id,
    )
    return True


async def push_ari_for_hotel(hotel_id: str) -> bool:
    """Full availability + restrictions sync for all mapped room types in a hotel."""
    room_mappings = await ChannexRoomTypeMappingRepository.list_by_hotel_id(hotel_id)
    markup_map = await ChannexChannelMarkupRepository.get_markup_map(hotel_id)

    try:
        for mapping in room_mappings:
            await _push_ari_for_room_type_payload(
                hotel_id,
                str(mapping["room_type_id"]),
                markup_map,
            )
    except Exception as e:
        await ChannexConnectionRepository.record_ari_sync_error(
            hotel_id,
            str(e),
            datetime.now(UTC),
        )
        logger.error("Full Channex ARI sync failed for hotel %s: %s", hotel_id, e)
        return False

    await ChannexConnectionRepository.update_last_ari_sync(hotel_id, datetime.now(UTC))
    logger.info("Full ARI sync completed for hotel %s", hotel_id)
    return True


async def push_ari_for_booking(booking_id: str) -> bool:
    """Targeted ARI sync after a booking changes — only affected room type + dates."""
    try:
        booking = await BookingRepository.get_by_id(booking_id)
        if not booking:
            return True

        hotel_id = str(booking["hotel_id"])
        room_type_id = str(booking["room_type_id"])

        conn = await ChannexConnectionRepository.get_by_hotel_id(hotel_id)
        if not conn or not conn["is_active"]:
            return True

        pushed = await push_availability_for_room_type(
            hotel_id,
            room_type_id,
            start_date=booking["check_in"],
            end_date=booking["check_out"],
        )
        return pushed is not False
    except Exception as e:
        logger.error("Failed to push ARI for booking %s: %s", booking_id, e)
        return False
