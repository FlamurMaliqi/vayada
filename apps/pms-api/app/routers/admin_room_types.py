import asyncio
import json
import logging
from datetime import date

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query

from app.database import Database
from app.dependencies import require_hotel_admin
from app.models.room_type import (
    MonthlyRate,
    RoomTypeAdminResponse,
    RoomTypeCreate,
    RoomTypeUpdate,
)
from app.repositories.channex_mapping_repo import ChannexConnectionRepository
from app.repositories.linked_inventory_group_repo import LinkedInventoryGroupRepository
from app.repositories.room_repo import RoomRepository
from app.repositories.room_type_repo import RoomTypeRepository
from app.services import fixed_plan_billing
from app.services.channex.orchestrator import push_ari_for_hotel
from app.services.channex.provisioning import provision_property
from app.services.channex_sync_service import push_cancellation_policy_for_room_type
from app.services.hotel_identity_service import get_currency as get_be_currency
from app.utils import get_hotel_id, parse_jsonb

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin-room-types"])


def _parse_monthly_rates(val) -> dict:
    raw = val if val else {}
    if isinstance(raw, str):
        raw = json.loads(raw)
    result = {}
    for k, v in raw.items():
        result[k] = MonthlyRate(
            base_rate=v.get("base_rate"),
            non_refundable_rate=v.get("non_refundable_rate"),
        )
    return result


def _room_to_admin(room: dict) -> RoomTypeAdminResponse:
    nr_rate = room.get("non_refundable_rate")
    return RoomTypeAdminResponse(
        id=str(room["id"]),
        hotel_id=str(room["hotel_id"]),
        name=room["name"],
        category=room.get("category", ""),
        description=room["description"],
        short_description=room["short_description"],
        max_occupancy=room["max_occupancy"],
        max_adults=room.get("max_adults"),
        max_children=room.get("max_children"),
        bedrooms=room.get("bedrooms", 1),
        bathrooms=room.get("bathrooms", 1),
        size=room["size"],
        base_rate=float(room["base_rate"]),
        non_refundable_rate=float(nr_rate) if nr_rate is not None else None,
        currency=room["currency"],
        location_address=room.get("location_address", "") or "",
        latitude=float(room["latitude"]) if room.get("latitude") is not None else None,
        longitude=float(room["longitude"]) if room.get("longitude") is not None else None,
        amenities=parse_jsonb(room["amenities"]),
        images=parse_jsonb(room["images"]),
        bed_type=room["bed_type"],
        features=parse_jsonb(room["features"]),
        benefits=parse_jsonb(room.get("benefits", [])),
        total_rooms=room["total_rooms"],
        is_active=room["is_active"],
        sort_order=room["sort_order"],
        monthly_rates=_parse_monthly_rates(room.get("monthly_rates")),
        daily_rates=parse_jsonb(room.get("daily_rates", {})),
        operating_periods=parse_jsonb(room.get("operating_periods", [])),
        seasons=parse_jsonb(room.get("seasons", [])),
        weekend_surcharge=room.get("weekend_surcharge") or "+0%",
        cancellation_policy=room.get("cancellation_policy") or "Free until 7 days before",
        flexible_rate_enabled=room.get("flexible_rate_enabled", True),
        flexible_cancellation_type=room.get("flexible_cancellation_type") or "free",
        partial_refund_cancel_window_days=room.get("partial_refund_cancel_window_days", 30),
        partial_refund_amount_percent=room.get("partial_refund_amount_percent", 50),
        partial_refund_tiers=parse_jsonb(room.get("partial_refund_tiers", [])),
        non_refundable_enabled=room.get("non_refundable_enabled", False),
        non_refundable_discount=room.get("non_refundable_discount", 5),
        non_refundable_cancellation_policy=room.get("non_refundable_cancellation_policy")
        or "Non-refundable from booking",
        last_minute_discount=(lambda v: v if isinstance(v, dict) else None)(
            parse_jsonb(room.get("last_minute_discount"))
        ),
        minimum_advance_days=room.get("minimum_advance_days") or 0,
        rate_payment_methods=(lambda v: v if isinstance(v, dict) else None)(
            parse_jsonb(room.get("rate_payment_methods"))
        ),
        rate_deposit_settings=(lambda v: v if isinstance(v, dict) else None)(
            parse_jsonb(room.get("rate_deposit_settings"))
        ),
        meal_plans=parse_jsonb(room.get("meal_plans", [])),
        created_at=room["created_at"].isoformat(),
        updated_at=room["updated_at"].isoformat(),
    )


