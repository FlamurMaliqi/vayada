import asyncio
import logging
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException

from app.database import Database
from app.dependencies import require_hotel_admin
from app.models.room_block import RoomBlockCreate, RoomBlockResponse, RoomBlockUpdate
from app.repositories.linked_inventory_group_repo import LinkedInventoryGroupRepository
from app.repositories.room_block_repo import RoomBlockRepository
from app.repositories.room_repo import RoomRepository
from app.repositories.room_type_repo import RoomTypeRepository
from app.services.channex_sync_service import push_ari_for_room_type
from app.utils import get_hotel_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin-room-blocks"])


async def _check_block_availability(
    room_type_id: str,
    total_rooms: int,
    start_date: date,
    end_date: date,
    new_blocked_count: int,
    exclude_block_id: str = None,
) -> None:
    """Raise 400 if adding a block of new_blocked_count rooms on the given
    date range would cause total occupancy (bookings + blocks) to exceed
    total_rooms on any day."""
    current = start_date
    while current < end_date:
        next_day = current + timedelta(days=1)
        if await LinkedInventoryGroupRepository.has_activity(
            room_type_id,
            current,
            next_day,
            exclude_block_id=exclude_block_id,
        ):
            raise HTTPException(
                status_code=409,
                detail=f"Linked inventory is already stopped on {current.isoformat()}",
            )
        booked = await RoomTypeRepository.count_booked(room_type_id, current, next_day)
        # Sum blocks overlapping this day, optionally excluding one block (for updates)
        if exclude_block_id:
            blocked = (
                await Database.fetchval(
                    """
                SELECT COALESCE(SUM(blocked_count), 0) FROM room_blocks
                WHERE room_type_id = $1 AND start_date < $3 AND end_date > $2 AND id <> $4
                """,
                    room_type_id,
                    current,
                    next_day,
                    exclude_block_id,
                )
                or 0
            )
        else:
            blocked = await RoomTypeRepository.count_blocked(room_type_id, current, next_day)
        if booked + blocked + new_blocked_count > total_rooms:
            raise HTTPException(
                status_code=400,
                detail=f"Not enough availability on {current.isoformat()}: {booked} booked, {blocked} blocked, {total_rooms} total. Cannot block {new_blocked_count} more room(s).",
            )
        current = next_day


@router.post("/room-blocks", response_model=list[RoomBlockResponse], status_code=201)
async def create_room_block(
    data: RoomBlockCreate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)

    # Validate room type belongs to hotel
    room_type = await RoomTypeRepository.get_by_id(data.room_type_id)
    if not room_type or str(room_type["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Room type not found")

    if data.end_date <= data.start_date:
        raise HTTPException(status_code=400, detail="end_date must be after start_date")

    room_ids = list(dict.fromkeys(data.room_ids))  # dedupe, preserve order
    if len(room_ids) > room_type["total_rooms"]:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot block more than {room_type['total_rooms']} rooms for this type",
        )

    # Validate each room belongs to this room type
    rooms_by_id: dict[str, dict] = {}
    for rid in room_ids:
        room = await RoomRepository.get_by_id(rid)
        if (
            not room
            or str(room["hotel_id"]) != hotel_id
            or str(room["room_type_id"]) != data.room_type_id
        ):
            raise HTTPException(
                status_code=400,
                detail=f"Room {rid} does not belong to the selected room type",
            )
        rooms_by_id[rid] = room

    # Aggregate availability (bookings + existing blocks + this block) vs total
    await _check_block_availability(
        data.room_type_id,
        room_type["total_rooms"],
        data.start_date,
        data.end_date,
        len(room_ids),
    )

    # Per-room conflict: a specific room can't already have an overlapping block
    for rid in room_ids:
        conflict = await RoomBlockRepository.find_room_conflict(rid, data.start_date, data.end_date)
        if conflict:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Room #{rooms_by_id[rid]['room_number']} is already blocked "
                    f"from {conflict['start_date']} to {conflict['end_date']}"
                ),
            )

    created: list[dict] = []
    for rid in room_ids:
        block = await RoomBlockRepository.create(
            {
                "hotel_id": hotel_id,
                "room_type_id": data.room_type_id,
                "room_id": rid,
                "start_date": data.start_date,
                "end_date": data.end_date,
                "blocked_count": 1,
                "reason": data.reason,
            }
        )
        created.append(block)

    # Push updated availability + rate-plan restrictions to Channex (once for the whole range).
    asyncio.create_task(
        push_ari_for_room_type(
            hotel_id,
            data.room_type_id,
            start_date=data.start_date,
            end_date=data.end_date,
        )
    )

    return [
        RoomBlockResponse(
            id=str(block["id"]),
            room_type_id=str(block["room_type_id"]),
            room_id=str(block["room_id"]) if block.get("room_id") else None,
            room_number=rooms_by_id[str(block["room_id"])]["room_number"]
            if block.get("room_id")
            else None,
            start_date=str(block["start_date"]),
            end_date=str(block["end_date"]),
            blocked_count=block["blocked_count"],
            reason=block["reason"],
            created_at=block["created_at"].isoformat(),
        )
        for block in created
    ]


