import asyncio
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from app.dependencies import require_hotel_admin
from app.models.linked_inventory import (
    LinkedInventoryGroupResponse,
    LinkedInventoryGroupWrite,
)
from app.repositories.linked_inventory_group_repo import (
    LinkedInventoryConflict,
    LinkedInventoryGroupRepository,
)
from app.services.channex.orchestrator import push_ari_for_hotel
from app.utils import get_hotel_id

router = APIRouter(prefix="/admin/linked-inventory-groups", tags=["admin-linked-inventory"])


@router.get("", response_model=list[LinkedInventoryGroupResponse])
async def list_linked_inventory_groups(user_id: str = Depends(require_hotel_admin)):
    hotel_id = await get_hotel_id(user_id)
    return await LinkedInventoryGroupRepository.list_by_hotel_id(hotel_id)


@router.get("/unavailable-room-type-ids", response_model=list[str])
async def list_unavailable_linked_room_type_ids(
    check_in: date = Query(...),
    check_out: date = Query(...),
    user_id: str = Depends(require_hotel_admin),
):
    if check_out <= check_in:
        raise HTTPException(status_code=422, detail="Check-out must be after check-in")

    hotel_id = await get_hotel_id(user_id)
    unavailable: list[str] = []
    for group in await LinkedInventoryGroupRepository.list_by_hotel_id(hotel_id):
        member_ids = group["member_room_type_ids"]
        if await LinkedInventoryGroupRepository.has_activity(member_ids[0], check_in, check_out):
            unavailable.extend(member_ids)
    return unavailable


@router.post("", response_model=LinkedInventoryGroupResponse, status_code=201)
async def create_linked_inventory_group(
    data: LinkedInventoryGroupWrite,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    try:
        group = await LinkedInventoryGroupRepository.create(
            hotel_id, data.name.strip(), data.member_room_type_ids
        )
    except LinkedInventoryConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    asyncio.create_task(push_ari_for_hotel(hotel_id))
    return group


@router.put("/{group_id}", response_model=LinkedInventoryGroupResponse)
async def update_linked_inventory_group(
    group_id: str,
    data: LinkedInventoryGroupWrite,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    try:
        group = await LinkedInventoryGroupRepository.update(
            hotel_id, group_id, data.name.strip(), data.member_room_type_ids
        )
    except LinkedInventoryConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not group:
        raise HTTPException(status_code=404, detail="Linked inventory group not found")
    asyncio.create_task(push_ari_for_hotel(hotel_id))
    return group


@router.delete("/{group_id}", status_code=204)
async def delete_linked_inventory_group(
    group_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    if not await LinkedInventoryGroupRepository.delete(group_id, hotel_id):
        raise HTTPException(status_code=404, detail="Linked inventory group not found")
    asyncio.create_task(push_ari_for_hotel(hotel_id))
    return Response(status_code=204)