async def _reconcile_rooms_to_total(
    hotel_id: str, room_type_id: str, desired: int, room_type_name: str
) -> None:
    """Make COUNT(rooms) for this room type equal `desired` (VAY-406).

    The number of physical rooms is what total_rooms mirrors — see
    migration 074. Rather than letting the column drift (the VAY-402
    bug), this reconciles the rooms themselves and lets the DB trigger
    rewrite total_rooms.

    - desired == current: no-op.
    - desired > current: append the missing rooms via _auto_create_rooms
      so numbering stays sequential ("<Name> N").
    - desired < current: drop the tail of the room list — the rooms a
      caller is "least likely to have customized" (lowest numeric
      suffix kept first, sort_order, created_at). Atomic: if ANY of
      those rooms is referenced by a non-cancelled booking (primary or
      via booking_rooms), raise 409 and delete nothing, so the user
      reassigns/cancels first.
    """
    if desired < 0:
        raise HTTPException(status_code=400, detail="totalRooms must be at least 0")

    rooms = await RoomRepository.list_for_reconciliation(room_type_id)
    current = len(rooms)
    if desired == current:
        return
    if desired > current:
        await _auto_create_rooms(hotel_id, room_type_id, desired - current, room_type_name)
        return

    to_remove = rooms[desired:]
    room_ids = [str(r["id"]) for r in to_remove]
    blocking = await RoomRepository.active_bookings_referencing(room_ids)
    if blocking:
        blocked_room_ids = {str(row["room_id"]) for row in blocking}
        raise HTTPException(
            status_code=409,
            detail={
                "code": "rooms_have_bookings",
                "message": (
                    f"Cannot reduce Total Rooms — {len(blocked_room_ids)} of the "
                    f"{len(to_remove)} rooms that would be removed still have "
                    "active reservations. Reassign or cancel them first."
                ),
                "blockingBookings": [
                    {
                        "bookingId": str(row["booking_id"]),
                        "bookingReference": row["booking_reference"],
                        "status": row["status"],
                        "checkIn": row["check_in"].isoformat(),
                        "checkOut": row["check_out"].isoformat(),
                        "roomId": str(row["room_id"]),
                        "roomNumber": row["room_number"],
                    }
                    for row in blocking
                ],
                "blockingRoomIds": sorted(blocked_room_ids),
            },
        )

    for room in to_remove:
        await RoomRepository.delete(str(room["id"]))


async def _auto_create_rooms(
    hotel_id: str, room_type_id: str, count: int, room_type_name: str
) -> None:
    """Create `count` Room records for a newly created room type.

    Room numbers are named "{room_type_name} N" so the calendar can show e.g.
    "#Garden King 1" instead of an opaque "#1". The starting suffix is one past
    the highest existing "{room_type_name} N" suffix in the hotel, keeping the
    unique (hotel_id, room_number) index satisfied even if the user re-creates
    a room type with the same name. Failures are logged but do not abort the
    request — the user can still add rooms manually if a default still clashes.
    """
    if count <= 0:
        return
    prefix = f"{room_type_name} "
    like_pattern = prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    max_num = (
        await Database.fetchval(
            """
        SELECT COALESCE(MAX(NULLIF(regexp_replace(room_number, '^.*[^0-9]', ''), '')::int), 0)
        FROM rooms
        WHERE hotel_id = $1 AND room_number LIKE $2 ESCAPE '\\'
        """,
            hotel_id,
            like_pattern,
        )
        or 0
    )
    for i in range(count):
        room_number = f"{prefix}{max_num + i + 1}"
        try:
            await RoomRepository.create(
                {
                    "hotel_id": hotel_id,
                    "room_type_id": room_type_id,
                    "room_number": room_number,
                    "floor": "",
                    "status": "available",
                    "sort_order": i,
                }
            )
        except Exception as e:
            logger.warning(
                "Failed to auto-create room %s for room_type %s: %s",
                room_number,
                room_type_id,
                e,
            )