@router.patch("/room-blocks/{block_id}", response_model=RoomBlockResponse)
async def update_room_block(
    block_id: str,
    data: RoomBlockUpdate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    block = await RoomBlockRepository.get_by_id(block_id)
    if not block or str(block["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Room block not found")

    updates = data.model_dump(exclude_unset=True)

    new_start = updates.get("start_date", block["start_date"])
    new_end = updates.get("end_date", block["end_date"])
    if new_end <= new_start:
        raise HTTPException(status_code=400, detail="end_date must be after start_date")

    room_type = await RoomTypeRepository.get_by_id(str(block["room_type_id"]))
    if room_type:
        await _check_block_availability(
            str(block["room_type_id"]),
            room_type["total_rooms"],
            new_start,
            new_end,
            block["blocked_count"],
            exclude_block_id=block_id,
        )

    # For per-room blocks, also ensure the new date range doesn't collide with
    # another block on the same room
    if block.get("room_id"):
        conflict = await RoomBlockRepository.find_room_conflict(
            str(block["room_id"]),
            new_start,
            new_end,
            exclude_block_id=block_id,
        )
        if conflict:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"This room is already blocked "
                    f"from {conflict['start_date']} to {conflict['end_date']}"
                ),
            )

    updated = await RoomBlockRepository.update(block_id, updates)

    room_number = None
    if updated.get("room_id"):
        room_row = await RoomRepository.get_by_id(str(updated["room_id"]))
        room_number = room_row["room_number"] if room_row else None

    # Push updated availability + rate-plan restrictions to Channex — cover union of old and new date ranges.
    sync_start = min(block["start_date"], new_start)
    sync_end = max(block["end_date"], new_end)
    asyncio.create_task(
        push_ari_for_room_type(
            hotel_id,
            str(block["room_type_id"]),
            start_date=sync_start,
            end_date=sync_end,
        )
    )

    return RoomBlockResponse(
        id=str(updated["id"]),
        room_type_id=str(updated["room_type_id"]),
        room_id=str(updated["room_id"]) if updated.get("room_id") else None,
        room_number=room_number,
        start_date=str(updated["start_date"]),
        end_date=str(updated["end_date"]),
        blocked_count=updated["blocked_count"],
        reason=updated["reason"],
        created_at=updated["created_at"].isoformat(),
    )


@router.delete("/room-blocks/{block_id}", status_code=204)
async def delete_room_block(
    block_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    block = await RoomBlockRepository.get_by_id(block_id)
    if not block or str(block["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Room block not found")
    await RoomBlockRepository.delete(block_id)

    # Push updated availability + rate-plan restrictions to Channex.
    asyncio.create_task(
        push_ari_for_room_type(
            hotel_id,
            str(block["room_type_id"]),
            start_date=block["start_date"],
            end_date=block["end_date"],
        )
    )