@router.get("/room-types", response_model=list[RoomTypeAdminResponse])
async def list_room_types(user_id: str = Depends(require_hotel_admin)):
    hotel_id = await get_hotel_id(user_id)
    rooms = await RoomTypeRepository.list_by_hotel_id(hotel_id)
    return [_room_to_admin(r) for r in rooms]


@router.post("/room-types", response_model=RoomTypeAdminResponse, status_code=201)
async def create_room_type(
    data: RoomTypeCreate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    payload = data.model_dump()

    # Force the room currency to the hotel's authoritative currency so a
    # buggy or stale frontend payload can never create rooms with a
    # different currency than the property — see
    # memory/project_hotel_data_ownership.md.
    payload["currency"] = await get_be_currency(hotel_id)

    if payload.get("monthly_rates"):
        payload["monthly_rates"] = {
            k: v.model_dump(exclude_none=True)
            if hasattr(v, "model_dump")
            else {kk: vv for kk, vv in v.items() if vv is not None}
            for k, v in payload["monthly_rates"].items()
        }
    else:
        payload["monthly_rates"] = {}
    if not payload.get("daily_rates"):
        payload["daily_rates"] = {}
    room = await RoomTypeRepository.create(hotel_id, payload)
    await _auto_create_rooms(
        hotel_id,
        str(room["id"]),
        int(payload.get("total_rooms") or 0),
        room["name"],
    )
    await fixed_plan_billing.sync_subscription_price_for_hotel(hotel_id)
    return _room_to_admin(room)


@router.get("/room-types/{room_type_id}", response_model=RoomTypeAdminResponse)
async def get_room_type(
    room_type_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    room = await RoomTypeRepository.get_by_id(room_type_id)
    if not room or str(room["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Room type not found")
    return _room_to_admin(room)


@router.get("/room-types/{room_type_id}/resolved-rate")
async def get_room_type_resolved_rate(
    room_type_id: str,
    check_in: str = Query(..., description="Check-in date (YYYY-MM-DD)"),
    user_id: str = Depends(require_hotel_admin),
):
    """Return the nightly rate the booking engine would charge for the given
    room type and check-in date. Mirrors the resolution used by booking
    creation and the public booking engine so the PMS calendar's New Booking
    modal can pre-fill the same value the guest would have seen."""
    hotel_id = await get_hotel_id(user_id)
    room = await RoomTypeRepository.get_by_id(room_type_id)
    if not room or str(room["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Room type not found")
    try:
        check_in_date = date.fromisoformat(check_in)
    except ValueError as e:
        raise HTTPException(status_code=400, detail="check_in must be YYYY-MM-DD") from e
    nightly_rate, _ = RoomTypeRepository.resolve_rate(room, check_in_date)
    return {"nightlyRate": float(nightly_rate), "currency": room["currency"]}


@router.patch("/room-types/{room_type_id}", response_model=RoomTypeAdminResponse)
async def update_room_type(
    room_type_id: str,
    data: RoomTypeUpdate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    existing = await RoomTypeRepository.get_by_id(room_type_id)
    if not existing or str(existing["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Room type not found")

    updates = data.model_dump(exclude_unset=True)
    if {"flexible_cancellation_type", "partial_refund_tiers"} & updates.keys():
        cancellation_type = updates.get(
            "flexible_cancellation_type",
            existing.get("flexible_cancellation_type") or "free",
        )
        tiers = updates.get(
            "partial_refund_tiers",
            parse_jsonb(existing.get("partial_refund_tiers", [])),
        )
        if cancellation_type == "partial_refund" and not tiers:
            raise HTTPException(
                status_code=400,
                detail="Partial refund requires at least one refund tier",
            )
    # VAY-402 + VAY-406: total_rooms is a derived mirror of COUNT(rooms),
    # written only by the trg_sync_room_type_total_rooms trigger
    # (migration 074). The PATCH payload's total_rooms is treated as a
    # *desired count* — we reconcile the rooms (insert / delete) and let
    # the trigger update the column. That keeps the VAY-402 safety
    # invariant ("never higher than the real room count") while letting
    # the form change inventory in one save (the duplicate-and-shrink
    # flow from VAY-406).
    desired_total = updates.pop("total_rooms", None)
    if desired_total is not None:
        await _reconcile_rooms_to_total(
            hotel_id, room_type_id, int(desired_total), existing["name"]
        )
    if "monthly_rates" in updates and updates["monthly_rates"] is not None:
        updates["monthly_rates"] = {
            k: {kk: vv for kk, vv in v.items() if vv is not None}
            for k, v in updates["monthly_rates"].items()
        }
    room = await RoomTypeRepository.update(room_type_id, updates)

    # Auto-generated room numbers follow the room type name (e.g.
    # "Garden King 1"). When the name changes — common after the user
    # duplicates a type and renames the "(Copy)" — rewrite those numbers
    # so the calendar stops displaying the stale name. Manually-renamed
    # rooms are left alone (VAY-322).
    new_name = updates.get("name")
    if new_name is not None and new_name != existing["name"]:
        await RoomRepository.rename_auto_named(
            hotel_id,
            room_type_id,
            existing["name"],
            new_name,
        )
    # Even on a no-op save, sweep stale auto-names left over from a
    # rename that happened before the on-rename fix shipped (VAY-322).
    # A hotel admin re-saving the type — without changing anything — is
    # enough to repair the broken state.
    await RoomRepository.heal_stale_room_names(
        hotel_id,
        room_type_id,
        room["name"],
    )

    cancel_fields = {
        "flexible_cancellation_type",
        "partial_refund_cancel_window_days",
        "partial_refund_amount_percent",
        "partial_refund_tiers",
    }
    if cancel_fields & updates.keys():
        asyncio.create_task(push_cancellation_policy_for_room_type(hotel_id, room_type_id))

    # Meal plans drive which rate-plan variants exist on Channex
    # (e.g. "BDC Standard (Breakfast)"). Re-provision so newly added meal
    # codes spawn their rate plans, then push ARI so updated surcharges
    # propagate to OTAs.
    if "meal_plans" in updates:
        asyncio.create_task(_resync_channex_after_meal_plan_change(hotel_id))

    # Any rate-affecting save must propagate to OTAs immediately. Without
    # this, hotels would have to remember to click "Sync Availability &
    # Rates" on the Channel Manager page after every edit (VAY-391).
    # meal_plans flows through its own provision+push helper above, so
    # exclude it here to avoid a duplicate push.
    rate_affecting = _RATE_AFFECTING_FIELDS & updates.keys()
    if rate_affecting:
        asyncio.create_task(_push_ari_after_rate_change(hotel_id, sorted(rate_affecting)))

    if desired_total is not None or "is_active" in updates:
        await fixed_plan_billing.sync_subscription_price_for_hotel(hotel_id)

    return _room_to_admin(room)


# Fields that change what OTAs should see — a write to any of these has to
# trigger a Channex ARI push. Kept narrow on purpose: cosmetic fields like
# name/description don't belong here.
_RATE_AFFECTING_FIELDS = frozenset(
    {
        "base_rate",
        "non_refundable_rate",
        "non_refundable_enabled",
        "non_refundable_discount",
        "monthly_rates",
        "daily_rates",
        "operating_periods",
        "seasons",
        "weekend_surcharge",
        "minimum_advance_days",
    }
)


async def _push_ari_after_rate_change(hotel_id: str, changed_fields: list[str]) -> None:
    # Hotels without an active Channex connection should be silent no-ops
    # (per the VAY-391 "no Channel Manager connected" edge case).
    conn = await ChannexConnectionRepository.get_by_hotel_id(hotel_id)
    if not conn or not conn.get("is_active"):
        return
    try:
        await push_ari_for_hotel(hotel_id)
    except Exception:
        logger.exception(
            "Channex ARI push after rate change (%s) failed for hotel %s",
            ",".join(changed_fields),
            hotel_id,
        )


async def _resync_channex_after_meal_plan_change(hotel_id: str) -> None:
    try:
        await provision_property(hotel_id)
    except ValueError:
        return
    except Exception:
        logger.exception(
            "Channex re-provision after meal_plan change failed for hotel %s",
            hotel_id,
        )
        return
    try:
        await push_ari_for_hotel(hotel_id)
    except Exception:
        logger.exception(
            "Channex ARI push after meal_plan change failed for hotel %s",
            hotel_id,
        )


@router.post(
    "/room-types/{room_type_id}/duplicate", response_model=RoomTypeAdminResponse, status_code=201
)
async def duplicate_room_type(
    room_type_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    existing = await RoomTypeRepository.get_by_id(room_type_id)
    if not existing or str(existing["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Room type not found")

    clone_data = {
        "name": existing["name"] + " (Copy)",
        "category": existing.get("category", ""),
        "description": existing.get("description", ""),
        "short_description": existing.get("short_description", ""),
        "max_occupancy": existing["max_occupancy"],
        "max_adults": existing.get("max_adults"),
        "max_children": existing.get("max_children"),
        "bedrooms": existing.get("bedrooms", 1),
        "bathrooms": existing.get("bathrooms", 1),
        "size": existing["size"],
        "base_rate": float(existing["base_rate"]),
        "non_refundable_rate": float(existing["non_refundable_rate"])
        if existing.get("non_refundable_rate") is not None
        else None,
        "currency": existing["currency"],
        "address": existing.get("address") or "",
        "latitude": existing.get("latitude"),
        "longitude": existing.get("longitude"),
        "amenities": parse_jsonb(existing["amenities"]),
        "images": parse_jsonb(existing["images"]),
        "bed_type": existing["bed_type"],
        "features": parse_jsonb(existing["features"]),
        "benefits": parse_jsonb(existing.get("benefits", [])),
        "total_rooms": existing["total_rooms"],
        "is_active": existing["is_active"],
        "sort_order": existing["sort_order"],
        "monthly_rates": parse_jsonb(existing.get("monthly_rates", {})),
        "daily_rates": parse_jsonb(existing.get("daily_rates", {})),
        "operating_periods": parse_jsonb(existing.get("operating_periods", [])),
        "seasons": parse_jsonb(existing.get("seasons", [])),
        "weekend_surcharge": existing.get("weekend_surcharge") or "+0%",
        "cancellation_policy": existing.get("cancellation_policy") or "Free until 7 days before",
        "flexible_rate_enabled": existing.get("flexible_rate_enabled", True),
        "flexible_cancellation_type": existing.get("flexible_cancellation_type") or "free",
        "partial_refund_cancel_window_days": existing.get("partial_refund_cancel_window_days", 30),
        "partial_refund_amount_percent": existing.get("partial_refund_amount_percent", 50),
        "partial_refund_tiers": parse_jsonb(existing.get("partial_refund_tiers", [])),
        "non_refundable_discount": existing.get("non_refundable_discount", 5),
        "non_refundable_enabled": existing.get("non_refundable_enabled", False),
        "non_refundable_cancellation_policy": existing.get("non_refundable_cancellation_policy")
        or "Non-refundable from booking",
        "last_minute_discount": (lambda v: v if isinstance(v, dict) else None)(
            parse_jsonb(existing.get("last_minute_discount"))
        ),
        "rate_payment_methods": (lambda v: v if isinstance(v, dict) else None)(
            parse_jsonb(existing.get("rate_payment_methods"))
        ),
        "rate_deposit_settings": (lambda v: v if isinstance(v, dict) else None)(
            parse_jsonb(existing.get("rate_deposit_settings"))
        ),
        "meal_plans": parse_jsonb(existing.get("meal_plans", [])),
    }
    room = await RoomTypeRepository.create(hotel_id, clone_data)
    await _auto_create_rooms(
        hotel_id,
        str(room["id"]),
        int(clone_data.get("total_rooms") or 0),
        room["name"],
    )
    await fixed_plan_billing.sync_subscription_price_for_hotel(hotel_id)
    return _room_to_admin(room)


@router.delete("/room-types/{room_type_id}", status_code=204)
async def delete_room_type(
    room_type_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    existing = await RoomTypeRepository.get_by_id(room_type_id)
    if not existing or str(existing["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Room type not found")
    if await LinkedInventoryGroupRepository.list_member_ids_for_room_type(room_type_id):
        raise HTTPException(
            status_code=409,
            detail="Remove this room type from linked inventory before deleting it",
        )

    try:
        await RoomTypeRepository.delete(room_type_id)
    except asyncpg.ForeignKeyViolationError as e:
        raise HTTPException(
            status_code=409,
            detail="Cannot delete room type with existing bookings",
        ) from e
    except Exception as e:
        logger.exception("Unexpected error deleting room type %s", room_type_id)
        raise HTTPException(status_code=500, detail="Internal server error") from e
    await fixed_plan_billing.sync_subscription_price_for_hotel(hotel_id)
